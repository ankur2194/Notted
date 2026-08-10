import { createHash, randomUUID } from "node:crypto";

import { HttpStatus, Injectable } from "@nestjs/common";
import {
  and,
  asc,
  desc,
  eq,
  exists,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
  type SQL,
} from "drizzle-orm";

import { AuthorizationEntryService } from "../authorization/authorization-entry.service";
import { AuthorizationDeniedError } from "../authorization/authorization.errors";
import { ApiHttpException } from "../common/errors/api-http.exception";
import {
  assertIdempotencyPayload,
  createApiIdempotencyIdentity,
  loadApiIdempotency,
  lockApiIdempotency,
  storeApiIdempotency,
} from "../common/idempotency/api-idempotency";
import { DatabaseService, type DatabaseTransaction } from "../database/database.service";
import {
  auditLogs,
  jobOutbox,
  type JobOutboxPayload,
  notes,
  projectAccess,
  projects,
  tags,
  tasks,
  taskStatuses,
  taskTags,
  workspaceMembers,
} from "../database/schema";
import {
  activeWorkspaceId,
  assertWorkspaceInsertValues,
  TenantContextService,
  whereWorkspace,
} from "../tenant";

import { assertCron, nextOccurrence } from "./task-recurrence";
import {
  TASK_AUDIT_ENTITY_TYPE,
  TASK_DOMAIN_EVENT_IDEMPOTENCY_PREFIX,
  TASK_DOMAIN_EVENT_PAYLOAD_VERSION,
  TASK_DOMAIN_EVENT_QUEUE,
  TASK_DOMAIN_EVENTS,
  type TaskMutation,
} from "./tasks.constants";

import type { AuthorizedOperation } from "../authorization/authorization.contracts";
import type {
  AuthenticatedPrincipal,
  TaskBulkResult,
  TaskBulkSkip,
  TaskCreateResult,
  TaskDeleteResult,
  TaskDetail,
  TaskGrouping,
  TaskPage,
  TaskPriority,
  TaskRecurrence,
  TaskReorderResult,
  TaskSortField,
  TaskStatus,
  TaskSummary,
  TaskUpdateResult,
} from "@notted/shared-types";

interface ScopedInput {
  readonly principal: AuthenticatedPrincipal;
  readonly workspaceId: string;
  readonly requestId?: string | null;
}

interface TaskSelector extends ScopedInput {
  readonly taskId: string;
}

/**
 * A sibling group. Ordering is only ever meaningful WITHIN one of these, which
 * is also the unit the advisory lock protects.
 */
interface TaskGroup {
  readonly projectId: string | null;
  readonly noteId: string | null;
  readonly parentId: string | null;
}

