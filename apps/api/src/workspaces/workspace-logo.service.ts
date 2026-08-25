// Part 72 — the workspace branding logo.
//
// WHY A DEDICATED ROUTE AND NOT AN `attachments` ROW. An attachment belongs to a
// note, is authorized as `file.read` against that note, and is served privately
// to a signed-in member. A workspace logo is the opposite of all three: it has
// no note, it is workspace branding rather than workspace content, and its
// single most important consumer is an `<img src>` inside an EMAIL CLIENT, which
// carries no session cookie and cannot follow a login redirect. Reusing the
// attachment pipeline would have meant either an attachment with a null note or
// a public hole punched through `file.read` — both worse than one small route.
//
// WHY THE GET IS PUBLIC AND WHY THAT IS SAFE. The URL is unguessable: a 128-bit
// random token chosen at upload time is BOTH the object-key suffix and the path
// segment, and it is compared in constant time against the token recorded in
// `workspaces.logo_url`. Deleting or replacing the logo mints a new token, so an
// old URL stops resolving. The only thing the URL discloses is the image an
// administrator deliberately published as the workspace's public face — the same
// bytes every invitation email already carries to unauthenticated recipients.
//
// WHY NO MIGRATION. `workspaces.logo_url` has existed since Part 18 and has
// always been "a URL the branding renderers may use". This part fills it with an
// app-relative path this API serves, instead of an external URL nobody could
// upload. No column, no table, no backfill.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";

import {
  IMAGE_PROCESSOR,
  ImageProcessingError,
  type ImageProcessor,
} from "../attachments/image-processing";
import { sniffImageMediaType } from "../attachments/image-signature";
import { recordAudit } from "../audit/audit-record";
import { AuthorizationEntryService } from "../authorization/authorization-entry.service";
import { ApiHttpException } from "../common/errors/api-http.exception";
import { DatabaseService } from "../database/database.service";
import { workspaces } from "../database/schema";
import {
  ObjectStorageDisabledError,
  ObjectStorageService,
  type ObjectStore,
} from "../infrastructure/minio/object-storage.service";
import { TenantContextService, whereWorkspaceId } from "../tenant";

import { WORKSPACE_AUDIT_ACTIONS, WORKSPACE_AUDIT_ENTITY_TYPE } from "./workspaces.constants";

import type { AuthenticatedPrincipal, WorkspaceLogoResult } from "@notted/shared-types";
import type { Readable } from "node:stream";

/**
 * 2 MiB. Far below the 15 MiB image ceiling on purpose: this is a wordmark, it
 * is re-encoded to a 200 px WebP before it is stored, and the raw upload only
 * has to be good enough to derive that. The parser enforces it during transfer,
 * so a lying `Content-Length` cannot get past it.
 */
export const WORKSPACE_LOGO_MAX_BYTES = 2 * 1_024 * 1_024;

/** The multipart part name the browser must use. */
export const WORKSPACE_LOGO_FILE_FIELD = "file";

/** 16 random bytes, hex. Both the object-key suffix and the URL path segment. */
const LOGO_TOKEN_BYTES = 16;
const LOGO_TOKEN_PATTERN = /^[0-9a-f]{32}$/u;

/** Every stored logo is a WebP: `ImageProcessingService` re-encodes it. */
const LOGO_MIME_TYPE = "image/webp";
const LOGO_OBJECT_EXTENSION = ".webp";
const LOGO_BUCKET = "attachments" as const;

/**
 * Immutable and PUBLICLY cacheable — unlike an attachment's `private` block.
 * The token changes on every replacement, so a shared cache can never serve a
 * stale or superseded logo, and there is no principal for the entry to be
 * specific to.
 */
export const WORKSPACE_LOGO_CACHE_CONTROL = "public, max-age=31536000, immutable";

export function newWorkspaceLogoToken(): string {
  return randomBytes(LOGO_TOKEN_BYTES).toString("hex");
}

/** `workspaces/<workspaceId>/logo/<token>.webp` in the `attachments` bucket. */
export function workspaceLogoObjectKey(workspaceId: string, token: string): string {
  return `workspaces/${workspaceId}/logo/${token}${LOGO_OBJECT_EXTENSION}`;
}

