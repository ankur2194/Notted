// Part 64 — the AUTHORIZED bundle read behind the `zip` export.
//
// WHY THIS EXISTS AT ALL. Every other export format is a pure function of the
// note body the worker already loaded. `zip` is not: it bundles attachments,
// comments and version snapshots, each of which is a separate row set that a
// queue worker may not simply `SELECT` because it feels like it. This service is
// the ONE place that read happens, and it happens behind ONE authorization.
//
// WHY IT DOES NOT CALL `AttachmentsService` / `CommentsService` / `NotesService`.
// Every public method on those services takes an `AuthenticatedPrincipal`
// (`{ userId, sessionId, expiresAt, … }`) because they are request-shaped. A
// queue worker HAS NO SESSION. The only way to reuse them would be to fabricate
// a principal — to write down, as a fact, a session that does not exist and an
// assurance nobody proved. That is a lie in the one place the system is supposed
// to be honest, and `authorizeUserJob` exists precisely so a job does not have to
// tell it: it re-checks live membership and live resource facts for a bare
// `userId`. So the rows are read here, through Drizzle, INSIDE the authorized
// operation, workspace- AND note-scoped on every single statement (ADR 0009).
// If you are reading this because you want to "clean it up" by constructing a
// principal: don't. Add a principal-free method to those services instead.
//
// WHY ONE `note.read` COVERS ALL THREE ROW SETS. That is the existing contract,
// not a new one. `CommentsService.list` authorizes `note.read` on the note to
// return its comment thread, and `AttachmentsService.listForNote` says it in as
// many words: "Listing a note's attachments is exactly 'read this note'".
// Version snapshots are the same note at an earlier moment. A second, different
// action here would mean the zip export enforced a rule the interactive UI does
// not — a difference nobody could keep true for long.
//
// OBJECT KEYS ARE NEVER AUTHORITY (ADR 0005). A key is read FROM the authorized
// attachment row and is only ever handed to `getObjectStream`. Nothing here ever
// derives a permission, a workspace or a note from a key. `readObject` is
// therefore blind on purpose: it takes the key its caller was already allowed to
// have and reports only "bytes" or "no bytes".
//
// LOGGING: identifiers, an outcome and an error CLASS, mirroring
// `export.worker.service.ts`. Never a filename, never a key, never content.

import { Inject, Injectable } from "@nestjs/common";
import { and, asc, desc, eq } from "drizzle-orm";

import { attachmentObjectKeys } from "../attachments/attachment-object-keys";
import { AuthorizationEntryService } from "../authorization/authorization-entry.service";
import { StructuredLogger } from "../common/logging/structured-logger.service";
import { DatabaseService } from "../database/database.service";
import { attachments, comments, noteVersions, notes, users } from "../database/schema";
import {
  ObjectStorageService,
  type ObjectStore,
} from "../infrastructure/minio/object-storage.service";
import { TenantContextService, whereWorkspace } from "../tenant";

import type { ExportSourceSubject } from "./export-renderers";
import type { ExportOptions } from "@notted/shared-types";
import type { Readable } from "node:stream";

/**
 * SQL-level row ceilings. These are NOT the archive's bounds — `zip.ts` owns
 * those — they exist so a pathological note can never pull an unbounded row set
 * into worker memory before anything gets a chance to say no. They sit at or
 * above the archive's own caps so the archive, not the query, is what a user
 * sees enforced.
 */
const MAX_ATTACHMENT_ROWS = 200;
const MAX_COMMENT_ROWS = 1_000;
const MAX_VERSION_ROWS = 100;

export interface ExportBundleAttachment {
  readonly attachmentId: string;
  /** Display filename from the authorized row. Untrusted text. */
  readonly filename: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  /** Storage address read FROM THE AUTHORIZED ROW. Never authority. `null` when the row owns no readable object. */
  readonly objectKey: string | null;
}

export interface ExportBundleComment {
  readonly id: string;
  readonly parentId: string | null;
  readonly authorName: string;
  readonly content: string;
  readonly isResolved: boolean;
  readonly createdAt: string;
}

export interface ExportBundleVersion {
  readonly versionId: string;
  readonly version: number;
  readonly createdAt: string;
  readonly createdByName: string;
  /** Untrusted persisted TipTap JSON for that version. */
  readonly content: unknown;
}

export interface ExportBundle {
  readonly attachments: readonly ExportBundleAttachment[];
  readonly comments: readonly ExportBundleComment[];
  readonly versions: readonly ExportBundleVersion[];
}

