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
      restricted: project?.isRestricted ?? true,
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
    const sharePermission = await this.loadNoteShare(row.id, actorUserId, db);
    const parentValid =
      row.parentId === null || (await this.hasScopedDirect(notes, row.parentId, db));
    return Object.freeze({
      kind: "note",
      id: row.id,
      workspaceId: row.workspaceId,
      creatorId: row.creatorId,
      project:
        row.projectId === null ? null : await this.projectFacts(row.projectId, actorUserId, db),
      sharePermission,
      delegation: await this.loadDelegationFacts(delegation, row.projectId, db),
      loadedAt: nowIso(),
      relationsValid: parentValid && (tagId === undefined || (await this.hasActiveTag(tagId, db))),
    });
  }

  private async loadNoteShare(
    noteId: string,
    actorUserId: string | null,
    db: AuthorizationRunner = this.database.db,
  ): Promise<NoteSharePermission | null> {
    if (actorUserId === null) return null;
    const [share] = await db
      .select({ permission: noteShares.permission })
      .from(noteShares)
      .where(and(eq(noteShares.noteId, noteId), eq(noteShares.userId, actorUserId)))
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
      const [grant] = await db
        .select({ role: projectAccess.role })
        .from(projectAccess)
        .where(
          and(
            eq(projectAccess.projectId, projectId),
            eq(projectAccess.userId, request.targetUserId),
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
    const note = await this.loadNote(row.noteId, actorUserId);
    const parentValid =
      row.parentId === null ||
      (
        await this.database.db
          .select({ noteId: comments.noteId })
          .from(comments)
          .where(eq(comments.id, row.parentId))
          .limit(1)
      )[0]?.noteId === row.noteId;
    return note === null
      ? null
      : Object.freeze({
          kind: "comment",
          id: row.id,
          workspaceId: note.workspaceId,
          creatorId: row.creatorId,
          note,
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
    const targetMemberActive =
      targetUserId === undefined ? undefined : await this.hasActiveMember(targetUserId);
    const noteValid = row.noteId === null || (await this.hasScopedDirect(notes, row.noteId));
    const parentValid = row.parentId === null || (await this.hasScopedDirect(tasks, row.parentId));
    const statusValid =
      row.customStatusId === null ||
      (await this.hasValidTaskStatus(row.customStatusId, row.projectId));
    return Object.freeze({
      kind: "task",
      id: row.id,
      workspaceId: row.workspaceId,
      creatorId: row.creatorId,
      project: row.projectId === null ? null : await this.projectFacts(row.projectId, actorUserId),
      targetMemberActive,
      loadedAt: nowIso(),
      relationsValid:
        noteValid &&
        parentValid &&
        statusValid &&
        (tagId === undefined || (await this.hasActiveTag(tagId))),
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