/** The app-relative value persisted in `workspaces.logo_url`. */
export function workspaceLogoUrl(workspaceId: string, token: string): string {
  return `/api/v1/workspaces/${workspaceId}/logo/${token}`;
}

/**
 * Recover `{ workspaceId, token }` from a stored `logo_url`, or `null` if the
 * column holds anything else — an external URL written before this part, a
 * truncated string, a different workspace's path.
 *
 * The workspace id is checked against the caller's, so a row that somehow named
 * a foreign workspace could not be used to reach that workspace's bytes.
 */
export function parseWorkspaceLogoUrl(
  logoUrl: string | null,
  workspaceId: string,
): { readonly workspaceId: string; readonly token: string } | null {
  if (logoUrl === null) return null;
  const match = /^\/api\/v1\/workspaces\/([0-9a-f-]{36})\/logo\/([0-9a-f]{32})$/u.exec(logoUrl);
  if (match === null) return null;
  const [, owner, token] = match;
  if (owner === undefined || token === undefined || owner !== workspaceId) return null;
  return Object.freeze({ workspaceId: owner, token });
}

/**
 * Constant-time token comparison. Both operands are fixed-length lowercase hex
 * by construction (the pattern is checked first), so the length check leaks
 * nothing a malformed request did not already announce.
 */
function tokenMatches(candidate: string, expected: string): boolean {
  if (!LOGO_TOKEN_PATTERN.test(candidate) || candidate.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(candidate, "utf8"), Buffer.from(expected, "utf8"));
}

export interface WorkspaceLogoUploadInput {
  readonly principal: AuthenticatedPrincipal;
  readonly workspaceId: string;
  readonly buffer: Buffer;
  readonly requestId: string | null;
}

export interface WorkspaceLogoMutationInput {
  readonly principal: AuthenticatedPrincipal;
  readonly workspaceId: string;
  readonly requestId: string | null;
}

/** What the public GET route needs to write a response. */
export interface WorkspaceLogoContent {
  readonly stream: Readable;
  readonly etag: string;
  readonly contentLength: number;
  readonly mimeType: string;
}

@Injectable()
export class WorkspaceLogoService {
  constructor(
    private readonly database: DatabaseService,
    private readonly authorizationEntry: AuthorizationEntryService,
    private readonly tenantContext: TenantContextService,
    // The SAME two seams `AttachmentsService` depends on, for the same reason:
    // this service's logic is about tenancy, authorization and transactions, and
    // must be testable without pulling a native image decoder into the process.
    // The concrete Sharp-backed processor is bound to `IMAGE_PROCESSOR` in
    // `attachments.module.ts` — the one place it is ever named.
    @Inject(IMAGE_PROCESSOR) private readonly images: ImageProcessor,
    @Inject(ObjectStorageService) private readonly objects: ObjectStore,
  ) {}

