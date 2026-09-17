import { Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";

import { recordAudit } from "../audit/audit-record";
import { AuthorizationEntryService } from "../authorization/authorization-entry.service";
import { ApiHttpException } from "../common/errors/api-http.exception";
import { StructuredLogger } from "../common/logging/structured-logger.service";
import { APP_CONFIG, type AppConfig } from "../config/app.config";
import { AUTH_CONFIG, type AuthConfig } from "../config/auth.config";
import { SECURITY_CONFIG, type SecurityConfig } from "../config/security.config";
import { DatabaseService, type DatabaseTransaction } from "../database/database.service";
import { notePublicLinks, notes } from "../database/schema";
import { activeWorkspaceId, TenantContextService, whereWorkspace } from "../tenant";

import { generatePublicLinkToken, hashPublicLinkToken } from "./note-public-link-token";
import {
  decryptPublicLinkToken,
  encryptPublicLinkToken,
} from "./note-public-link-token-encryption";
import { NOTE_AUDIT_ENTITY_TYPE } from "./notes.constants";

import type {
  AuthenticatedPrincipal,
  NotePublicLinkCreateResult,
  NotePublicLinkRevokeResult,
  NotePublicLinkStatus,
} from "@notted/shared-types";

interface LinkScope {
  readonly principal: AuthenticatedPrincipal;
  readonly workspaceId: string;
  readonly noteId: string;
  readonly requestId?: string | null;
}

/**
 * Authenticated management service for a note's public share link, the
 * pattern-mirror of `NoteSharesService`. Unlike the unauthenticated public
 * GET (Task 5), every method here runs inside the tenant-scoped path and
 * authorizes under `note.update` — a public link is a property of the note,
 * not a per-recipient grant like `note.share`.
 */
@Injectable()
export class NotePublicLinksService {
  constructor(
    private readonly database: DatabaseService,
    private readonly authorizationEntry: AuthorizationEntryService,
    private readonly tenantContext: TenantContextService,
    @Inject(AUTH_CONFIG) private readonly authConfig: AuthConfig,
    @Inject(APP_CONFIG) private readonly appConfig: AppConfig,
    @Inject(SECURITY_CONFIG) private readonly securityConfig: SecurityConfig,
    private readonly logger: StructuredLogger,
  ) {}

  async status(input: LinkScope): Promise<NotePublicLinkStatus> {
    const operation = await this.authorize(input);
    return this.authorizationEntry.run(operation, async () => {
      const [row] = await this.database.db
        .select({
          createdAt: notePublicLinks.createdAt,
          encryptedToken: notePublicLinks.encryptedToken,
          encryptionKeyVersion: notePublicLinks.encryptionKeyVersion,
        })
        .from(notePublicLinks)
        .innerJoin(notes, eq(notes.id, notePublicLinks.noteId))
        .where(
          and(eq(notePublicLinks.noteId, input.noteId), whereWorkspace(notes, this.tenantContext)),
        )
        .limit(1);
      return Object.freeze({
        enabled: row !== undefined,
        createdAt: row === undefined ? null : row.createdAt.toISOString(),
        url: row === undefined ? null : this.decryptUrl(input.noteId, row),
      });
    });
  }

  /** Regenerate semantics: deletes any existing link and inserts a fresh one
   * in the same transaction, so a previously issued token stops working the
   * moment a new one is created. */
  async create(input: LinkScope): Promise<NotePublicLinkCreateResult> {
    const operation = await this.authorize(input);
    return this.authorizationEntry.run(operation, async () => {
      const raw = generatePublicLinkToken();
      const tokenHash = hashPublicLinkToken(raw, this.authConfig.secret);
      const { encryptedToken, encryptionKeyVersion } = encryptPublicLinkToken(
        this.securityConfig,
        input.noteId,
        raw,
      );
      await this.database.transaction(async (tx) => {
        const [liveNote] = await tx
          .select({ id: notes.id })
          .from(notes)
          .where(
            and(
              eq(notes.id, input.noteId),
              eq(notes.isDeleted, false),
              whereWorkspace(notes, this.tenantContext),
            ),
          )
          .limit(1)
          .for("update");
        if (liveNote === undefined) this.notFound();
        await tx.delete(notePublicLinks).where(eq(notePublicLinks.noteId, input.noteId));
        await tx.insert(notePublicLinks).values({
          noteId: input.noteId,
          workspaceId: activeWorkspaceId(this.tenantContext),
          tokenHash,
          encryptedToken,
          encryptionKeyVersion,
          createdById: input.principal.userId,
        });
        await this.recordMutation(tx, "note.publicLink.created", input);
      });
      return Object.freeze({ url: this.buildUrl(raw) });
    });
  }

  /** Idempotent: revoking a link that does not exist is a no-op, not a 404 —
   * "no public link" is the resting state, not an error. */
  async revoke(input: LinkScope): Promise<NotePublicLinkRevokeResult> {
    const operation = await this.authorize(input);
    return this.authorizationEntry.run(operation, async () => {
      await this.database.transaction(async (tx) => {
        const deleted = await tx
          .delete(notePublicLinks)
          .where(
            and(
              eq(notePublicLinks.noteId, input.noteId),
              eq(notePublicLinks.workspaceId, activeWorkspaceId(this.tenantContext)),
            ),
          )
          .returning({ id: notePublicLinks.id });
        if (deleted.length > 0) await this.recordMutation(tx, "note.publicLink.revoked", input);
      });
      return Object.freeze({ noteId: input.noteId, revoked: true as const });
    });
  }

  private authorize(input: LinkScope) {
    return this.authorizationEntry.authorizeUser({
      principal: input.principal,
      workspaceId: input.workspaceId,
      action: "note.update",
      resource: { kind: "note", id: input.noteId },
      requestId: input.requestId,
    });
  }

  private async recordMutation(
    tx: DatabaseTransaction,
    action: "note.publicLink.created" | "note.publicLink.revoked",
    input: LinkScope,
  ): Promise<void> {
    await recordAudit(tx, {
      workspaceId: activeWorkspaceId(this.tenantContext),
      userId: input.principal.userId,
      action,
      entityType: NOTE_AUDIT_ENTITY_TYPE,
      entityId: input.noteId,
      requestId: input.requestId ?? null,
    });
  }

  private buildUrl(rawToken: string): string {
    return new URL(`/p/${rawToken}`, this.appConfig.appUrl).toString();
  }

  /**
   * `null` rather than a thrown error, for two distinct reasons:
   *
   * - `encryptedToken`/`encryptionKeyVersion` are `null` for a link row
   *   written before this pair of columns existed — there was never anything
   *   to decrypt, and that is expected, not a failure. No log, no exception.
   * - A decrypt genuinely fails (an operator dropped a key version from
   *   `DATA_ENCRYPTION_KEYS` before every row under it was re-encrypted).
   *   Recoverable by restoring the key, not by the caller retrying, so this
   *   only logs and degrades rather than throwing and failing the whole
   *   status read.
   *
   * Either way, a link the owner already has still shows as "enabled" with
   * no copyable URL, prompting a regenerate.
   */
  private decryptUrl(
    noteId: string,
    row: { readonly encryptedToken: string | null; readonly encryptionKeyVersion: number | null },
  ): string | null {
    if (row.encryptedToken === null || row.encryptionKeyVersion === null) return null;
    try {
      return this.buildUrl(
        decryptPublicLinkToken(
          this.securityConfig,
          noteId,
          row.encryptedToken,
          row.encryptionKeyVersion,
        ),
      );
    } catch {
      this.logger.warn("Public link token is unreadable; status served without a URL");
      return null;
    }
  }

  private notFound(): never {
    throw new ApiHttpException(404, {
      code: "NOT_FOUND",
      message: "The requested resource was not found.",
    });
  }
}
