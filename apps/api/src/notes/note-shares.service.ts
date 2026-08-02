import { createHash, randomUUID } from "node:crypto";

import { HttpStatus, Injectable } from "@nestjs/common";
import { and, asc, eq } from "drizzle-orm";

import { AuthorizationEntryService } from "../authorization/authorization-entry.service";
import { ApiHttpException } from "../common/errors/api-http.exception";
import { DatabaseService, type DatabaseTransaction } from "../database/database.service";
import {
  auditLogs,
  jobOutbox,
  noteShares,
  notes,
  workspaceMembers,
  type JobOutboxPayload,
} from "../database/schema";
import { activeWorkspaceId, TenantContextService, whereWorkspace } from "../tenant";

import {
  NOTE_AUDIT_ENTITY_TYPE,
  NOTE_DOMAIN_EVENT_IDEMPOTENCY_PREFIX,
  NOTE_DOMAIN_EVENT_PAYLOAD_VERSION,
  NOTE_DOMAIN_EVENT_QUEUE,
  NOTE_SHARE_DOMAIN_EVENTS,
} from "./notes.constants";

import type {
  AuthenticatedPrincipal,
  NoteShareDeleteResult,
  NoteShareGrant,
  NoteShareList,
  NoteShareMutationPermission,
  NoteShareUpsertResult,
} from "@notted/shared-types";

interface ShareScope {
  readonly principal: AuthenticatedPrincipal;
  readonly workspaceId: string;
  readonly noteId: string;
  readonly requestId?: string | null;
}

interface ShareTarget extends ShareScope {
  readonly userId: string;
}

interface ShareRow {
  readonly id: string;
  readonly noteId: string;
  readonly userId: string;
  readonly permission: "view" | "comment" | "edit";
  readonly createdAt: Date;
}

@Injectable()
export class NoteSharesService {
  constructor(
    private readonly database: DatabaseService,
    private readonly authorizationEntry: AuthorizationEntryService,
    private readonly tenantContext: TenantContextService,
  ) {}

  async list(input: ShareScope): Promise<NoteShareList> {
    const operation = await this.authorizeManagement(input);
    return this.authorizationEntry.run(operation, async () => {
      const rows = await this.database.db
        .select(this.selection())
        .from(noteShares)
        .innerJoin(notes, eq(notes.id, noteShares.noteId))
        .where(and(eq(noteShares.noteId, input.noteId), whereWorkspace(notes, this.tenantContext)))
        .orderBy(asc(noteShares.createdAt), asc(noteShares.id))
        .limit(1_001);
      const items = rows.slice(0, 1_000).map((row) => this.toGrant(row));
      return Object.freeze({
        items: Object.freeze(items),
        limit: 1_000,
        returned: items.length,
        truncated: rows.length > 1_000,
      });
    });
  }

  async upsert(
    input: ShareTarget & { readonly permission: NoteShareMutationPermission },
  ): Promise<NoteShareUpsertResult> {
    if (input.userId === input.principal.userId) this.selfGrantDenied();
    const operation = await this.authorizationEntry.authorizeUser({
      principal: input.principal,
      workspaceId: input.workspaceId,
      action: "note.share",
      resource: {
        kind: "note",
        id: input.noteId,
        delegation: {
          targetUserId: input.userId,
          requestedPermission: input.permission,
        },
      },
      requestId: input.requestId,
    });
    return this.authorizationEntry.run(operation, async () => {
      const row = await this.database.transaction(async (tx) => {
        const now = new Date();
        const [targetMembership] = await tx
          .select({ id: workspaceMembers.id })
          .from(workspaceMembers)
          .where(
            and(
              eq(workspaceMembers.userId, input.userId),
              whereWorkspace(workspaceMembers, this.tenantContext),
            ),
          )
          .limit(1)
          .for("update");
        const [liveNote] = await tx
          .select({ id: notes.id })
          .from(notes)
          .where(and(eq(notes.id, input.noteId), whereWorkspace(notes, this.tenantContext)))
          .limit(1)
          .for("update");
        if (targetMembership === undefined || liveNote === undefined) this.notFound();
        const [share] = await tx
          .insert(noteShares)
          .values({
            noteId: input.noteId,
            userId: input.userId,
            permission: input.permission,
            createdById: input.principal.userId,
            createdAt: now,
          })
          .onConflictDoUpdate({
            target: [noteShares.noteId, noteShares.userId],
            set: {
              permission: input.permission,
              createdById: input.principal.userId,
              createdAt: now,
            },
          })
          .returning(this.selection());
        if (share === undefined) this.notFound();
        await this.recordMutation(tx, NOTE_SHARE_DOMAIN_EVENTS.upsert, share.id, input);
        return share;
      });
      return Object.freeze({ share: Object.freeze(this.toGrant(row)) });
    });
  }