  /**
   * Replace the workspace's logo.
   *
   * ORDER IS DELIBERATE: decode and re-encode first, then PUT the new object,
   * then commit the row. A failure before the PUT leaves nothing behind; a
   * failure after it leaves one unreferenced object, which is strictly better
   * than a row pointing at bytes that were never written. The previous object is
   * removed only AFTER the row commits, and a failure there is swallowed — an
   * orphaned old rendition is a storage cost, not a correctness problem, and
   * Part 45's reconciliation sweep is what collects it.
   */
  async upload(input: WorkspaceLogoUploadInput): Promise<WorkspaceLogoResult> {
    const operation = await this.authorizationEntry.authorizeUser({
      principal: input.principal,
      workspaceId: input.workspaceId,
      action: "settings.update",
      resource: { kind: "settings" },
      requestId: input.requestId,
    });
    return this.authorizationEntry.run(operation, async () => {
      // The sniffed type is authoritative (ADR 0005); the declared multipart
      // `Content-Type` and the filename are never consulted.
      const sniffed = sniffImageMediaType(input.buffer);
      if (sniffed === null || !this.images.supports(sniffed)) {
        throw new ApiHttpException(HttpStatus.UNSUPPORTED_MEDIA_TYPE, {
          code: "UNSUPPORTED_MEDIA_TYPE",
          message: "The logo must be a PNG, JPEG, GIF, WebP, SVG, or HEIC image.",
        });
      }

      let body: Buffer;
      try {
        const processed = await this.images.process({ buffer: input.buffer, sniffed });
        // `thumbnail` (200 px WebP) is the rendition this surface wants — a
        // sidebar mark and an email header. `medium` is the fallback only
        // because a source smaller than the thumbnail bound can legitimately
        // produce one and not the other on some inputs.
        const rendition =
          processed.objects.find((object) => object.variant === "thumbnail") ??
          processed.objects.find((object) => object.variant === "medium");
        if (rendition === undefined) {
          throw new ApiHttpException(HttpStatus.UNPROCESSABLE_ENTITY, {
            code: "UNPROCESSABLE_ENTITY",
            message: "The image could not be converted into a logo rendition.",
          });
        }
        body = rendition.body;
      } catch (error: unknown) {
        if (error instanceof ImageProcessingError) {
          // The specific reason stays in-process; only a stable refusal is
          // returned, exactly as the attachment pipeline does.
          throw new ApiHttpException(HttpStatus.UNPROCESSABLE_ENTITY, {
            code: "UNPROCESSABLE_ENTITY",
            message: "The image could not be processed.",
          });
        }
        throw error;
      }

      const token = newWorkspaceLogoToken();
      const key = workspaceLogoObjectKey(input.workspaceId, token);
      await this.withStorage(() =>
        this.objects.putObject(LOGO_BUCKET, key, body, {
          contentType: LOGO_MIME_TYPE,
          contentLength: body.byteLength,
          cacheControl: WORKSPACE_LOGO_CACHE_CONTROL,
        }),
      );

      const logoUrl = workspaceLogoUrl(input.workspaceId, token);
      const previousKey = await this.database.transaction(async (tx) => {
        const [existing] = await tx
          .select({ id: workspaces.id, logoUrl: workspaces.logoUrl })
          .from(workspaces)
          .where(whereWorkspaceId(workspaces, this.tenantContext))
          .limit(1);
        if (existing === undefined) return this.notFound();
        await tx
          .update(workspaces)
          .set({ logoUrl, updatedAt: new Date() })
          .where(
            and(eq(workspaces.id, existing.id), whereWorkspaceId(workspaces, this.tenantContext)),
          );
        await recordAudit(tx, {
          workspaceId: existing.id,
          userId: input.principal.userId,
          action: WORKSPACE_AUDIT_ACTIONS.logoUpdate,
          entityType: WORKSPACE_AUDIT_ENTITY_TYPE,
          entityId: existing.id,
          // Sizes and the source format only; `bytes` is the size actually
          // kept, not the size uploaded.
          //
          // The object TOKEN is deliberately absent. It is the bearer capability
          // for a PUBLIC url, and `audit_logs` is exportable to CSV by every
          // workspace admin — Part 71's `redactAuditMetadata` blanks any key
          // ending in `token` precisely to stop that, and it is right to. The
          // row's workspace, actor and timestamp already answer "who replaced
          // the logo, and when", which is the question an auditor asks.
          metadata: { bytes: body.byteLength, sourceType: sniffed },
          requestId: input.requestId,
        });
        const previous = parseWorkspaceLogoUrl(existing.logoUrl, existing.id);
        return previous === null ? null : workspaceLogoObjectKey(existing.id, previous.token);
      });

      if (previousKey !== null && previousKey !== key) await this.discard(previousKey);
      return Object.freeze({ logoUrl });
    });
  }