const EMPTY_BUNDLE_LIST = Object.freeze([]);

@Injectable()
export class NoteExportSourceService {
  constructor(
    private readonly database: DatabaseService,
    private readonly authorization: AuthorizationEntryService,
    private readonly tenantContext: TenantContextService,
    // Same provider as everywhere else, typed as the narrow `ObjectStore` port
    // so the unit suite can substitute an in-memory double.
    @Inject(ObjectStorageService) private readonly objects: ObjectStore,
    private readonly logger: StructuredLogger,
  ) {}

  /**
   * ONE authorized read. Returns only what `options` asked for; the others are
   * empty arrays — and when a flag is off, no statement is issued at all, which
   * is the cheap version of "the export cannot leak what it was not asked for".
   *
   * A denial propagates. Turning it into a clean job failure is the WORKER's
   * job (it owns the `exports` row and the `source_forbidden` code); swallowing
   * it here would produce a silently empty bundle, which is the one outcome a
   * user could not distinguish from "this note has no attachments".
   */
  async load(subject: ExportSourceSubject, options: ExportOptions): Promise<ExportBundle> {
    const operation = await this.authorization.authorizeUserJob({
      userId: subject.requestedById,
      workspaceId: subject.workspaceId,
      action: "note.read",
      resource: { kind: "note", id: subject.noteId },
      correlationId: subject.correlationId,
    });

    return this.authorization.run(operation, async () => {
      const bundle: ExportBundle = {
        attachments: options.includeAttachments
          ? await this.readAttachments(subject.noteId)
          : EMPTY_BUNDLE_LIST,
        comments: options.includeComments
          ? await this.readComments(subject.noteId)
          : EMPTY_BUNDLE_LIST,
        versions: options.includeVersionHistory
          ? await this.readVersions(subject.noteId)
          : EMPTY_BUNDLE_LIST,
      };
      this.logger.info(
        {
          workspaceId: subject.workspaceId,
          noteId: subject.noteId,
          requestedById: subject.requestedById,
          outcome: "loaded",
          attachmentCount: bundle.attachments.length,
          commentCount: bundle.comments.length,
          versionCount: bundle.versions.length,
        },
        "Export bundle loaded",
      );
      return Object.freeze(bundle);
    });
  }

