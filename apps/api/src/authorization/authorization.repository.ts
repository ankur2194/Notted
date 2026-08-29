import { Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";

import { DatabaseService } from "../database/database.service";
import {
  apiKeys,
  attachments,
  comments,
  exportJobs,
  folders,
  noteShares,
  notes,
  projectAccess,
  projects,
  tags,
  tasks,
  taskStatuses,
  webhooks,
  workspaces,
  workspaceMembers,
} from "../database/schema";
import { TenantContextService, whereWorkspace, whereWorkspaceId } from "../tenant";

import type {
  AuthorizationResourceFacts,
  DelegationAuthorizationFacts,
  DelegationRequest,
  NoteSharePermission,
  ProjectAccessRole,
  ProjectAuthorizationFacts,
  ResourceLocator,
  WorkspaceRole,
} from "./authorization.contracts";
import type { Database, DatabaseTransaction } from "../database/database.service";

export interface LoadedMembership {
  readonly role: WorkspaceRole;
  readonly loadedAt: string;
}

export interface AuthorizationFactsReader {
  findMembership(workspaceId: string, userId: string): Promise<LoadedMembership | null>;
  loadResource(
    locator: ResourceLocator,
    actorUserId: string | null,
  ): Promise<AuthorizationResourceFacts | null>;
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * A pool handle or an OPEN transaction.
 *
 * Threading this matters for one reason: `NotesService.move()` and the
 * delete/restore path both re-authorize each descendant note INSIDE an already
 * open transaction. Every method here used `this.database.db` directly, so each
 * of those checks checked out a SECOND connection while the first was still
 * held — and at the default pool size of 10 (`DATABASE_POOL_MAX_CONNECTIONS`),
 * ten concurrent moves take all ten connections, then each waits for a
 * connection that only another waiter could release. The pool deadlocks and
 * every request fails.
 *
 * Only the `note` locator path takes the parameter, because only those two call
 * sites authorize inside a transaction. Everything else keeps its default and
 * is unchanged.
 */
export type AuthorizationRunner = Database | DatabaseTransaction;

@Injectable()
export class AuthorizationRepository implements AuthorizationFactsReader {
  constructor(
    private readonly database: DatabaseService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /**
   * The sole user-workspace bootstrap query. It returns only current membership
   * facts and never establishes tenant authority by itself. The entry service
   * creates TenantContext only after this exact pair is proven.
   */
  async findMembership(
    workspaceId: string,
    userId: string,
    db: AuthorizationRunner = this.database.db,
  ): Promise<LoadedMembership | null> {
    const [row] = await db
      .select({ role: workspaceMembers.role })
      .from(workspaceMembers)
      .where(
        and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)),
      )
      .limit(1);
    return row === undefined ? null : Object.freeze({ role: row.role, loadedAt: nowIso() });
  }

  async loadResource(
    locator: ResourceLocator,
    actorUserId: string | null,
    db: AuthorizationRunner = this.database.db,
  ): Promise<AuthorizationResourceFacts | null> {
    // Every tenant loader below calls get() here and again through a canonical
    // whereWorkspace/whereWorkspaceId predicate. A locator is only a selector.
    this.tenantContext.get();
    if (locator.kind === "session") {
      return null;
    }
    switch (locator.kind) {
      case "workspace":
      case "settings":
      case "billing":
      case "workspaceDeletion":
        return this.loadWorkspaceRoot(locator.kind);
      case "member":
        return this.loadMember(locator.id);
      case "project":
        return this.loadProject(locator.id, actorUserId, locator.delegation);
      case "note":
        return this.loadNote(locator.id, actorUserId, locator.delegation, locator.tagId, db);
      case "comment":
        return this.loadComment(locator.id, actorUserId);
      case "export":
        return this.loadExport(locator.id, actorUserId);
      case "apiKey":
        return this.loadDirect("apiKey", locator.id, apiKeys);
      case "webhook":
        return this.loadDirect("webhook", locator.id, webhooks);
      case "file":
        return this.loadFile(locator.id, actorUserId);
      case "folder":
        return this.loadFolder(locator.id);
      case "task":
        return this.loadTask(locator.id, actorUserId, locator.targetUserId, locator.tagId);
      case "tag":
        return this.loadTag(locator.id);
      default: {
        const exhaustive: never = locator;
        return exhaustive;
      }
    }
  }

  private async loadWorkspaceRoot(
    kind: "workspace" | "settings" | "billing" | "workspaceDeletion",
  ): Promise<AuthorizationResourceFacts | null> {
    const [row] = await this.database.db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(whereWorkspaceId(workspaces, this.tenantContext))
      .limit(1);
    return row === undefined
      ? null
      : Object.freeze({
          kind,
          id: row.id,
          workspaceId: row.id,
          project: null,
          loadedAt: nowIso(),
          relationsValid: true,
        });
  }

  private async loadMember(id: string): Promise<AuthorizationResourceFacts | null> {
    const [row] = await this.database.db
      .select({
        id: workspaceMembers.id,
        workspaceId: workspaceMembers.workspaceId,
        userId: workspaceMembers.userId,
        role: workspaceMembers.role,
      })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.id, id), whereWorkspace(workspaceMembers, this.tenantContext)))
      .limit(1);
    return row === undefined
      ? null
      : Object.freeze({
          kind: "member",
          id: row.id,
          workspaceId: row.workspaceId,
          targetUserId: row.userId,
          targetRole: row.role,
          project: null,
          loadedAt: nowIso(),
          relationsValid: true,
        });
  }

  private async projectFacts(
    projectId: string,
    actorUserId: string | null,
    db: AuthorizationRunner = this.database.db,
  ): Promise<ProjectAuthorizationFacts> {
    const [project] = await db
      .select({ isRestricted: projects.isRestricted })
      .from(projects)
      .where(and(eq(projects.id, projectId), whereWorkspace(projects, this.tenantContext)))
      .limit(1);
    /*
     * A workspace-scoped miss is a DENY, not "no project".
     *
     * `restricted: project?.isRestricted ?? true` below is fail-closed, but the
     * grant lookup that follows was not scoped at all, so a miss still produced
     * `{ restricted: true, actorAccess: "viewer" }` from the OTHER workspace's
     * grant — and `projectCanRead` ORs those two, returning true.
     *
     * Not reachable today: the composite FKs `notes_workspace_project_fk` and
     * `tasks_workspace_project_fk` make a cross-workspace `project_id`
     * impossible to store, and all three callers derive the id from a
     * workspace-scoped row. This is the deny-by-default form ADR 0009 requires
     * of this layer, so a future caller that passes a client-supplied project id
     * does not inherit a silent cross-tenant read.
     *
     * Returning here also makes the grant query below transitively scoped:
     * `project_access.project_id` now references a row already proven to be in
     * the active workspace, so it needs no join of its own.
     */
    if (project === undefined) return Object.freeze({ restricted: true, actorAccess: null });
    let actorAccess: ProjectAccessRole | null = null;
    if (actorUserId !== null) {
      const [actorGrant] = await db
        .select({ role: projectAccess.role })
        .from(projectAccess)
        .where(and(eq(projectAccess.projectId, projectId), eq(projectAccess.userId, actorUserId)))
        .limit(1);
      actorAccess = actorGrant?.role ?? null;
    }
    return Object.freeze({
      restricted: project.isRestricted,
      actorAccess,
    });
  }

  private async loadProject(
    id: string,
    actorUserId: string | null,
    delegation?: DelegationRequest,
  ): Promise<AuthorizationResourceFacts | null> {
    const [row] = await this.database.db
      .select({
        id: projects.id,
        workspaceId: projects.workspaceId,
        creatorId: projects.createdById,
      })
      .from(projects)
      .where(and(eq(projects.id, id), whereWorkspace(projects, this.tenantContext)))
      .limit(1);
    if (row === undefined) return null;
    return Object.freeze({
      kind: "project",
      id: row.id,
      workspaceId: row.workspaceId,
      creatorId: row.creatorId,
      project: await this.projectFacts(row.id, actorUserId),
      delegation: await this.loadDelegationFacts(delegation, row.id),
      loadedAt: nowIso(),
      relationsValid: true,
    });
  }

  private async loadNote(
    id: string,
    actorUserId: string | null,
    delegation?: DelegationRequest,
    tagId?: string,
    db: AuthorizationRunner = this.database.db,
  ): Promise<AuthorizationResourceFacts | null> {
    const [row] = await db
      .select({
        id: notes.id,
        workspaceId: notes.workspaceId,
        projectId: notes.projectId,
        parentId: notes.parentId,
        creatorId: notes.createdById,
      })
      .from(notes)
      .where(and(eq(notes.id, id), whereWorkspace(notes, this.tenantContext)))
      .limit(1);
    if (row === undefined) return null;
    /*
     * Five independent reads, issued together.
     *
     * These were awaited one at a time -- share, then parent, then project,
     * then the project grant, then the tag -- so a single authorized note read
     * cost six serial round trips before any data was returned, and
     * `loadComment` nests a whole `loadNote` inside itself on top of that. None
     * of the five depends on another's result.
     *
     * On a `DatabaseTransaction` (the `NotesService.move()` path documented at
     * the top of this file) node-postgres queues these on the one connection,
     * so they serialize -- correct, just no faster there. The win is on the
     * pool path, which is every other caller.
     */
    const [sharePermission, parentValid, project, delegationFacts, tagValid] = await Promise.all([
      this.loadNoteShare(row.id, actorUserId, db),
      row.parentId === null ? Promise.resolve(true) : this.hasScopedDirect(notes, row.parentId, db),
      row.projectId === null
        ? Promise.resolve(null)
        : this.projectFacts(row.projectId, actorUserId, db),
      this.loadDelegationFacts(delegation, row.projectId, db),
      tagId === undefined ? Promise.resolve(true) : this.hasActiveTag(tagId, db),
    ]);
    return Object.freeze({
      kind: "note",
      id: row.id,
      workspaceId: row.workspaceId,
      creatorId: row.creatorId,
      project,
      sharePermission,
      delegation: delegationFacts,
      loadedAt: nowIso(),
      relationsValid: parentValid && tagValid,
    });
  }

  private async loadNoteShare(
    noteId: string,
    actorUserId: string | null,
    db: AuthorizationRunner = this.database.db,
  ): Promise<NoteSharePermission | null> {
    if (actorUserId === null) return null;
    // `note_shares` has no `workspace_id`, so `workspace-scope.ts` requires the
    // parent-join form -- the same shape `loadComment` and `loadFile` already
    // use. Correct today because `noteId` arrives from a workspace-scoped row;
    // stated here so it stays correct when a caller changes.
    const [share] = await db
      .select({ permission: noteShares.permission })
      .from(noteShares)
      .innerJoin(notes, eq(noteShares.noteId, notes.id))
      .where(
        and(
          eq(noteShares.noteId, noteId),
          eq(noteShares.userId, actorUserId),
          whereWorkspace(notes, this.tenantContext),
        ),
      )
      .limit(1);
    return share?.permission ?? null;
  }

  private async loadDelegationFacts(
    request: DelegationRequest | undefined,
    projectId: string | null,
    db: AuthorizationRunner = this.database.db,
  ): Promise<DelegationAuthorizationFacts | null> {
    if (request === undefined) return null;
    const [membership] = await db
      .select({ userId: workspaceMembers.userId })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.userId, request.targetUserId),
          whereWorkspace(workspaceMembers, this.tenantContext),
        ),
      )
      .limit(1);
    let targetProjectAccess: ProjectAccessRole | null = null;
    if (projectId !== null && membership !== undefined) {
      // Joined to `projects` and scoped there: this is the one of the three
      // parent-join omissions with a live consequence, because `projectId`
      // arrives from `loadNote` unproven by this function.
      const [grant] = await db
        .select({ role: projectAccess.role })
        .from(projectAccess)
        .innerJoin(projects, eq(projectAccess.projectId, projects.id))
        .where(
          and(
            eq(projectAccess.projectId, projectId),
            eq(projectAccess.userId, request.targetUserId),
            whereWorkspace(projects, this.tenantContext),
          ),
        )
        .limit(1);
      targetProjectAccess = grant?.role ?? null;
    }
    return Object.freeze({
      requestedPermission: request.requestedPermission,
      targetMemberActive: membership !== undefined,
      targetProjectAccess,
    });
  }

  private async loadComment(
    id: string,
    actorUserId: string | null,
  ): Promise<AuthorizationResourceFacts | null> {
    const [row] = await this.database.db
      .select({
        id: comments.id,
        creatorId: comments.createdById,
        noteId: comments.noteId,
        parentId: comments.parentId,
      })
      .from(comments)
      .innerJoin(notes, eq(comments.noteId, notes.id))
      .where(and(eq(comments.id, id), whereWorkspace(notes, this.tenantContext)))
      .limit(1);
    if (row === undefined) return null;
    // The nested note load and the parent-comment probe are independent, and
    // `loadNote` alone is six queries deep -- see the note there.
    const [note, parentValid] = await Promise.all([
      this.loadNote(row.noteId, actorUserId),
      row.parentId === null
        ? Promise.resolve(true)
        : this.database.db
            .select({ noteId: comments.noteId })
            .from(comments)
            // Scoped through the parent note rather than read and discarded:
            // the comparison below already fails closed, but this stops a
            // foreign-tenant row from being read at all.
            .innerJoin(notes, eq(comments.noteId, notes.id))
            .where(and(eq(comments.id, row.parentId), whereWorkspace(notes, this.tenantContext)))
            .limit(1)
            .then((rows) => rows[0]?.noteId === row.noteId),
    ]);
    return note === null
      ? null
      : Object.freeze({
          kind: "comment",
          id: row.id,
          workspaceId: note.workspaceId,
          creatorId: row.creatorId,
          note,
          project: null,
          loadedAt: nowIso(),
          relationsValid: parentValid && note.workspaceId === this.tenantContext.get().workspaceId,
        });
  }

  private async loadExport(
    id: string,
    actorUserId: string | null,
  ): Promise<AuthorizationResourceFacts | null> {
    const [row] = await this.database.db
      .select({
        id: exportJobs.id,
        workspaceId: exportJobs.workspaceId,
        requestedById: exportJobs.requestedById,
        sourceType: exportJobs.sourceType,
        sourceId: exportJobs.sourceId,
        status: exportJobs.status,
      })
      .from(exportJobs)
      .where(and(eq(exportJobs.id, id), whereWorkspace(exportJobs, this.tenantContext)))
      .limit(1);
    if (row === undefined) return null;
    let source: AuthorizationResourceFacts | null = null;
    if (row.sourceType === "workspace") source = await this.loadWorkspaceRoot("workspace");
    if (row.sourceType === "project" && row.sourceId !== null) {
      source = await this.loadProject(row.sourceId, actorUserId);
    }
    if (row.sourceType === "note" && row.sourceId !== null) {
      source = await this.loadNote(row.sourceId, actorUserId);
    }
    return Object.freeze({
      kind: "export",
      id: row.id,
      workspaceId: row.workspaceId,
      requestedById: row.requestedById,
      source,
      sourceReadable: source !== null,
      status: row.status,
      project: null,
      loadedAt: nowIso(),
      relationsValid: source !== null && source.workspaceId === row.workspaceId,
    });
  }

  private async loadDirect(
    kind: "apiKey" | "webhook",
    id: string,
    table: typeof apiKeys | typeof webhooks,
  ): Promise<AuthorizationResourceFacts | null> {
    // Keep both direct table branches explicit so Drizzle retains the concrete
    // column types while both still use the canonical active-context predicate.
    const row =
      table === apiKeys
        ? (
            await this.database.db
              .select({
                id: apiKeys.id,
                workspaceId: apiKeys.workspaceId,
                creatorId: apiKeys.createdById,
              })
              .from(apiKeys)
              .where(and(eq(apiKeys.id, id), whereWorkspace(apiKeys, this.tenantContext)))
              .limit(1)
          )[0]
        : (
            await this.database.db
              .select({
                id: webhooks.id,
                workspaceId: webhooks.workspaceId,
                creatorId: webhooks.createdById,
              })
              .from(webhooks)
              .where(and(eq(webhooks.id, id), whereWorkspace(webhooks, this.tenantContext)))
              .limit(1)
          )[0];
    return row === undefined
      ? null
      : Object.freeze({
          kind,
          id: row.id,
          workspaceId: row.workspaceId,
          creatorId: row.creatorId,
          project: null,
          loadedAt: nowIso(),
          relationsValid: true,
        });
  }

  private async loadFile(
    id: string,
    actorUserId: string | null,
  ): Promise<AuthorizationResourceFacts | null> {
    const [row] = await this.database.db
      .select({
        id: attachments.id,
        workspaceId: attachments.workspaceId,
        creatorId: attachments.createdById,
        noteId: attachments.noteId,
        noteWorkspaceId: notes.workspaceId,
      })
      .from(attachments)
      .innerJoin(notes, eq(attachments.noteId, notes.id))
      .where(
        and(
          eq(attachments.id, id),
          whereWorkspace(attachments, this.tenantContext),
          whereWorkspace(notes, this.tenantContext),
        ),
      )
      .limit(1);
    if (row === undefined) return null;
    const note = await this.loadNote(row.noteId, actorUserId);
    return note === null
      ? null
      : Object.freeze({
          kind: "file",
          id: row.id,
          workspaceId: row.workspaceId,
          creatorId: row.creatorId,
          note,
          project: null,
          loadedAt: nowIso(),
          relationsValid:
            row.workspaceId === row.noteWorkspaceId &&
            row.workspaceId === this.tenantContext.get().workspaceId,
        });
  }

  private async loadFolder(id: string): Promise<AuthorizationResourceFacts | null> {
    const [row] = await this.database.db
      .select({
        id: folders.id,
        workspaceId: folders.workspaceId,
        creatorId: folders.createdById,
        parentId: folders.parentId,
      })
      .from(folders)
      .where(and(eq(folders.id, id), whereWorkspace(folders, this.tenantContext)))
      .limit(1);
    if (row === undefined) return null;
    return Object.freeze({
      kind: "folder",
      id: row.id,
      workspaceId: row.workspaceId,
      creatorId: row.creatorId,
      project: null,
      loadedAt: nowIso(),
      relationsValid: row.parentId === null || (await this.hasScopedDirect(folders, row.parentId)),
    });
  }

  /**
   * Tags carry no creator column by design (see `database/schema/tags.ts`), so
   * `creatorId` is null and the policy never grants creator-based authority.
   * A tag outside the active workspace returns null — concealed as 404, not 403.
   */
  private async loadTag(id: string): Promise<AuthorizationResourceFacts | null> {
    const [row] = await this.database.db
      .select({ id: tags.id, workspaceId: tags.workspaceId, createdAt: tags.createdAt })
      .from(tags)
      .where(and(eq(tags.id, id), whereWorkspace(tags, this.tenantContext)))
      .limit(1);
    if (row === undefined) return null;
    return Object.freeze({
      kind: "tag",
      id: row.id,
      workspaceId: row.workspaceId,
      creatorId: null,
      relationsValid: true,
      project: null,
      loadedAt: nowIso(),
    });
  }

  private async loadTask(
    id: string,
    actorUserId: string | null,
    targetUserId?: string,
    tagId?: string,
  ): Promise<AuthorizationResourceFacts | null> {
    const [row] = await this.database.db
      .select({
        id: tasks.id,
        workspaceId: tasks.workspaceId,
        projectId: tasks.projectId,
        noteId: tasks.noteId,
        parentId: tasks.parentId,
        customStatusId: tasks.customStatusId,
        creatorId: tasks.createdById,
      })
      .from(tasks)
      .where(and(eq(tasks.id, id), whereWorkspace(tasks, this.tenantContext)))
      .limit(1);
    if (row === undefined) return null;
    // Six independent reads, issued together -- see the note in `loadNote`.
    const [targetMemberActive, noteValid, parentValid, statusValid, project, tagValid] =
      await Promise.all([
        targetUserId === undefined
          ? Promise.resolve(undefined)
          : this.hasActiveMember(targetUserId),
        row.noteId === null ? Promise.resolve(true) : this.hasScopedDirect(notes, row.noteId),
        row.parentId === null ? Promise.resolve(true) : this.hasScopedDirect(tasks, row.parentId),
        row.customStatusId === null
          ? Promise.resolve(true)
          : this.hasValidTaskStatus(row.customStatusId, row.projectId),
        row.projectId === null
          ? Promise.resolve(null)
          : this.projectFacts(row.projectId, actorUserId),
        tagId === undefined ? Promise.resolve(true) : this.hasActiveTag(tagId),
      ]);
    return Object.freeze({
      kind: "task",
      id: row.id,
      workspaceId: row.workspaceId,
      creatorId: row.creatorId,
      project,
      targetMemberActive,
      loadedAt: nowIso(),
      relationsValid: noteValid && parentValid && statusValid && tagValid,
    });
  }

  private async hasScopedDirect(
    table: typeof notes | typeof folders | typeof tasks,
    id: string,
    db: AuthorizationRunner = this.database.db,
  ): Promise<boolean> {
    if (table === notes) {
      const [row] = await db
        .select({ id: notes.id })
        .from(notes)
        .where(and(eq(notes.id, id), whereWorkspace(notes, this.tenantContext)))
        .limit(1);
      return row !== undefined;
    }
    if (table === folders) {
      const [row] = await db
        .select({ id: folders.id })
        .from(folders)
        .where(and(eq(folders.id, id), whereWorkspace(folders, this.tenantContext)))
        .limit(1);
      return row !== undefined;
    }
    const [row] = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.id, id), whereWorkspace(tasks, this.tenantContext)))
      .limit(1);
    return row !== undefined;
  }

  private async hasValidTaskStatus(
    statusId: string,
    taskProjectId: string | null,
  ): Promise<boolean> {
    const [row] = await this.database.db
      .select({ projectId: taskStatuses.projectId })
      .from(taskStatuses)
      .where(and(eq(taskStatuses.id, statusId), whereWorkspace(taskStatuses, this.tenantContext)))
      .limit(1);
    return row !== undefined && (row.projectId === null || row.projectId === taskProjectId);
  }

  private async hasActiveMember(userId: string): Promise<boolean> {
    const [row] = await this.database.db
      .select({ id: workspaceMembers.id })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.userId, userId),
          whereWorkspace(workspaceMembers, this.tenantContext),
        ),
      )
      .limit(1);
    return row !== undefined;
  }

  private async hasActiveTag(
    tagId: string,
    db: AuthorizationRunner = this.database.db,
  ): Promise<boolean> {
    const [row] = await db
      .select({ id: tags.id })
      .from(tags)
      .where(and(eq(tags.id, tagId), whereWorkspace(tags, this.tenantContext)))
      .limit(1);
    return row !== undefined;
  }
}
