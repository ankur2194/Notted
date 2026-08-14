// Part 55 — version snapshot persistence service.
//
// This service is the transaction-scoped seam that writes one immutable
// `note_versions` row representing the ACCEPTED POST-SAVE STATE of a note, and
// the read path the future Part 56 history UI (and the integration tests) use
// to retrieve ordered history. It is deliberately narrow:
//
// ACCEPTED-POST-SAVE SEMANTICS (decision 1). Each row captures the note state
// AT `note_versions.version` — i.e. the post-update accepted state, NOT the
// displaced pre-update state. `created_by_id` is the editor whose mutation
// produced that exact state. This matches the seed (versions 1–3 where v3 is
// current) and the restore/history expectation that selecting version N shows
// the note as it was after the edit that created version N.
//
// IMMUTABILITY (decision 6). `note_versions` rows are append-only. This
// service exposes NO update path: every method either inserts one row or
// reads. Retention (Part 55) is the only thing that ever DELETEs, and it lives
// in the maintenance module so a snapshot write path can never accidentally
// mutate history.
//
// NON-MISLEADING-SNAPSHOT RULE (decision 4). The caller decides WHEN to
// checkpoint; this service records whatever accepted state it is handed.
// `NotesService` calls `recordAcceptedState` only from `create`/`copy`/`update`
// (see `note-version-checkpoint.policy.ts` for the eligibility rule). The
// future Part 58 collaborative pipeline reuses this same seam after
// `decideCollaborativeCheckpoint` returns `checkpoint: true`.
//
// TENANT ISOLATION. `note_versions` has no `workspace_id` column (it is a
// polymorphic child of `notes` per the Part 19 workspace-scope note), so:
//   - `recordAcceptedState` validates the supplied `workspaceId` against the
//     ACTIVE server-side tenant context before insert (a caller can never
//     substitute a client-supplied workspace), then joins the parent note by
//     BOTH id and workspace in the same transaction before inserting.
// Future history reads must likewise join through `notes.workspace_id`; Part 56
// owns that authorized read surface rather than exposing an early convenience API.

import { Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";

import { notes, noteVersions } from "../database/schema";
import { assertActiveWorkspace, TenantContextService } from "../tenant";
import { tenantWorkspaceMismatch } from "../tenant/tenant-errors";

import type { DatabaseTransaction } from "../database/database.service";

/** Inputs to {@link NoteVersionsService.recordAcceptedState}. */
export interface RecordAcceptedStateInput {
  readonly noteId: string;
  /**
   * The workspace the note belongs to. Validated against the active tenant
   * context before insert so a caller cannot substitute a client-supplied id.
   */
  readonly workspaceId: string;
  /** The `notes.version` value this snapshot captures (post-update accepted). */
  readonly version: number;
  readonly title: string;
  /** TipTap JSON projection snapshot (ADR 0004). Typed as the persisted shape. */
  readonly content: unknown;
  readonly contentPlain: string;
  /** User whose mutation produced this accepted state. */
  readonly createdById: string;
}

@Injectable()
export class NoteVersionsService {
  constructor(private readonly tenantContext: TenantContextService) {}

  /**
   * Write one immutable snapshot of the accepted post-save state of a note,
   * inside the caller's transaction. The caller MUST pass the same transaction
   * it is using for its business mutation so the snapshot commits atomically
   * with that mutation (and rolls back with it on failure). A failed snapshot
   * insert therefore never leaves a half-written note or an orphan snapshot.
   *
   * The `(note_id, version)` unique index makes a duplicate accepted state for
   * the same version a constraint violation — exactly the "no two snapshots for
   * one accepted version" guarantee. There is intentionally no upsert: a
   * duplicate is a caller bug (writing the same version twice) and should
   * surface as a transaction rollback rather than a silent overwrite.
   */
  async recordAcceptedState(
    tx: DatabaseTransaction,
    input: RecordAcceptedStateInput,
  ): Promise<void> {
    assertActiveWorkspace(input.workspaceId, this.tenantContext, "note_versions");
    // note_versions has no workspace_id, so validating only the supplied
    // workspace would still permit a cross-tenant note UUID. Prove the parent
    // belongs to the active workspace in this same transaction before insert.
    const parent = await tx
      .select({ id: notes.id })
      .from(notes)
      .where(and(eq(notes.id, input.noteId), eq(notes.workspaceId, input.workspaceId)))
      .limit(1);
    if (parent.length !== 1) throw tenantWorkspaceMismatch("note_versions.note_id");
    await tx.insert(noteVersions).values({
      noteId: input.noteId,
      version: input.version,
      title: input.title,
      content: input.content,
      contentPlain: input.contentPlain,
      createdById: input.createdById,
    });
  }
}