interface TaskRow extends TaskGroup {
  readonly id: string;
  readonly workspaceId: string;
  readonly title: string;
  readonly description: string | null;
  readonly status: TaskStatus;
  readonly customStatusId: string | null;
  readonly priority: TaskPriority;
  readonly assigneeId: string | null;
  readonly dueDate: Date | null;
  readonly completedAt: Date | null;
  readonly sortOrder: number;
  readonly recurrence: TaskRecurrence;
  readonly recurrenceCron: string | null;
  readonly createdById: string;
  readonly updatedById: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

interface Sibling {
  readonly id: string;
  readonly sortOrder: number;
}

export interface ListTasksServiceInput extends ScopedInput {
  readonly page: number;
  readonly limit: number;
  readonly noteId?: string;
  readonly projectId?: string;
  readonly parentId?: string;
  readonly assigneeId?: string;
  readonly status?: TaskStatus;
  readonly priority?: TaskPriority;
  readonly tagId?: string;
  readonly dueFrom?: string;
  readonly dueTo?: string;
  readonly isCompleted?: boolean;
  readonly grouping: TaskGrouping;
  readonly sortBy: TaskSortField;
  readonly sortDirection: "asc" | "desc";
}

export interface CreateTaskServiceInput extends ScopedInput {
  readonly projectId: string | null;
  readonly noteId: string | null;
  readonly parentId: string | null;
  readonly title: string;
  readonly description: string | null;
  readonly status: TaskStatus;
  readonly customStatusId: string | null;
  readonly priority: TaskPriority;
  readonly assigneeId: string | null;
  readonly dueDate: string | null;
  readonly beforeTaskId: string | null;
  readonly tagIds: readonly string[];
  readonly recurrence: TaskRecurrence;
  readonly recurrenceCron: string | null;
  readonly idempotencyKey: string;
}

export interface UpdateTaskServiceInput extends TaskSelector {
  readonly title?: string;
  readonly description?: string | null;
  readonly status?: TaskStatus;
  readonly customStatusId?: string | null;
  readonly priority?: TaskPriority;
  readonly assigneeId?: string | null;
  readonly dueDate?: string | null;
  readonly tagIds?: readonly string[];
  readonly recurrence?: TaskRecurrence;
  readonly recurrenceCron?: string | null;
}

export interface ReorderTaskServiceInput extends TaskSelector {
  readonly beforeTaskId: string | null;
  readonly noteId?: string | null;
  readonly projectId?: string | null;
  readonly parentId?: string | null;
}

export type BulkTaskAction =
  | { readonly kind: "status"; readonly status: TaskStatus }
  | { readonly kind: "assign"; readonly assigneeId: string | null }
  | { readonly kind: "priority"; readonly priority: TaskPriority }
  | { readonly kind: "tag"; readonly tagIds: readonly string[] }
  | { readonly kind: "delete" };

export interface BulkTaskServiceInput extends ScopedInput {
  readonly taskIds: readonly string[];
  readonly action: BulkTaskAction;
  readonly idempotencyKey: string;
}

/**
 * The single authority for task policy, transactions and SQL. Both transports
 * (`/api/v1` REST and tRPC) call these methods and add nothing of their own.
 *
 * EFFECTIVE STATUS (Part 48 inherits this): the board column a task renders in
 * is `customStatusId ?? status`, but a task carrying a `customStatusId` KEEPS
 * its built-in `status`, and that built-in value ALONE drives `completedAt`.
 * There is deliberately no `task_statuses.is_terminal` column: a workspace
 * would then own two disagreeing definitions of "done" and every progress
 * calculation would have to pick one.
 */
@Injectable()
export class TasksService {
  constructor(
    private readonly database: DatabaseService,
    private readonly authorizationEntry: AuthorizationEntryService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /**
   * Reading a container's tasks is gated by reading the CONTAINER, exactly as
   * `NotesService.list` is. `task.read` is declared against the `task` resource
   * kind only (`RESOURCE_KINDS_BY_ACTION`), and a list has no single task to
   * name — so the note / project / workspace read action is both the accurate
   * question and the one the policy can answer. The per-row `projectVisibility`
   * predicate below then hides restricted-project tasks inside the result.
   */
  async list(input: ListTasksServiceInput): Promise<TaskPage> {
    const operation = await this.authorizeListScope(input);
    return this.authorizationEntry.run(operation, async () => {
      const conditions = await this.listConditions(input);
      const rows = await this.database.db
        .select(this.taskSelection())
        .from(tasks)
        .where(and(...conditions))
        .orderBy(...this.listOrder(input))
        .limit(input.limit + 1)
        .offset((input.page - 1) * input.limit);
      const visible = rows.slice(0, input.limit);
      // Two batched lookups, never one per row.
      const [tagsByTask, labels] = await Promise.all([
        this.loadTagMap(
          this.database.db,
          visible.map((row) => row.id),
        ),
        this.loadStatusLabels(
          this.database.db,
          visible.map((row) => row.customStatusId),
        ),
      ]);
      return Object.freeze({
        items: Object.freeze(
          visible.map((row) =>
            this.toSummary(row, tagsByTask.get(row.id) ?? [], this.labelFor(row, labels)),
          ),
        ),
        page: input.page,
        limit: input.limit,
        hasMore: rows.length > input.limit,
      });
    });
  }

  async read(input: TaskSelector): Promise<TaskDetail> {
    const operation = await this.authorizeTask(input, "task.read");
    return this.authorizationEntry.run(operation, async () =>
      this.toDetail(await this.readRow(this.database.db, input.taskId)),
    );
  }

  /**
   * Create does NOT call `task.assign`, and that asymmetry is deliberate: the
   * task does not exist yet, so the authorization repository's fact load would
   * conceal it as a 404 and no create could ever name an assignee. Membership
   * is instead validated inside the transaction (`assertAssignee`), while
   * `task.assign` guards REASSIGNMENT on an existing task in `update`/`bulk`.
   */
  async create(input: CreateTaskServiceInput): Promise<TaskCreateResult> {
    const operation = await this.authorizeCreateDestination(input, input);
    return this.authorizationEntry.run(operation, async () => {
      const taskId = randomUUID();
      const idempotency = createApiIdempotencyIdentity({
        actorUserId: input.principal.userId,
        operation: `task.create:${input.workspaceId}`,
        key: input.idempotencyKey,
        payload: {
          projectId: input.projectId,
          noteId: input.noteId,
          parentId: input.parentId,
          title: input.title,
          description: input.description,
          status: input.status,
          customStatusId: input.customStatusId,
          priority: input.priority,
          assigneeId: input.assigneeId,
          dueDate: input.dueDate,
          beforeTaskId: input.beforeTaskId,
          tagIds: input.tagIds,
          recurrence: input.recurrence,
          recurrenceCron: input.recurrenceCron,
        },
      });
      const row = await this.database.transaction(
        async (tx) => {
          await lockApiIdempotency(tx, idempotency);
          const replay = await loadApiIdempotency(tx, idempotency);
          if (replay !== null) {
            assertIdempotencyPayload(replay, idempotency);
            return this.readIdempotentTask(tx, replay.resourceId);
          }
          await this.validateGroup(tx, input, null);
          await this.assertTags(tx, input.tagIds);
          await this.assertAssignee(tx, input.assigneeId);
          await this.assertCustomStatus(tx, input.customStatusId, input.projectId);
          if (input.recurrence === "custom") assertCron(this.requireCron(input.recurrenceCron));
          await this.lockGroups(tx, [input]);
          // Rechecked after the lock so a concurrent parent move cannot strand
          // the new child in a group that no longer exists.
          if (input.parentId !== null) await this.validateGroup(tx, input, null);
          const sortOrder = await this.positionFor(tx, input, input.beforeTaskId, null);
          await tx.insert(tasks).values(
            assertWorkspaceInsertValues(
              {
                id: taskId,
                workspaceId: activeWorkspaceId(this.tenantContext),
                projectId: input.projectId,
                noteId: input.noteId,
                parentId: input.parentId,
                title: input.title,
                description: input.description,
                status: input.status,
                customStatusId: input.customStatusId,
                priority: input.priority,
                assigneeId: input.assigneeId,
                dueDate: this.toDate(input.dueDate),
                completedAt: input.status === "done" ? new Date() : null,
                sortOrder,
                recurrence: input.recurrence,
                recurrenceCron: input.recurrence === "custom" ? input.recurrenceCron : null,
                createdById: input.principal.userId,
                updatedById: input.principal.userId,
              },
              this.tenantContext,
              "task.create",
            ),
          );
          await this.replaceTags(tx, taskId, input.tagIds);
          await this.recordMutation(tx, "create", taskId, input);
          await storeApiIdempotency(tx, idempotency, taskId);
          return this.readRow(tx, taskId);
        },
        { isolationLevel: "read committed" },
      );
      return Object.freeze({ task: await this.toDetail(row) });
    });
  }

  async update(input: UpdateTaskServiceInput): Promise<TaskUpdateResult> {
    const operation = await this.authorizeTask(input, "task.update");
    // Reassignment and retagging are separate grants, so an editor who may edit
    // a task still cannot silently hand it to someone else or reshape the
    // workspace vocabulary attached to it.
    if (input.assigneeId !== undefined) {
      await this.authorizationEntry.authorizeUser({
        principal: input.principal,
        workspaceId: input.workspaceId,
        action: "task.assign",
        // `targetUserId` is omitted when clearing the assignee: there is no
        // target membership to prove, so the policy's editor branch (which
        // requires an ACTIVE target) falls through and only owner/admin may
        // unassign. Deny-by-default is the safe side of that ambiguity.
        resource: {
          kind: "task",
          id: input.taskId,
          ...(input.assigneeId === null ? {} : { targetUserId: input.assigneeId }),
        },
        requestId: input.requestId,
      });
    }
    if (input.tagIds !== undefined) await this.authorizeTask(input, "task.tag");
    return this.authorizationEntry.run(operation, async () => {
      const result = await this.database.transaction(
        async (tx) => {
          const current = await this.readRow(tx, input.taskId);
          if (input.tagIds !== undefined) await this.assertTags(tx, input.tagIds);
          if (input.assigneeId !== undefined) await this.assertAssignee(tx, input.assigneeId);
          if (input.customStatusId !== undefined) {
            await this.assertCustomStatus(tx, input.customStatusId, current.projectId);
          }
          const recurrence = input.recurrence ?? current.recurrence;
          const recurrenceCron = this.effectiveCron(input, current, recurrence);
          const dueDate =
            input.dueDate === undefined ? current.dueDate : this.toDate(input.dueDate);
          const status = input.status ?? current.status;
          const enteringDone = status === "done" && current.status !== "done";
          const leavingDone = status !== "done" && current.status === "done";
          const willSpawn = enteringDone && recurrence !== "none" && dueDate !== null;
          // Take the sibling-group advisory lock BEFORE the row update whenever a
          // successor will be inserted. `create` locks the group first and only
          // then row-locks siblings while renormalizing; row-updating first and
          // locking the group afterwards is the opposite order, and the two
          // deadlock against each other (40P01) with no retry anywhere in the
          // service. Advisory locks are re-entrant within a transaction, so
          // `spawnNextOccurrence` still takes it for its own correctness.
          if (willSpawn) await this.lockGroups(tx, [this.groupOf(current)]);

          const changes = {
            updatedAt: new Date(),
            updatedById: input.principal.userId,
            ...(input.title === undefined ? {} : { title: input.title }),
            ...(input.description === undefined ? {} : { description: input.description }),
            ...(input.status === undefined ? {} : { status }),
            ...(input.customStatusId === undefined ? {} : { customStatusId: input.customStatusId }),
            ...(input.priority === undefined ? {} : { priority: input.priority }),
            ...(input.assigneeId === undefined ? {} : { assigneeId: input.assigneeId }),
            ...(input.dueDate === undefined ? {} : { dueDate }),
            ...(input.recurrence === undefined && input.recurrenceCron === undefined
              ? {}
              : { recurrence, recurrenceCron }),
            ...(enteringDone ? { completedAt: new Date() } : {}),
            ...(leavingDone ? { completedAt: null } : {}),
          };
          const [updated] = await tx
            .update(tasks)
            .set(changes)
            .where(and(eq(tasks.id, input.taskId), whereWorkspace(tasks, this.tenantContext)))
            .returning(this.taskSelection());
          if (updated === undefined) this.notFound();
          if (input.tagIds !== undefined) await this.replaceTags(tx, input.taskId, input.tagIds);
          const tagIds = input.tagIds ?? (await this.loadTagIds(tx, input.taskId));
          const spawned =
            willSpawn && dueDate !== null
              ? await this.spawnNextOccurrence(tx, updated, {
                  recurrence,
                  recurrenceCron,
                  dueDate,
                  tagIds,
                  input,
                })
              : null;
          await this.recordMutation(tx, "update", input.taskId, input);
          return { updated, spawned };
        },
        { isolationLevel: "serializable" },
      );
      return Object.freeze({
        task: await this.toDetail(result.updated),
        spawned: result.spawned,
      });
    });
  }

  async reorder(input: ReorderTaskServiceInput): Promise<TaskReorderResult> {
    const operation = await this.authorizeTask(input, "task.update");
    // Any explicit container field makes the request a MOVE, and the whole
    // destination group is then absolute (an omitted sibling field means root,
    // never "keep"). That keeps the destination knowable before any SQL, so
    // `task.create` on it can be proved up front like `NotesService.move` does.
    const moved =
      input.noteId !== undefined || input.projectId !== undefined || input.parentId !== undefined;
    const destination: TaskGroup | null = moved
      ? {
          projectId: input.projectId ?? null,
          noteId: input.noteId ?? null,
          parentId: input.parentId ?? null,
        }
      : null;
    if (destination !== null) await this.authorizeCreateDestination(input, destination);
    return this.authorizationEntry.run(operation, async () => {
      const row = await this.database.transaction(
        async (tx) => {
          const source = await this.readRow(tx, input.taskId);
          const group = destination ?? this.groupOf(source);
          if (group.parentId === input.taskId || input.beforeTaskId === input.taskId) {
            this.invalidHierarchy();
          }
          await this.validateGroup(tx, group, input.taskId);
          await this.assertNoCycle(tx, input.taskId, group.parentId);
          await this.lockGroups(tx, [this.groupOf(source), group]);
          // Reloaded under the lock: the sibling set the placement is computed
          // against must be the one no other transaction can be reshaping.
          const sortOrder = await this.positionFor(tx, group, input.beforeTaskId, input.taskId);
          const [updated] = await tx
            .update(tasks)
            .set({
              projectId: group.projectId,
              noteId: group.noteId,
              parentId: group.parentId,
              sortOrder,
              updatedAt: new Date(),
              updatedById: input.principal.userId,
            })
            .where(and(eq(tasks.id, input.taskId), whereWorkspace(tasks, this.tenantContext)))
            .returning(this.taskSelection());
          if (updated === undefined) this.notFound();
          await this.recordMutation(tx, "reorder", input.taskId, input);
          return updated;
        },
        { isolationLevel: "serializable" },
      );
      const [tagIds, labels] = await Promise.all([
        this.loadTagIds(this.database.db, row.id),
        this.loadStatusLabels(this.database.db, [row.customStatusId]),
      ]);
      return Object.freeze({ task: this.toSummary(row, tagIds, this.labelFor(row, labels)) });
    });
  }

  /**
   * HARD delete: `tasks` carries no `is_deleted` column, so there is no trash
   * to restore from and the self-referencing FK cascades the subtree.
   */
  async remove(input: TaskSelector): Promise<TaskDeleteResult> {
    const operation = await this.authorizeTask(input, "task.delete");
    return this.authorizationEntry.run(operation, async () => {
      const affected = await this.database.transaction(
        async (tx) => {
          await this.readRow(tx, input.taskId);
          const subtree = await this.subtreeIds(tx, [input.taskId]);
          await this.recordMutation(tx, "delete", input.taskId, input);
          const deleted = await tx
            .delete(tasks)
            .where(and(eq(tasks.id, input.taskId), whereWorkspace(tasks, this.tenantContext)))
            .returning({ id: tasks.id });
          if (deleted.length !== 1) this.notFound();
          return subtree.length;
        },
        { isolationLevel: "serializable" },
      );
      return Object.freeze({ id: input.taskId, deleted: true as const, affected });
    });
  }

  /**
   * Every identifier is authorized INDIVIDUALLY before the transaction opens,
   * and a denied identifier reports the same `unavailable` reason as a missing
   * one. Separating "forbidden" from "not found" here would turn the batch
   * endpoint into an existence oracle for tasks the caller cannot see.
   *
   * A bulk status change deliberately does NOT spawn recurrences: `TaskBulkResult`
   * has nowhere to report them, and silently creating up to a hundred invisible
   * tasks is worse than asking the user to complete recurring work one at a time.
   */
  async bulk(input: BulkTaskServiceInput): Promise<TaskBulkResult> {
    const action = this.bulkAction(input.action);
    const allowed: string[] = [];
    const skipped: TaskBulkSkip[] = [];
    let operation: AuthorizedOperation | null = null;
    for (const taskId of input.taskIds) {
      try {
        const decided = await this.authorizationEntry.authorizeUser({
          principal: input.principal,
          workspaceId: input.workspaceId,
          action,
          resource: {
            kind: "task",
            id: taskId,
            ...(input.action.kind === "assign" && input.action.assigneeId !== null
              ? { targetUserId: input.action.assigneeId }
              : {}),
          },
          requestId: input.requestId,
        });
        operation ??= decided;
        allowed.push(taskId);
      } catch (error: unknown) {
        if (!(error instanceof AuthorizationDeniedError)) throw error;
        skipped.push(Object.freeze({ taskId, reason: "unavailable" as const }));
      }
    }
    if (operation === null) {
      return Object.freeze({
        updated: Object.freeze([]),
        skipped: Object.freeze(skipped),
        affected: 0,
      });
    }
    return this.authorizationEntry.run(operation, async () => {
      const idempotency = createApiIdempotencyIdentity({
        actorUserId: input.principal.userId,
        operation: `task.bulk:${input.workspaceId}`,
        key: input.idempotencyKey,
        payload: { taskIds: [...input.taskIds].sort(), action: input.action },
      });
      const applied = await this.database.transaction(
        async (tx) => {
          await lockApiIdempotency(tx, idempotency);
          const replay = await loadApiIdempotency(tx, idempotency);
          if (replay !== null) {
            // Same payload hash means the same batch already landed. The set is
            // recomputed rather than stored: it is derived from live
            // authorization, so replaying an old snapshot could report access
            // the caller has since lost.
            assertIdempotencyPayload(replay, idempotency);
            // Nothing was written by THIS call, so nothing is claimed as
            // affected; `allowed` is still recomputed from live authorization.
            return 0;
          }
          const affected = await this.applyBulk(tx, allowed, input);
          for (const taskId of allowed) {
            await this.recordMutation(tx, "bulk", taskId, input);
          }
          await storeApiIdempotency(tx, idempotency, randomUUID());
          return affected;
        },
        { isolationLevel: "serializable" },
      );
      return Object.freeze({
        updated: Object.freeze([...allowed]),
        skipped: Object.freeze(skipped),
        affected: applied,
      });
    });
  }

  // ------------------------------------------------------------------------ //
  // Authorization helpers
  // ------------------------------------------------------------------------ //

  private authorizeListScope(input: ListTasksServiceInput): Promise<AuthorizedOperation> {
    if (input.noteId !== undefined) {
      return this.authorizationEntry.authorizeUser({
        principal: input.principal,
        workspaceId: input.workspaceId,
        action: "note.read",
        resource: { kind: "note", id: input.noteId },
        requestId: input.requestId,
      });
    }
    if (input.projectId !== undefined) {
      return this.authorizationEntry.authorizeUser({
        principal: input.principal,
        workspaceId: input.workspaceId,
        action: "project.read",
        resource: { kind: "project", id: input.projectId },
        requestId: input.requestId,
      });
    }
    return this.authorizationEntry.authorizeUser({
      principal: input.principal,
      workspaceId: input.workspaceId,
      action: "workspace.read",
      resource: { kind: "workspace" },
      requestId: input.requestId,
    });
  }

  private authorizeTask(
    input: TaskSelector,
    action: "task.read" | "task.update" | "task.delete" | "task.tag",
  ): Promise<AuthorizedOperation> {
    return this.authorizationEntry.authorizeUser({
      principal: input.principal,
      workspaceId: input.workspaceId,
      action,
      resource: { kind: "task", id: input.taskId },
      requestId: input.requestId,
    });
  }

  /** Destination authority by specificity: parent task, then project, then workspace. */
  private authorizeCreateDestination(
    input: ScopedInput,
    group: TaskGroup,
  ): Promise<AuthorizedOperation> {
    return this.authorizationEntry.authorizeUser({
      principal: input.principal,
      workspaceId: input.workspaceId,
      action: "task.create",
      resource:
        group.parentId !== null
          ? { kind: "task", id: group.parentId }
          : group.projectId !== null
            ? { kind: "project", id: group.projectId }
            : { kind: "workspace" },
      requestId: input.requestId,
    });
  }

  private bulkAction(
    action: BulkTaskAction,
  ): "task.update" | "task.assign" | "task.tag" | "task.delete" {
    switch (action.kind) {
      case "assign":
        return "task.assign";
      case "tag":
        return "task.tag";
      case "delete":
        return "task.delete";
      default:
        return "task.update";
    }
  }

  // ------------------------------------------------------------------------ //
  // Query construction
  // ------------------------------------------------------------------------ //

  private async listConditions(input: ListTasksServiceInput): Promise<SQL[]> {
    const conditions: SQL[] = [
      whereWorkspace(tasks, this.tenantContext),
      await this.projectVisibility(input.principal.userId),
    ];
    if (input.noteId !== undefined) conditions.push(eq(tasks.noteId, input.noteId));
    if (input.projectId !== undefined) conditions.push(eq(tasks.projectId, input.projectId));
    if (input.parentId !== undefined) conditions.push(eq(tasks.parentId, input.parentId));
    if (input.assigneeId !== undefined) conditions.push(eq(tasks.assigneeId, input.assigneeId));
    if (input.status !== undefined) conditions.push(eq(tasks.status, input.status));
    if (input.priority !== undefined) conditions.push(eq(tasks.priority, input.priority));
    if (input.dueFrom !== undefined) conditions.push(gte(tasks.dueDate, new Date(input.dueFrom)));
    if (input.dueTo !== undefined) conditions.push(lte(tasks.dueDate, new Date(input.dueTo)));
    if (input.isCompleted !== undefined) {
      conditions.push(input.isCompleted ? isNotNull(tasks.completedAt) : isNull(tasks.completedAt));
    }
    if (input.tagId !== undefined) {
      conditions.push(
        exists(
          this.database.db
            .select({ taskId: taskTags.taskId })
            .from(taskTags)
            .innerJoin(tags, eq(tags.id, taskTags.tagId))
            .where(
              and(
                eq(taskTags.taskId, tasks.id),
                eq(taskTags.tagId, input.tagId),
                whereWorkspace(tags, this.tenantContext),
              ),
            ),
        ),
      );
    }
    return conditions;
  }

  /**
   * `sortOrder asc, id asc` is the base and the tiebreak, so a page boundary is
   * never ambiguous. `grouping` only adds a LEADING key: keeping a group's rows
   * contiguous is a server ordering concern, while drawing the group headers
   * stays a client one, so `TaskPage` needs no nested shape.
   */
  private listOrder(input: ListTasksServiceInput): SQL[] {
    const column =
      input.sortBy === "title"
        ? tasks.title
        : input.sortBy === "createdAt"
          ? tasks.createdAt
          : input.sortBy === "updatedAt"
            ? tasks.updatedAt
            : input.sortBy === "dueDate"
              ? tasks.dueDate
              : input.sortBy === "priority"
                ? tasks.priority
                : tasks.sortOrder;
    const grouped =
      input.grouping === "status"
        ? [asc(tasks.status)]
        : input.grouping === "priority"
          ? [asc(tasks.priority)]
          : input.grouping === "assignee"
            ? [asc(tasks.assigneeId)]
            : input.grouping === "dueDate"
              ? [asc(tasks.dueDate)]
              : [];
    const directed = input.sortDirection === "asc" ? asc(column) : desc(column);
    return input.sortBy === "sortOrder"
      ? [...grouped, directed, asc(tasks.id)]
      : [...grouped, directed, asc(tasks.sortOrder), asc(tasks.id)];
  }

  /**
   * Restricted-project visibility for the task table. Deliberately duplicated
   * from `NotesService` rather than shared: the join column differs
   * (`tasks.projectId` vs `notes.projectId`), and a "generic" version would
   * either take a column parameter nobody can audit at a glance or leak a
   * private across module boundaries.
   */
  private async projectVisibility(userId: string): Promise<SQL> {
    const [membership] = await this.database.db
      .select({ role: workspaceMembers.role })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.userId, userId),
          whereWorkspace(workspaceMembers, this.tenantContext),
        ),
      )
      .limit(1);
    if (membership === undefined) this.notFound();
    if (membership.role === "owner" || membership.role === "admin") return sql`true`;
    const actorGrant = this.database.db
      .select({ id: projectAccess.id })
      .from(projectAccess)
      .where(and(eq(projectAccess.projectId, tasks.projectId), eq(projectAccess.userId, userId)));
    const visibleProject = this.database.db
      .select({ id: projects.id })
      .from(projects)
      .where(
        and(
          eq(projects.id, tasks.projectId),
          whereWorkspace(projects, this.tenantContext),
          or(eq(projects.isRestricted, false), exists(actorGrant)),
        ),
      );
    return or(isNull(tasks.projectId), exists(visibleProject)) as SQL;
  }

  // ------------------------------------------------------------------------ //
  // Invariants
  // ------------------------------------------------------------------------ //

  /**
   * Note, project and parent must all be in-workspace AND mutually consistent.
   * The note check is what stops a task from hiding in a restricted project it
   * never names: a note belonging to project P forces `projectId = P`, so the
   * create authorization above routes through that project.
   */
  private async validateGroup(
    tx: DatabaseTransaction,
    group: TaskGroup,
    movingTaskId: string | null,
  ): Promise<void> {
    if (group.projectId !== null) {
      const [project] = await tx
        .select({ id: projects.id, status: projects.status })
        .from(projects)
        .where(and(eq(projects.id, group.projectId), whereWorkspace(projects, this.tenantContext)))
        .limit(1);
      if (project === undefined || project.status === "archived") this.notFound();
    }
    if (group.noteId !== null) {
      const [note] = await tx
        .select({ id: notes.id, projectId: notes.projectId, isDeleted: notes.isDeleted })
        .from(notes)
        .where(and(eq(notes.id, group.noteId), whereWorkspace(notes, this.tenantContext)))
        .limit(1);
      if (note === undefined || note.isDeleted || note.projectId !== group.projectId) {
        this.notFound();
      }
    }
    if (group.parentId !== null) {
      if (group.parentId === movingTaskId) this.invalidHierarchy();
      const parent = await this.readRow(tx, group.parentId);
      if (parent.projectId !== group.projectId || parent.noteId !== group.noteId) this.notFound();
    }
  }

  private async assertNoCycle(
    tx: DatabaseTransaction,
    taskId: string,
    parentId: string | null,
  ): Promise<void> {
    const seen = new Set<string>();
    let cursor = parentId;
    while (cursor !== null) {
      if (cursor === taskId || seen.has(cursor)) this.invalidHierarchy();
      seen.add(cursor);
      cursor = (await this.readRow(tx, cursor)).parentId;
    }
  }

  private async assertTags(tx: DatabaseTransaction, tagIds: readonly string[]): Promise<void> {
    if (tagIds.length === 0) return;
    const rows = await tx
      .select({ id: tags.id })
      .from(tags)
      .where(and(inArray(tags.id, [...tagIds]), whereWorkspace(tags, this.tenantContext)));
    if (rows.length !== tagIds.length) this.notFound();
  }

  /** An assignee outside the workspace is concealed as 404, never reported as 403. */
  /**
   * Whether a user is still a member of the active workspace. A null assignee
   * is vacuously valid — "unassigned" is always a legal state.
   */
  private async isActiveMember(
    tx: DatabaseTransaction,
    assigneeId: string | null,
  ): Promise<boolean> {
    if (assigneeId === null) return true;
    const [member] = await tx
      .select({ id: workspaceMembers.id })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.userId, assigneeId),
          whereWorkspace(workspaceMembers, this.tenantContext),
        ),
      )
      .limit(1);
    return member !== undefined;
  }

  private async assertAssignee(tx: DatabaseTransaction, assigneeId: string | null): Promise<void> {
    if (!(await this.isActiveMember(tx, assigneeId))) this.notFound();
  }

  /**
   * A workspace-wide status (`project_id IS NULL`) fits any task; a
   * project-scoped one fits only tasks in that project.
   */
  private async assertCustomStatus(
    tx: DatabaseTransaction,
    customStatusId: string | null,
    projectId: string | null,
  ): Promise<void> {
    if (customStatusId === null) return;
    const [status] = await tx
      .select({ projectId: taskStatuses.projectId })
      .from(taskStatuses)
      .where(
        and(eq(taskStatuses.id, customStatusId), whereWorkspace(taskStatuses, this.tenantContext)),
      )
      .limit(1);
    if (status === undefined) this.notFound();
    if (status.projectId !== null && status.projectId !== projectId) this.notFound();
  }

  private requireCron(cron: string | null): string {
    if (cron === null) this.invalidRecurrence();
    return cron;
  }

  private effectiveCron(
    input: UpdateTaskServiceInput,
    current: TaskRow,
    recurrence: TaskRecurrence,
  ): string | null {
    const candidate =
      input.recurrenceCron !== undefined
        ? input.recurrenceCron
        : input.recurrence !== undefined
          ? null
          : current.recurrenceCron;
    if (recurrence !== "custom") return null;
    const cron = this.requireCron(candidate);
    assertCron(cron);
    return cron;
  }

  // ------------------------------------------------------------------------ //
  // Recurrence
  // ------------------------------------------------------------------------ //

  /**
   * Recurring completion is SYNCHRONOUS, inside the completing transaction. A
   * background job was considered and rejected: no `job_outbox` consumer exists
   * yet, so the next occurrence would simply never appear, and the Plan's
   * verification wants an observable result the client can render immediately.
   */
  private async spawnNextOccurrence(
    tx: DatabaseTransaction,
    completed: TaskRow,
    plan: {
      readonly recurrence: TaskRecurrence;
      readonly recurrenceCron: string | null;
      readonly dueDate: Date;
      readonly tagIds: readonly string[];
      readonly input: ScopedInput;
    },
  ): Promise<TaskSummary | null> {
    const { recurrence, recurrenceCron, dueDate, tagIds, input } = plan;
    // `new Date()` is the completion instant: a task ticked long after it was
    // due spawns its next occurrence in the future, never an already-overdue
    // one the user would have to tick repeatedly to catch up.
    const next = nextOccurrence(recurrence, recurrenceCron, dueDate, new Date());
    if (next === null) return null;
    const spawnedId = randomUUID();
    const group = this.groupOf(completed);
    // The successor is inserted at a midpoint between the completed task and
    // its next sibling, which is exactly the read-then-place sequence `create`
    // and `move` serialize behind the group advisory lock. Completing two
    // recurring siblings concurrently without it lets both read the same
    // neighbour and compute the same midpoint.
    await this.lockGroups(tx, [group]);
    const [after] = await tx
      .select({ sortOrder: tasks.sortOrder })
      .from(tasks)
      .where(
        and(
          whereWorkspace(tasks, this.tenantContext),
          ...this.groupConditions(group),
          gt(tasks.sortOrder, completed.sortOrder),
        ),
      )
      .orderBy(asc(tasks.sortOrder))
      .limit(1);
    const sortOrder =
      after === undefined ? completed.sortOrder + 1 : (completed.sortOrder + after.sortOrder) / 2;
    // The assignee is copied forward, but membership may have lapsed since the
    // task was first assigned. Dropping the assignee is the right failure here:
    // refusing the completion would strand the user on a task they finished,
    // and carrying a non-member forward would assign work to someone who can no
    // longer see the workspace.
    const assigneeId = (await this.isActiveMember(tx, completed.assigneeId))
      ? completed.assigneeId
      : null;
    await tx.insert(tasks).values(
      assertWorkspaceInsertValues(
        {
          id: spawnedId,
          workspaceId: activeWorkspaceId(this.tenantContext),
          projectId: group.projectId,
          noteId: group.noteId,
          parentId: group.parentId,
          title: completed.title,
          description: completed.description,
          status: "todo" as const,
          customStatusId: completed.customStatusId,
          priority: completed.priority,
          assigneeId,
          dueDate: next,
          completedAt: null,
          sortOrder,
          recurrence,
          recurrenceCron,
          createdById: input.principal.userId,
          updatedById: input.principal.userId,
        },
        this.tenantContext,
        "task.recurrence",
      ),
    );
    await this.replaceTags(tx, spawnedId, tagIds);
    await this.recordMutation(tx, "create", spawnedId, input);
    const row = await this.readRow(tx, spawnedId);
    const labels = await this.loadStatusLabels(tx, [row.customStatusId]);
    return this.toSummary(row, tagIds, this.labelFor(row, labels));
  }

  // ------------------------------------------------------------------------ //
  // Ordering
  // ------------------------------------------------------------------------ //

  private async lockGroups(tx: DatabaseTransaction, groups: readonly TaskGroup[]): Promise<void> {
    const keys = [...new Set(groups.map((group) => this.groupKey(group)))].sort();
    for (const key of keys) {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
    }
  }

  private async positionFor(
    tx: DatabaseTransaction,
    group: TaskGroup,
    beforeTaskId: string | null,
    excludedTaskId: string | null,
  ): Promise<number> {
    let siblings = await this.loadSiblings(tx, group, excludedTaskId);
    if (this.requiresRenormalization(siblings)) siblings = await this.renormalize(tx, siblings);
    let position = this.calculatePosition(siblings, beforeTaskId);
    if (
      !Number.isFinite(position) ||
      Math.abs(position) > Number.MAX_SAFE_INTEGER / 4 ||
      this.gapExhausted(siblings, beforeTaskId, position)
    ) {
      siblings = await this.renormalize(tx, siblings);
      position = this.calculatePosition(siblings, beforeTaskId);
    }
    if (!Number.isFinite(position)) this.orderConflict();
    return position;
  }

  private async loadSiblings(
    tx: DatabaseTransaction,
    group: TaskGroup,
    excludedTaskId: string | null,
  ): Promise<Sibling[]> {
    const rows = await tx
      .select({ id: tasks.id, sortOrder: tasks.sortOrder })
      .from(tasks)
      .where(and(whereWorkspace(tasks, this.tenantContext), ...this.groupConditions(group)))
      .orderBy(asc(tasks.sortOrder), asc(tasks.id));
    return excludedTaskId === null ? rows : rows.filter((row) => row.id !== excludedTaskId);
  }

  private calculatePosition(siblings: readonly Sibling[], beforeTaskId: string | null): number {
    if (beforeTaskId !== null) {
      const index = siblings.findIndex((row) => row.id === beforeTaskId);
      // The anchor is gone from this group — moved, deleted, or never here.
      // That is a concurrent-edit conflict the client should retry, and it
      // answers identically for a foreign identifier, so it leaks nothing.
      if (index < 0) this.orderConflict();
      if (index === 0) return siblings[0]!.sortOrder - 1;
      return (siblings[index - 1]!.sortOrder + siblings[index]!.sortOrder) / 2;
    }
    if (siblings.length === 0) return 1;
    return siblings[siblings.length - 1]!.sortOrder + 1;
  }

  private gapExhausted(
    siblings: readonly Sibling[],
    beforeTaskId: string | null,
    position: number,
  ): boolean {
    if (beforeTaskId === null || siblings.length === 0)
      return position === siblings.at(-1)?.sortOrder;
    const index = siblings.findIndex((row) => row.id === beforeTaskId);
    if (index <= 0) return position === siblings[0]?.sortOrder;
    return position === siblings[index - 1]?.sortOrder || position === siblings[index]?.sortOrder;
  }

  private requiresRenormalization(rows: readonly Sibling[]): boolean {
    const values = new Set<number>();
    for (const row of rows) {
      if (!Number.isFinite(row.sortOrder) || values.has(row.sortOrder)) return true;
      values.add(row.sortOrder);
    }
    return false;
  }

  private async renormalize(tx: DatabaseTransaction, rows: readonly Sibling[]): Promise<Sibling[]> {
    const normalized: Sibling[] = [];
    for (const [index, row] of rows.entries()) {
      const sortOrder = index + 1;
      if (row.sortOrder !== sortOrder) {
        // `updatedAt` is deliberately left alone. Renumbering is bookkeeping
        // forced on a sibling by someone else's insert, not an edit to it, and
        // bumping the timestamp would push every untouched sibling to the top
        // of "recently updated" the first time a gap runs out.
        await tx
          .update(tasks)
          .set({ sortOrder })
          .where(and(eq(tasks.id, row.id), whereWorkspace(tasks, this.tenantContext)));
      }
      normalized.push({ id: row.id, sortOrder });
    }
    return normalized;
  }

  private groupConditions(group: TaskGroup): SQL[] {
    return [
      group.projectId === null ? isNull(tasks.projectId) : eq(tasks.projectId, group.projectId),
      group.noteId === null ? isNull(tasks.noteId) : eq(tasks.noteId, group.noteId),
      group.parentId === null ? isNull(tasks.parentId) : eq(tasks.parentId, group.parentId),
    ];
  }

  private groupKey(group: TaskGroup): string {
    return [
      activeWorkspaceId(this.tenantContext),
      group.projectId ?? "root",
      group.noteId ?? "unlinked",
      group.parentId ?? "top",
    ].join("|");
  }

  private groupOf(row: TaskRow): TaskGroup {
    return { projectId: row.projectId, noteId: row.noteId, parentId: row.parentId };
  }

  // ------------------------------------------------------------------------ //
  // Bulk application
  // ------------------------------------------------------------------------ //

  /** Returns the number of rows written or destroyed, cascaded subtasks included. */
  private async applyBulk(
    tx: DatabaseTransaction,
    allowed: readonly string[],
    input: BulkTaskServiceInput,
  ): Promise<number> {
    const scope = and(inArray(tasks.id, [...allowed]), whereWorkspace(tasks, this.tenantContext));
    const audit = { updatedAt: new Date(), updatedById: input.principal.userId };
    switch (input.action.kind) {
      case "status": {
        const done = input.action.status === "done";
        await tx
          .update(tasks)
          .set({
            ...audit,
            status: input.action.status,
            // Preserves the original completion instant on a re-apply and
            // clears it the moment the task leaves `done`.
            completedAt: done ? sql`coalesce(${tasks.completedAt}, now())` : null,
          })
          .where(scope);
        return allowed.length;
      }
      case "priority":
        await tx
          .update(tasks)
          .set({ ...audit, priority: input.action.priority })
          .where(scope);
        return allowed.length;
      case "assign":
        await this.assertAssignee(tx, input.action.assigneeId);
        await tx
          .update(tasks)
          .set({ ...audit, assigneeId: input.action.assigneeId })
          .where(scope);
        return allowed.length;
      case "tag": {
        await this.assertTags(tx, input.action.tagIds);
        for (const taskId of allowed) {
          await this.replaceTags(tx, taskId, input.action.tagIds);
        }
        await tx.update(tasks).set(audit).where(scope);
        return allowed.length;
      }
      case "delete": {
        // Counted BEFORE the delete: the self-FK cascade removes descendants
        // that `DELETE ... RETURNING` would never report, so a caller told only
        // `allowed.length` would understate what it just destroyed.
        const destroyed = await this.subtreeIds(tx, allowed);
        await tx.delete(tasks).where(scope);
        return destroyed.length;
      }
    }
  }

  // ------------------------------------------------------------------------ //
  // Rows and projections
  // ------------------------------------------------------------------------ //

  private taskSelection() {
    return {
      id: tasks.id,
      workspaceId: tasks.workspaceId,
      projectId: tasks.projectId,
      noteId: tasks.noteId,
      parentId: tasks.parentId,
      title: tasks.title,
      description: tasks.description,
      status: tasks.status,
      customStatusId: tasks.customStatusId,
      priority: tasks.priority,
      assigneeId: tasks.assigneeId,
      dueDate: tasks.dueDate,
      completedAt: tasks.completedAt,
      sortOrder: tasks.sortOrder,
      recurrence: tasks.recurrence,
      recurrenceCron: tasks.recurrenceCron,
      createdById: tasks.createdById,
      updatedById: tasks.updatedById,
      createdAt: tasks.createdAt,
      updatedAt: tasks.updatedAt,
    };
  }

  private async readRow(
    db: DatabaseService["db"] | DatabaseTransaction,
    taskId: string,
  ): Promise<TaskRow> {
    const [row] = await db
      .select(this.taskSelection())
      .from(tasks)
      .where(and(eq(tasks.id, taskId), whereWorkspace(tasks, this.tenantContext)))
      .limit(1);
    if (row === undefined) this.notFound();
    return row;
  }

  private async readIdempotentTask(tx: DatabaseTransaction, taskId: string): Promise<TaskRow> {
    try {
      return await this.readRow(tx, taskId);
    } catch (error: unknown) {
      if (error instanceof ApiHttpException && error.getStatus() === HttpStatus.NOT_FOUND) {
        throw new ApiHttpException(HttpStatus.CONFLICT, {
          code: "IDEMPOTENT_RESULT_UNAVAILABLE",
          message: "The idempotent task result is no longer available.",
        });
      }
      throw error;
    }
  }

  /**
   * Walks the workspace's `(id, parentId)` pairs in memory, mirroring
   * `NotesService.noteSubtreeRows`.
   *
   * ponytail: O(tasks in workspace) per delete. A recursive CTE would be
   * O(subtree); swap it in when a workspace holds enough tasks for the scan to
   * show up in the delete latency.
   */
  /**
   * Every id in the subtrees rooted at `rootIds`, the roots included, as a
   * union — selecting both a parent and one of its children counts the child
   * once, not twice. The single workspace-scoped read is shared across roots so
   * a hundred-id bulk delete still costs one query, not a hundred.
   */
  private async subtreeIds(tx: DatabaseTransaction, rootIds: readonly string[]): Promise<string[]> {
    const rows = await tx
      .select({ id: tasks.id, parentId: tasks.parentId })
      .from(tasks)
      .where(whereWorkspace(tasks, this.tenantContext));
    const children = new Map<string, string[]>();
    for (const row of rows) {
      if (row.parentId === null) continue;
      children.set(row.parentId, [...(children.get(row.parentId) ?? []), row.id]);
    }
    const union = new Set<string>();
    for (const rootId of rootIds) {
      // Per-root, so revisiting a node reached from a *different* root is a
      // legitimate overlap rather than a cycle.
      const seen = new Set<string>();
      const stack = [rootId];
      while (stack.length > 0) {
        const id = stack.pop()!;
        if (seen.has(id)) this.invalidHierarchy();
        seen.add(id);
        union.add(id);
        stack.push(...(children.get(id) ?? []));
      }
    }
    return [...union];
  }

  private async replaceTags(
    tx: DatabaseTransaction,
    taskId: string,
    tagIds: readonly string[],
  ): Promise<void> {
    await tx.delete(taskTags).where(eq(taskTags.taskId, taskId));
    if (tagIds.length > 0) {
      await tx.insert(taskTags).values(tagIds.map((tagId) => ({ taskId, tagId })));
    }
  }

  private async loadTagIds(
    db: DatabaseService["db"] | DatabaseTransaction,
    taskId: string,
  ): Promise<string[]> {
    return (await this.loadTagMap(db, [taskId])).get(taskId) ?? [];
  }

  private async loadTagMap(
    db: DatabaseService["db"] | DatabaseTransaction,
    taskIds: readonly string[],
  ): Promise<Map<string, string[]>> {
    const result = new Map<string, string[]>();
    if (taskIds.length === 0) return result;
    const rows = await db
      .select({ taskId: taskTags.taskId, tagId: taskTags.tagId })
      .from(taskTags)
      .innerJoin(tags, eq(tags.id, taskTags.tagId))
      .where(and(inArray(taskTags.taskId, [...taskIds]), whereWorkspace(tags, this.tenantContext)))
      .orderBy(asc(taskTags.taskId), asc(taskTags.tagId));
    for (const row of rows) {
      result.set(row.taskId, [...(result.get(row.taskId) ?? []), row.tagId]);
    }
    return result;
  }

  private async loadStatusLabels(
    db: DatabaseService["db"] | DatabaseTransaction,
    statusIds: readonly (string | null)[],
  ): Promise<Map<string, string>> {
    const ids = [...new Set(statusIds.filter((id): id is string => id !== null))];
    const result = new Map<string, string>();
    if (ids.length === 0) return result;
    const rows = await db
      .select({ id: taskStatuses.id, name: taskStatuses.name })
      .from(taskStatuses)
      .where(and(inArray(taskStatuses.id, ids), whereWorkspace(taskStatuses, this.tenantContext)));
    for (const row of rows) result.set(row.id, row.name);
    return result;
  }

  private labelFor(row: TaskRow, labels: ReadonlyMap<string, string>): string | null {
    return row.customStatusId === null ? null : (labels.get(row.customStatusId) ?? null);
  }

  private async toDetail(row: TaskRow): Promise<TaskDetail> {
    const [tagIds, labels] = await Promise.all([
      this.loadTagIds(this.database.db, row.id),
      this.loadStatusLabels(this.database.db, [row.customStatusId]),
    ]);
    return Object.freeze({
      ...this.toSummary(row, tagIds, this.labelFor(row, labels)),
      description: row.description,
      createdById: row.createdById,
      updatedById: row.updatedById,
    });
  }

  private toSummary(
    row: TaskRow,
    tagIds: readonly string[],
    statusLabel: string | null,
  ): TaskSummary {
    return Object.freeze({
      id: row.id,
      workspaceId: row.workspaceId,
      projectId: row.projectId,
      noteId: row.noteId,
      parentId: row.parentId,
      title: row.title,
      status: row.status,
      customStatusId: row.customStatusId,
      statusLabel,
      priority: row.priority,
      assigneeId: row.assigneeId,
      dueDate: row.dueDate?.toISOString() ?? null,
      completedAt: row.completedAt?.toISOString() ?? null,
      sortOrder: row.sortOrder,
      recurrence: row.recurrence,
      recurrenceCron: row.recurrenceCron,
      tagIds: Object.freeze([...tagIds]),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    });
  }

  private toDate(value: string | null): Date | null {
    return value === null ? null : new Date(value);
  }

  // ------------------------------------------------------------------------ //
  // Audit / events / errors
  // ------------------------------------------------------------------------ //

  /**
   * Structured audit plus a transactional outbox intent. Only identifiers are
   * recorded — never the title, description, or any tag/assignee names.
   */
  private async recordMutation(
    tx: DatabaseTransaction,
    mutation: TaskMutation,
    entityId: string,
    input: ScopedInput,
  ): Promise<void> {
    const eventName = TASK_DOMAIN_EVENTS[mutation];
    await tx.insert(auditLogs).values({
      workspaceId: activeWorkspaceId(this.tenantContext),
      userId: input.principal.userId,
      action: eventName,
      entityType: TASK_AUDIT_ENTITY_TYPE,
      entityId,
      metadata: {},
      requestId: input.requestId ?? null,
    });
    const intentId = randomUUID();
    const payload: JobOutboxPayload = Object.freeze({
      action: eventName,
      intentId,
      workspaceId: activeWorkspaceId(this.tenantContext),
      resourceIds: Object.freeze([entityId]),
      actorId: input.principal.userId,
    });
    await tx.insert(jobOutbox).values({
      id: intentId,
      workspaceId: activeWorkspaceId(this.tenantContext),
      queueName: TASK_DOMAIN_EVENT_QUEUE,
      jobType: eventName,
      payloadVersion: TASK_DOMAIN_EVENT_PAYLOAD_VERSION,
      payload,
      payloadHash: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
      idempotencyKey: `${TASK_DOMAIN_EVENT_IDEMPOTENCY_PREFIX}${eventName}:${entityId}:${intentId}`,
      correlationId: input.requestId ?? null,
    });
  }

  private orderConflict(): never {
    throw new ApiHttpException(HttpStatus.CONFLICT, {
      code: "ORDER_CONFLICT",
      message: "The task order changed. Retry.",
    });
  }

  private invalidHierarchy(): never {
    throw new ApiHttpException(HttpStatus.BAD_REQUEST, {
      code: "TASK_HIERARCHY_INVALID",
      message: "The requested task hierarchy is invalid.",
    });
  }

  private invalidRecurrence(): never {
    throw new ApiHttpException(HttpStatus.UNPROCESSABLE_ENTITY, {
      code: "TASK_RECURRENCE_INVALID",
      message: "The recurrence schedule is not a valid cron expression.",
    });
  }

  private notFound(): never {
    throw new ApiHttpException(HttpStatus.NOT_FOUND, {
      code: "NOT_FOUND",
      message: "The requested resource was not found.",
    });
  }
}