  /** Clear the logo. Idempotent: removing an absent logo is a success, not a 404. */
  async remove(input: WorkspaceLogoMutationInput): Promise<WorkspaceLogoResult> {
    const operation = await this.authorizationEntry.authorizeUser({
      principal: input.principal,
      workspaceId: input.workspaceId,
      action: "settings.update",
      resource: { kind: "settings" },
      requestId: input.requestId,
    });
    return this.authorizationEntry.run(operation, async () => {
      const previousKey = await this.database.transaction(async (tx) => {
        const [existing] = await tx
          .select({ id: workspaces.id, logoUrl: workspaces.logoUrl })
          .from(workspaces)
          .where(whereWorkspaceId(workspaces, this.tenantContext))
          .limit(1);
        if (existing === undefined) return this.notFound();
        if (existing.logoUrl === null) return null;
        await tx
          .update(workspaces)
          .set({ logoUrl: null, updatedAt: new Date() })
          .where(
            and(eq(workspaces.id, existing.id), whereWorkspaceId(workspaces, this.tenantContext)),
          );
        const previous = parseWorkspaceLogoUrl(existing.logoUrl, existing.id);
        await recordAudit(tx, {
          workspaceId: existing.id,
          userId: input.principal.userId,
          action: WORKSPACE_AUDIT_ACTIONS.logoDelete,
          entityType: WORKSPACE_AUDIT_ENTITY_TYPE,
          entityId: existing.id,
          // Empty for the same reason `logoUpdate` omits the token: the row's
          // workspace, actor and timestamp are the audit fact, and the token is
          // a capability that must not reach an exportable log.
          metadata: {},
          requestId: input.requestId,
        });
        return previous === null ? null : workspaceLogoObjectKey(existing.id, previous.token);
      });

      if (previousKey !== null) await this.discard(previousKey);
      return Object.freeze({ logoUrl: null });
    });
  }

  /**
   * Serve the published logo. NO PRINCIPAL and no tenant context — this is the
   * one deliberately public read in the workspace surface, and the token is the
   * whole authorization. Every miss (unknown workspace, no logo, superseded
   * token, absent object) answers with the SAME 404, so the route cannot be used
   * to probe which workspaces exist or which have branding.
   */
  async read(workspaceId: string, token: string): Promise<WorkspaceLogoContent> {
    if (!LOGO_TOKEN_PATTERN.test(token)) this.notFound();
    const [row] = await this.database.db
      .select({ id: workspaces.id, logoUrl: workspaces.logoUrl })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1);
    if (row === undefined) this.notFound();
    const stored = parseWorkspaceLogoUrl(row.logoUrl, row.id);
    if (stored === null || !tokenMatches(token, stored.token)) this.notFound();

    const key = workspaceLogoObjectKey(row.id, stored.token);
    const stat = await this.withStorage(() => this.objects.statObject(LOGO_BUCKET, key));
    if (stat === null) this.notFound();
    const stream = await this.withStorage(() => this.objects.getObjectStream(LOGO_BUCKET, key));
    return Object.freeze({
      stream,
      // MinIO's ETag is the object's own; falling back to a key hash keeps the
      // conditional-GET path working against a store that omits one.
      etag: `"${stat.etag === "" ? createHash("sha256").update(key).digest("hex") : stat.etag}"`,
      contentLength: stat.size,
      mimeType: LOGO_MIME_TYPE,
    });
  }

  /**
   * Best-effort removal of a superseded object. Deliberately swallowing: the row
   * is already correct, the object is unreachable (its token is gone), and
   * failing the caller's request over a leftover byte range would be worse than
   * leaving one for Part 45's orphan sweep.
   */
  private async discard(key: string): Promise<void> {
    try {
      await this.objects.removeObject(LOGO_BUCKET, key);
    } catch {
      // ponytail: no retry and no dead-letter — the orphaned-object sweep in
      // `storage-maintenance.service.ts` already scans this bucket by prefix.
      // Upgrade path is to emit a `job_outbox` cleanup intent if orphan volume
      // ever becomes measurable.
    }
  }

  /** Turns "object storage is not configured" into a stable 503; nothing else. */
  private async withStorage<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error: unknown) {
      if (error instanceof ObjectStorageDisabledError) {
        throw new ApiHttpException(HttpStatus.SERVICE_UNAVAILABLE, {
          code: "SERVICE_UNAVAILABLE",
          message: "Logo storage is unavailable.",
        });
      }
      throw error;
    }
  }

  private notFound(): never {
    throw new ApiHttpException(HttpStatus.NOT_FOUND, {
      code: "NOT_FOUND",
      message: "The requested resource was not found.",
    });
  }
}
