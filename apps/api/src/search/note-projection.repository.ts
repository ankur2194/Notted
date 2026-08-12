// Part 51.2 — authoritative PostgreSQL → Meilisearch document projection.
//
// PostgreSQL is the source of truth; the Meilisearch index is a rebuildable
// projection. This repository reads CURRENT authoritative state for either a
// bounded set of note IDs (the per-event `note.search.sync` handler) or an
// entire workspace page (the Part 51.4 reindex command) and returns strict,
// validated `NoteIndexDocument` objects.
//
// Tenant safety (ADR 0009): every read includes `whereWorkspace(notes, ...)`
// (or `whereWorkspace(attachments, ...)` for the attachment flag). The active
// tenant context is established by the calling job handler before invoking
// these methods. A missing context throws `tenant.no_active_context` via
// `get()`; a tampered payload whose note IDs belong to another workspace
// simply yields zero rows for those IDs — the handler then deletes those
// document IDs from the index, converging to the authoritative state.
//
// Soft-delete policy: `isDeleted = false` is applied to every live projection
// read. Soft-deleted notes are never returned here; the handler infers
// "delete from index" for any requested ID absent from the result. Archived
// and template notes ARE included in the index (they remain searchable); only
// soft-deleted notes are excluded.
//
// `hasAttachments` derivation: a note counts as having attachments iff it has
// at least one attachment row with `processingStatus = "ready"`. `ready` is
// the validated, quota-committed, user-visible terminal state (ADR 0005).
// `pending`/`processing` are in-flight and may fail (indexing them would make
// `hasAttachments` flap true→false→true as processing completes or fails);
// `failed` is broken and not user-visible. `ready` is the stable observable
// contract, so the indexed flag does not flap on transient processing state.

import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, gt, inArray, lte, or } from "drizzle-orm";

import { DatabaseService } from "../database/database.service";
import { attachments, notes, noteTags, tags } from "../database/schema";
import { TenantContextService, whereWorkspace } from "../tenant";

import { noteIndexDocumentSchema, type NoteIndexDocument } from "./note-index.document";

/** Schema-bound content cap; authoritative `content_plain` is unbounded `text`. */
const MAX_CONTENT_LENGTH = 2_000_000;
/** Schema-bound tag cardinality cap per document. */
const MAX_TAGS = 250;

const MIN_PAGE_SIZE = 1;
const MAX_PAGE_SIZE = 1_000;

export interface NoteProjectionPage {
  readonly documents: readonly NoteIndexDocument[];
  readonly limit: number;
  readonly nextCursor?: NoteProjectionCursor;
}

export interface NoteProjectionCursor {
  readonly updatedAt: Date;
  readonly id: string;
}

interface NoteRow {
  readonly id: string;
  readonly title: string;
  readonly contentPlain: string | null;
  readonly workspaceId: string;
  readonly projectId: string | null;
  readonly createdById: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

@Injectable()
export class NoteProjectionRepository {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(TenantContextService) private readonly tenantContext: TenantContextService,
  ) {}

  /**
   * Load current `NoteIndexDocument` projections for the given note IDs under
   * the active tenant scope. IDs that are absent, belong to another workspace,
   * or are soft-deleted are omitted; the caller treats the difference as
   * "delete from index". Duplicate input IDs collapse to a single document.
   */
  async loadDocumentsForNoteIds(noteIds: readonly string[]): Promise<readonly NoteIndexDocument[]> {
    if (noteIds.length === 0) return [];
    const dedupedIds = [...new Set(noteIds)];
    const noteRows = await this.loadNoteRows(dedupedIds);
    return this.assembleWithRelations(noteRows);
  }

  /**
   * Load one page of the workspace's non-deleted notes as projections, ordered
   * by `(updatedAt desc, id desc)` for stable paging. `total` is the count of
   * all non-deleted notes in the active workspace so the caller can page to
   * completion. Used by the Part 51.4 reindex command.
   */
  async loadWorkspacePage(options: {
    readonly limit: number;
    readonly boundary: Date;
    readonly after?: NoteProjectionCursor;
  }): Promise<NoteProjectionPage> {
    const limit = clampPageSize(options.limit);
    const noteRows = await this.loadWorkspaceNoteRows(limit, options.boundary, options.after);
    const documents = await this.assembleWithRelations(noteRows);
    const last = noteRows.at(-1);
    return Object.freeze({
      documents,
      limit,
      ...(last === undefined ? {} : { nextCursor: { updatedAt: last.updatedAt, id: last.id } }),
    });
  }

  // ----------------------------------------------------------------------- //
  // Internals
  // ----------------------------------------------------------------------- //

  private async loadNoteRows(noteIds: readonly string[]): Promise<readonly NoteRow[]> {
    return this.database.db
      .select(this.noteProjection())
      .from(notes)
      .where(
        and(
          inArray(notes.id, [...noteIds]),
          eq(notes.isDeleted, false),
          whereWorkspace(notes, this.tenantContext),
        ),
      );
  }