  async revoke(input: ShareTarget): Promise<NoteShareDeleteResult> {
    const operation = await this.authorizeManagement(input);
    return this.authorizationEntry.run(operation, async () => {
      await this.database.transaction(async (tx) => {
        const [existing] = await tx
          .select({ id: noteShares.id })
          .from(noteShares)
          .innerJoin(notes, eq(notes.id, noteShares.noteId))
          .where(
            and(
              eq(noteShares.noteId, input.noteId),
              eq(noteShares.userId, input.userId),
              whereWorkspace(notes, this.tenantContext),
            ),
          )
          .limit(1);
        if (existing === undefined) this.notFound();
        const deleted = await tx
          .delete(noteShares)
          .where(and(eq(noteShares.id, existing.id), eq(noteShares.noteId, input.noteId)))
          .returning({ id: noteShares.id });
        if (deleted.length !== 1) this.notFound();
        await this.recordMutation(tx, NOTE_SHARE_DOMAIN_EVENTS.revoke, existing.id, input);
      });
      return Object.freeze({ noteId: input.noteId, userId: input.userId, revoked: true as const });
    });
  }

  private authorizeManagement(input: ShareScope) {
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
    action: "note.share.upserted" | "note.share.revoked",
    shareId: string,
    input: ShareScope,
  ): Promise<void> {
    const workspaceId = activeWorkspaceId(this.tenantContext);
    await tx.insert(auditLogs).values({
      workspaceId,
      userId: input.principal.userId,
      action,
      entityType: NOTE_AUDIT_ENTITY_TYPE,
      entityId: input.noteId,
      metadata: {},
      requestId: input.requestId ?? null,
    });
    const intentId = randomUUID();
    const payload: JobOutboxPayload = Object.freeze({
      action,
      intentId,
      workspaceId,
      resourceIds: Object.freeze([input.noteId, shareId]),
      actorId: input.principal.userId,
    });
    await tx.insert(jobOutbox).values({
      id: intentId,
      workspaceId,
      queueName: NOTE_DOMAIN_EVENT_QUEUE,
      jobType: action,
      payloadVersion: NOTE_DOMAIN_EVENT_PAYLOAD_VERSION,
      payload,
      payloadHash: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
      idempotencyKey: `${NOTE_DOMAIN_EVENT_IDEMPOTENCY_PREFIX}${action}:${shareId}:${intentId}`,
      correlationId: input.requestId ?? null,
    });
  }

  private selection() {
    return {
      id: noteShares.id,
      noteId: noteShares.noteId,
      userId: noteShares.userId,
      permission: noteShares.permission,
      createdAt: noteShares.createdAt,
    };
  }

  private toGrant(row: ShareRow): NoteShareGrant {
    return {
      id: row.id,
      noteId: row.noteId,
      userId: row.userId,
      permission: row.permission,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private selfGrantDenied(): never {
    throw new ApiHttpException(HttpStatus.BAD_REQUEST, {
      code: "NOTE_SHARE_SELF_DENIED",
      message: "You cannot grant note access to yourself.",
    });
  }

  private notFound(): never {
    throw new ApiHttpException(HttpStatus.NOT_FOUND, {
      code: "NOT_FOUND",
      message: "The requested resource was not found.",
    });
  }
}
