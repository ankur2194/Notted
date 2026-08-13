// Part 52.2 — authoritative PostgreSQL reads for search-result authorization.
//
// The Meilisearch workspace filter is necessary but NOT sufficient: every
// candidate must be re-checked against current PostgreSQL state AND the
// `note.read` access rule (restricted projects per ADR 0011, viewer/editor
// read, note shares). This repository batches those reads under the active
// tenant context established by `AuthorizationHttpInterceptor` after
// `workspace.read` was authorized.
//
// What this repository returns per candidate id:
//   - authoritative note facts (title, projectId, authorId, createdAt,
//     updatedAt, isArchived, isTemplate, isPinned, isDeleted)
//   - per-note accessibility for the current user (`accessible`)
//   - author display name and project title (nullable) for labeling
//
// What this repository does NOT do:
//   - it does not run policy.decide() per note (the rule is small and
//     factored as `AuthorizationPolicyService.canReadNote`)
//   - it does not log note content or titles
//   - it does not mutate state
//
// Tenant safety: every read uses `whereWorkspace(notes, tenantContext)`. The
// active context is the one established after `workspace.read` was authorized
// for the route, so the workspace id is server-side proven.

import { Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";

import { AuthorizationPolicyService } from "../authorization/authorization-policy.service";
import { DatabaseService } from "../database/database.service";
import { attachments, notes, projectAccess, projects, users } from "../database/schema";
import { TenantContextService, whereWorkspace } from "../tenant";

import type { ProjectAccessRole, WorkspaceRole } from "../authorization/authorization.contracts";

/**
 * Maximum union authorized in one batch: two independently bounded hybrid
 * sources of 200 candidates each. Full-text remains bounded to 200.
 */
const MAX_CANDIDATES = 400;

interface NoteRow {
  readonly id: string;
  readonly title: string;
  readonly projectId: string | null;
  readonly createdById: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly isArchived: boolean;
  readonly isTemplate: boolean;
  readonly isPinned: boolean;
  readonly isDeleted: boolean;
}

interface ProjectFactsRow {
  readonly id: string;
  readonly isRestricted: boolean;
}

/**
 * Authoritative facts for a single candidate. `accessible` is the
 * `note.read` decision for the current user (NOT broadened by note share —
 * see `AuthorizationPolicyService.canReadNote` and the search service's
 * optional share extension). `hasAttachments` is re-read from the
 * authoritative `attachments` table (Decision #4), never from index state.
 */
export interface NoteSearchFact {
  readonly noteId: string;
  readonly title: string;
  readonly projectId: string | null;
  readonly createdById: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly isArchived: boolean;
  readonly isTemplate: boolean;
  readonly isPinned: boolean;
  readonly hasAttachments: boolean;
  readonly accessible: boolean;
  readonly authorName: string | null;
  readonly projectTitle: string | null;
}

/**
 * Authoritative PostgreSQL reads for search-result authorization. Stateless
 * aside from the injected DB handle and tenant context.
 *
 * `membershipRole` is required because the `note.read` decision depends on
 * workspace role (owner/admin are always allowed).
 */
export interface SearchResultAuthorizationInput {
  readonly userId: string;
  readonly membershipRole: WorkspaceRole;
  /**
   * Backward-compatible input accepted from early Part 52 test fixtures. It is
   * intentionally ignored: search must apply the canonical `note.read` policy,
   * which never lets a direct note share bypass a restricted project.
   */
  readonly shareGrantsReadOnRestrictedProject?: boolean;
}

@Injectable()
export class SearchResultRepository {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    private readonly policy: AuthorizationPolicyService,
    @Inject(TenantContextService) private readonly tenantContext: TenantContextService,
  ) {}

  /**
   * Load authoritative facts and accessibility for the given candidate note
   * IDs. Returns a map keyed by noteId. Candidates that are absent, soft
   * deleted, in another workspace (impossible under tenant scope but
   * defense-in-depth), or currently inaccessible to the user are omitted.
   */
  async loadFacts(
    candidateIds: readonly string[],
    input: SearchResultAuthorizationInput,
  ): Promise<ReadonlyMap<string, NoteSearchFact>> {
    if (candidateIds.length === 0) return new Map();
    const uniqueIds = [...new Set(candidateIds)].slice(0, MAX_CANDIDATES);

    const noteRows = await this.loadNoteRows(uniqueIds);
    if (noteRows.length === 0) return new Map();

    const projectIds = uniq(
      noteRows.map((row) => row.projectId).filter((id): id is string => id !== null),
    );
    const authorIds = uniq(noteRows.map((row) => row.createdById));

    const [projectFactsMap, projectAccessMap, authorMap, projectTitleMap, attachmentMap] =
      await Promise.all([
        this.loadProjectFacts(projectIds),
        this.loadProjectAccess(projectIds, input.userId),
        this.loadAuthors(authorIds),
        this.loadProjectTitles(projectIds),
        this.loadAttachmentFlags(uniqueIds),
      ]);

    const facts = new Map<string, NoteSearchFact>();
    for (const row of noteRows) {
      // Defense-in-depth: the tenant-scoped query already excludes soft
      // deletes; we re-check here in case a future caller passes un-scoped
      // rows. The publicly visible `accessible` value uses only the
      // `note.read` rule, not the soft-delete state (soft-deleted rows are
      // omitted from the map entirely).
      if (row.isDeleted) continue;
      // Standalone notes (projectId === null) have no project restriction;
      // pass `null` to canReadNote so the policy returns allow (matches the
      // `projectCanRead` rule: `project === null → true`). Restricted-project
      // notes build a non-null project facts object; a missing projectFacts
      // row (project was deleted between index and PostgreSQL) is treated as
      // restricted (fail closed).
      const projectFacts =
        row.projectId === null ? null : (projectFactsMap.get(row.projectId) ?? null);
      const actorAccess =
        row.projectId === null ? null : (projectAccessMap.get(row.projectId) ?? null);
      const projectArgument =
        projectFacts === null && row.projectId !== null
          ? // The note claims a project but the project row is absent in
            // PostgreSQL. Fail closed: treat as restricted with no actor
            // access. (A standalone note passes `null` to canReadNote below,
            // which is the allow path.)
            { restricted: true, actorAccess: null }
          : projectFacts === null
            ? null
            : { restricted: projectFacts.isRestricted, actorAccess };
      const accessible = this.policy.canReadNote(input.membershipRole, projectArgument);
      if (!accessible) continue;
      facts.set(row.id, {
        noteId: row.id,
        title: row.title,
        projectId: row.projectId,
        createdById: row.createdById,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        isArchived: row.isArchived,
        isTemplate: row.isTemplate,
        isPinned: row.isPinned,
        hasAttachments: attachmentMap.get(row.id) ?? false,
        accessible: true,
        authorName: authorMap.get(row.createdById) ?? null,
        projectTitle: row.projectId === null ? null : (projectTitleMap.get(row.projectId) ?? null),
      });
    }
    return facts;
  }

  // ----------------------------------------------------------------------- //
  // Internals
  // ----------------------------------------------------------------------- //

  private async loadNoteRows(noteIds: readonly string[]): Promise<readonly NoteRow[]> {
    return this.database.db
      .select({
        id: notes.id,
        title: notes.title,
        projectId: notes.projectId,
        createdById: notes.createdById,
        createdAt: notes.createdAt,
        updatedAt: notes.updatedAt,
        isArchived: notes.isArchived,
        isTemplate: notes.isTemplate,
        isPinned: notes.isPinned,
        isDeleted: notes.isDeleted,
      })
      .from(notes)
      .where(
        and(
          inArray(notes.id, [...noteIds]),
          // Soft-deleted notes are NOT search results. Excluded at the SQL
          // layer (the partial index `notes_workspace_active_updated_idx`
          // uses `is_deleted = false`); we re-check `isDeleted` above as
          // defense-in-depth for callers that bypass tenant scope.
          eq(notes.isDeleted, false),
          whereWorkspace(notes, this.tenantContext),
        ),
      );
  }

  private async loadProjectFacts(
    projectIds: readonly string[],
  ): Promise<ReadonlyMap<string, ProjectFactsRow>> {
    if (projectIds.length === 0) return new Map();
    const rows = await this.database.db
      .select({ id: projects.id, isRestricted: projects.isRestricted })
      .from(projects)
      .where(
        and(inArray(projects.id, [...projectIds]), whereWorkspace(projects, this.tenantContext)),
      );
    const map = new Map<string, ProjectFactsRow>();
    for (const row of rows) map.set(row.id, row);
    return map;
  }

  private async loadProjectAccess(
    projectIds: readonly string[],
    userId: string,
  ): Promise<ReadonlyMap<string, ProjectAccessRole>> {
    if (projectIds.length === 0) return new Map();
    const rows = await this.database.db
      .select({ projectId: projectAccess.projectId, role: projectAccess.role })
      .from(projectAccess)
      .where(
        and(inArray(projectAccess.projectId, [...projectIds]), eq(projectAccess.userId, userId)),
      );
    const map = new Map<string, ProjectAccessRole>();
    for (const row of rows) map.set(row.projectId, row.role);
    return map;
  }

  private async loadAuthors(authorIds: readonly string[]): Promise<ReadonlyMap<string, string>> {
    if (authorIds.length === 0) return new Map();
    const rows = await this.database.db
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(inArray(users.id, [...authorIds]));
    const map = new Map<string, string>();
    for (const row of rows) map.set(row.id, row.name);
    return map;
  }

  /**
   * Authoritative `hasAttachments` per note. An attachment counts iff
   * `processingStatus = "ready"` (validated, quota-committed, user-visible),
   * exactly mirroring `NoteProjectionRepository.loadAttachmentFlags` so the
   * search label and the indexed projection can never disagree on the
   * definition. `whereWorkspace(attachments, ...)` applies the workspace
   * check on the denormalized `attachments.workspace_id`.
   */
  private async loadAttachmentFlags(
    noteIds: readonly string[],
  ): Promise<ReadonlyMap<string, boolean>> {
    if (noteIds.length === 0) return new Map();
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

  private async loadProjectTitles(
    projectIds: readonly string[],
  ): Promise<ReadonlyMap<string, string>> {
    if (projectIds.length === 0) return new Map();
    const rows = await this.database.db
      .select({ id: projects.id, name: projects.name })
      .from(projects)
      .where(
        and(inArray(projects.id, [...projectIds]), whereWorkspace(projects, this.tenantContext)),
      );
    const map = new Map<string, string>();
    for (const row of rows) map.set(row.id, row.name);
    return map;
  }
}

function uniq(values: readonly string[]): string[] {
  return [...new Set(values)];
}