  /**
   * Bounded read of ONE attachment object.
   *
   * `null` for absent, unreadable, storage-disabled, or larger than `maxBytes`.
   * It NEVER throws: a missing object is an ordinary consequence of a
   * reconciliation sweep or a half-finished upload, and losing an entire export
   * because one attachment's bytes went missing is a far worse outcome than
   * shipping the archive with that one file recorded as skipped.
   *
   * It also STOPS at `maxBytes` rather than buffering first and measuring after
   * — the whole point of a cap is that the oversized object never occupies the
   * memory it was supposed to be denied.
   */
  async readObject(objectKey: string, maxBytes: number): Promise<Buffer | null> {
    let stream: Readable;
    try {
      stream = await this.objects.getObjectStream("attachments", objectKey);
    } catch (error: unknown) {
      this.readFailed(error, "object_unavailable");
      return null;
    }

    const chunks: Buffer[] = [];
    let total = 0;
    try {
      for await (const chunk of stream) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        total += buffer.byteLength;
        if (total > maxBytes) {
          stream.destroy();
          this.readFailed(null, "object_oversized");
          return null;
        }
        chunks.push(buffer);
      }
    } catch (error: unknown) {
      stream.destroy();
      this.readFailed(error, "object_unavailable");
      return null;
    }
    return Buffer.concat(chunks);
  }

  /**
   * ONLY `ready` rows. `pending`/`processing` rows are a reservation whose bytes
   * may not exist or may not be validated yet, and `failed` rows are the ones
   * cleanup is coming for. `attachments` itself has no `is_deleted` column:
   * `AttachmentsService.delete` HARD-deletes the row (the objects follow after
   * commit), so a deleted attachment is simply absent from this result.
   *
   * The PARENT note's `is_deleted` is honoured, exactly as `readComments` and
   * `readVersions` do it. Today the worker already refuses a deleted source with
   * `source_unavailable` before reaching here, so the guard is unreachable — it
   * is present so the three sibling reads are symmetric and the next caller of
   * this method does not have to know about that upstream check.
   */
  private async readAttachments(noteId: string): Promise<readonly ExportBundleAttachment[]> {
    const rows = await this.database.db
      .select({
        id: attachments.id,
        filename: attachments.filename,
        mimeType: attachments.mimeType,
        sizeBytes: attachments.sizeBytes,
        storageKey: attachments.storageKey,
        variants: attachments.variants,
      })
      .from(attachments)
      // The note join exists only to carry `is_deleted`. `attachments` has its
      // own `workspace_id`, so the tenant predicate stays on the child row.
      .innerJoin(notes, eq(notes.id, attachments.noteId))
      .where(
        and(
          eq(attachments.noteId, noteId),
          eq(attachments.processingStatus, "ready"),
          eq(notes.isDeleted, false),
          whereWorkspace(attachments, this.tenantContext),
        ),
      )
      .orderBy(asc(attachments.createdAt), asc(attachments.id))
      .limit(MAX_ATTACHMENT_ROWS);

    return Object.freeze(
      rows.map((row) =>
        Object.freeze({
          attachmentId: row.id,
          filename: row.filename,
          mimeType: row.mimeType,
          sizeBytes: row.sizeBytes,
          // `attachmentObjectKeys` is the ONE answer to "which objects does this
          // row own" (Part 45) and its first key is the original. Re-deriving a
          // key here would be a second implementation that silently drifts the
          // day a variant name changes.
          objectKey: attachmentObjectKeys(row.variants, row.storageKey)[0] ?? null,
        }),
      ),
    );
  }

  /**
   * `comments` has NO `workspace_id` column — it is a child of `notes` — so the
   * tenant predicate lands on the joined note, exactly as `CommentsService` does
   * it. The note's `is_deleted` is checked here too: a note in the trash has no
   * business contributing a comment thread to an archive.
   */
  private async readComments(noteId: string): Promise<readonly ExportBundleComment[]> {
    const rows = await this.database.db
      .select({
        id: comments.id,
        parentId: comments.parentId,
        content: comments.content,
        isResolved: comments.isResolved,
        createdAt: comments.createdAt,
        authorName: users.name,
      })
      .from(comments)
      .innerJoin(notes, eq(notes.id, comments.noteId))
      .innerJoin(users, eq(users.id, comments.createdById))
      .where(
        and(
          eq(comments.noteId, noteId),
          eq(notes.isDeleted, false),
          whereWorkspace(notes, this.tenantContext),
        ),
      )
      .orderBy(asc(comments.createdAt), asc(comments.id))
      .limit(MAX_COMMENT_ROWS);

    return Object.freeze(
      rows.map((row) =>
        Object.freeze({
          id: row.id,
          parentId: row.parentId,
          authorName: row.authorName,
          content: row.content,
          isResolved: row.isResolved,
          createdAt: row.createdAt.toISOString(),
        }),
      ),
    );
  }

  /** Newest first: a truncated history should keep the versions closest to now. */
  private async readVersions(noteId: string): Promise<readonly ExportBundleVersion[]> {
    const rows = await this.database.db
      .select({
        id: noteVersions.id,
        version: noteVersions.version,
        content: noteVersions.content,
        createdAt: noteVersions.createdAt,
        createdByName: users.name,
      })
      .from(noteVersions)
      .innerJoin(notes, eq(notes.id, noteVersions.noteId))
      .innerJoin(users, eq(users.id, noteVersions.createdById))
      .where(
        and(
          eq(noteVersions.noteId, noteId),
          eq(notes.isDeleted, false),
          whereWorkspace(notes, this.tenantContext),
        ),
      )
      .orderBy(desc(noteVersions.version))
      .limit(MAX_VERSION_ROWS);

    return Object.freeze(
      rows.map((row) =>
        Object.freeze({
          versionId: row.id,
          version: row.version,
          createdAt: row.createdAt.toISOString(),
          createdByName: row.createdByName,
          content: row.content,
        }),
      ),
    );
  }

  /**
   * An outcome and an error CLASS. No key, no filename, no byte count that could
   * fingerprint the object, no message — a storage client's error text routinely
   * quotes the key it failed on, and a log line is persistence just like a
   * mailbox is (`docs/standards/observability.md`, ADR 0005).
   */
  private readFailed(error: unknown, outcome: "object_unavailable" | "object_oversized"): void {
    this.logger.warning(
      { outcome, errorClass: error instanceof Error ? error.name : "none" },
      "Export bundle could not read an attachment object",
    );
  }
}