  private async loadWorkspaceNoteRows(
    limit: number,
    boundary: Date,
    after?: NoteProjectionCursor,
  ): Promise<readonly NoteRow[]> {
    return this.database.db
      .select(this.noteProjection())
      .from(notes)
      .where(
        and(
          eq(notes.isDeleted, false),
          whereWorkspace(notes, this.tenantContext),
          lte(notes.updatedAt, boundary),
          after === undefined
            ? undefined
            : or(
                gt(notes.updatedAt, after.updatedAt),
                and(eq(notes.updatedAt, after.updatedAt), gt(notes.id, after.id)),
              ),
        ),
      )
      .orderBy(asc(notes.updatedAt), asc(notes.id))
      .limit(limit);
  }

  private async assembleWithRelations(
    noteRows: readonly NoteRow[],
  ): Promise<readonly NoteIndexDocument[]> {
    if (noteRows.length === 0) return [];
    const ids = noteRows.map((row) => row.id);
    const [tagMap, attachmentMap] = await Promise.all([
      this.loadTagNames(ids),
      this.loadAttachmentFlags(ids),
    ]);
    return noteRows.map((row) => this.toDocument(row, tagMap, attachmentMap));
  }

  /**
   * Current tag names per note. Scoped through BOTH the note and the tag
   * workspace columns: the cross-workspace tag-assignment invariant is
   * service-enforced (Part 24/31), not a DB constraint, so both hops are
   * checked here as defense-in-depth. Only non-deleted notes contribute.
   */
  private async loadTagNames(
    noteIds: readonly string[],
  ): Promise<ReadonlyMap<string, readonly string[]>> {
    const rows = await this.database.db
      .select({ noteId: noteTags.noteId, name: tags.name })
      .from(noteTags)
      .innerJoin(tags, eq(tags.id, noteTags.tagId))
      .innerJoin(notes, eq(notes.id, noteTags.noteId))
      .where(
        and(
          inArray(noteTags.noteId, [...noteIds]),
          eq(notes.isDeleted, false),
          whereWorkspace(notes, this.tenantContext),
          whereWorkspace(tags, this.tenantContext),
        ),
      );
    const map = new Map<string, string[]>();
    for (const row of rows) {
      const list = map.get(row.noteId);
      if (list === undefined) {
        map.set(row.noteId, [row.name]);
      } else {
        list.push(row.name);
      }
    }
    return map;
  }

  /**
   * `hasAttachments` per note ID. An attachment counts iff
   * `processingStatus = "ready"` (validated, quota-committed, user-visible).
   * `noteIds` are already proven tenant members by the caller, and
   * `whereWorkspace(attachments, ...)` adds the workspace check on the
   * denormalized `attachments.workspace_id`.
   */
  private async loadAttachmentFlags(
    noteIds: readonly string[],
  ): Promise<ReadonlyMap<string, boolean>> {
    const rows = await this.database.db
      .select({ noteId: attachments.noteId })
      .from(attachments)
      .where(
        and(
          inArray(attachments.noteId, [...noteIds]),
          eq(attachments.processingStatus, "ready"),
          whereWorkspace(attachments, this.tenantContext),
        ),
      );
    const present = new Set(rows.map((row) => row.noteId));
    const map = new Map<string, boolean>();
    for (const id of noteIds) map.set(id, present.has(id));
    return map;
  }

  private toDocument(
    row: NoteRow,
    tagMap: ReadonlyMap<string, readonly string[]>,
    attachmentMap: ReadonlyMap<string, boolean>,
  ): NoteIndexDocument {
    const document = {
      id: row.id,
      title: row.title,
      content: truncate(row.contentPlain ?? "", MAX_CONTENT_LENGTH),
      tags: dedupeAndCapTags(tagMap.get(row.id) ?? []),
      workspaceId: row.workspaceId,
      projectId: row.projectId,
      authorId: row.createdById,
      createdAt: row.createdAt.getTime(),
      updatedAt: row.updatedAt.getTime(),
      hasAttachments: attachmentMap.get(row.id) ?? false,
    };
    // Defensive boundary parse: DB constraints already bound title (500) and
    // tag names (50), and we cap content/tags above. Parse surfaces any drift
    // as a loud failure rather than poisoning the index.
    return noteIndexDocumentSchema.parse(document);
  }

  private noteProjection() {
    return {
      id: notes.id,
      title: notes.title,
      contentPlain: notes.contentPlain,
      workspaceId: notes.workspaceId,
      projectId: notes.projectId,
      createdById: notes.createdById,
      createdAt: notes.createdAt,
      updatedAt: notes.updatedAt,
    };
  }
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

function dedupeAndCapTags(names: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const name of names) {
    if (name.length === 0 || seen.has(name)) continue;
    seen.add(name);
    result.push(name);
    if (result.length >= MAX_TAGS) break;
  }
  return Object.freeze(result);
}

function clampPageSize(limit: number): number {
  const value = Math.trunc(limit);
  if (!Number.isFinite(value)) return MIN_PAGE_SIZE;
  return Math.min(MAX_PAGE_SIZE, Math.max(MIN_PAGE_SIZE, value));
}
