import { randomUUID } from "node:crypto";

import { HttpStatus, Injectable } from "@nestjs/common";
import { taskStatusNameSchema } from "@notted/shared-validators";
import { and, asc, eq, isNull, ne, or, sql, type SQL } from "drizzle-orm";

import { recordAudit } from "../audit/audit-record";
import { AuthorizationEntryService } from "../authorization/authorization-entry.service";
import { ApiHttpException } from "../common/errors/api-http.exception";
import {
  assertIdempotencyPayload,
  createApiIdempotencyIdentity,
  loadApiIdempotency,
  lockApiIdempotency,
  storeApiIdempotency,
} from "../common/idempotency/api-idempotency";
import { DatabaseService, type DatabaseTransaction } from "../database/database.service";
import { notes, projects, tasks, taskStatuses } from "../database/schema";
import {
  activeWorkspaceId,
  assertWorkspaceInsertValues,
  TenantContextService,
  whereWorkspace,
} from "../tenant";

import {
  TASK_STATUS_AUDIT_ACTIONS,
  TASK_STATUS_AUDIT_ENTITY_TYPE,
  type TaskStatusMutation,
} from "./tasks.constants";

import type { AuthorizedOperation } from "../authorization/authorization.contracts";
import type {
  AuthenticatedPrincipal,
  CustomTaskStatus,
  CustomTaskStatusList,
  TaskStatusDeleteResult,
  TaskStatusMutationResult,
} from "@notted/shared-types";

interface ScopedInput {
  readonly principal: AuthenticatedPrincipal;
  readonly workspaceId: string;
  readonly requestId?: string | null;
}

interface StatusSelector extends ScopedInput {
  readonly statusId: string;
}

interface StatusRow {
  readonly id: string;
  readonly workspaceId: string;
  readonly projectId: string | null;
  readonly name: string;
  readonly color: string | null;
  readonly sortOrder: number;
  readonly isBuiltIn: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ListTaskStatusesServiceInput extends ScopedInput {
  readonly projectId?: string;
}

export interface CreateTaskStatusServiceInput extends ScopedInput {
  readonly projectId: string | null;
  readonly name: string;
  readonly color?: string;
  readonly idempotencyKey: string;
}

export interface UpdateTaskStatusServiceInput extends StatusSelector {
  readonly name?: string;
  readonly color?: string;
}

/**
 * Custom task statuses — the board columns a workspace defines for itself.
 *
 * Deliberately NOT part of `TasksService`: that file already owns task
 * placement, recurrence and bulk policy, and columns share none of it. The one
 * thing they do share, `task_statuses` row validity, stays where it already
 * lives (`TasksService.assertCustomStatus`).
 *
 * Managing columns is `settings.update`, the existing owner/admin action. No new
 * authorization action and no new resource kind were introduced: a bespoke role
 * comparison here would be a second, untested copy of the permission matrix.
 */
@Injectable()
export class TaskStatusesService {
  constructor(
    private readonly database: DatabaseService,
    private readonly authorizationEntry: AuthorizationEntryService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /**
   * Workspace-wide statuses, plus the named project's own when one is given.
   *
   * Unpaginated: the set is bounded by what an admin will hand-create. Reading
   * is gated by reading the CONTAINER, mirroring `TasksService.list` — naming a
   * project proves `project.read` on it, so a restricted project's column names
   * stay invisible to members who cannot see the project itself.
   */
  async list(input: ListTaskStatusesServiceInput): Promise<CustomTaskStatusList> {
    const operation = await this.authorizeListScope(input);
    return this.authorizationEntry.run(operation, async () => {
      const rows = await this.database.db
        .select(this.statusSelection())
        .from(taskStatuses)
        .where(
          and(
            whereWorkspace(taskStatuses, this.tenantContext),
            input.projectId === undefined
              ? isNull(taskStatuses.projectId)
              : this.visibleScope(input.projectId),
          ),
        )
        .orderBy(asc(taskStatuses.sortOrder), asc(taskStatuses.name));
      return Object.freeze({ items: Object.freeze(rows.map((row) => this.toStatus(row))) });
    });
  }

  async create(input: CreateTaskStatusServiceInput): Promise<TaskStatusMutationResult> {
    const operation = await this.authorizeSettings(input);
    return this.authorizationEntry.run(operation, async () => {
      const name = this.assertName(input.name);
      const statusId = randomUUID();
      const idempotency = createApiIdempotencyIdentity({
        actorUserId: input.principal.userId,
        operation: `taskStatus.create:${input.workspaceId}`,
        key: input.idempotencyKey,
        payload: { projectId: input.projectId, name, color: input.color ?? null },
      });
      const row = await this.database.transaction(
        async (tx) => {
          await lockApiIdempotency(tx, idempotency);
          const replay = await loadApiIdempotency(tx, idempotency);
          if (replay !== null) {
            assertIdempotencyPayload(replay, idempotency);
            return this.readIdempotentStatus(tx, replay.resourceId);
          }
          if (input.projectId !== null) await this.assertProject(tx, input.projectId);
          await this.assertNameFree(tx, input.projectId, name, null);
          const sortOrder = await this.nextSortOrder(tx);
          await tx.insert(taskStatuses).values(
            assertWorkspaceInsertValues(
              {
                id: statusId,
                workspaceId: activeWorkspaceId(this.tenantContext),
                projectId: input.projectId,
                name,
                ...(input.color === undefined ? {} : { color: input.color }),
                sortOrder,
              },
              this.tenantContext,
              "taskStatus.create",
            ),
          );
          await this.recordMutation(tx, "create", statusId, input);
          await storeApiIdempotency(tx, idempotency, statusId);
          return this.readRow(tx, statusId);
        },
        // Serializable, not the `read committed` `TasksService.create` uses: the
        // workspace-level name rule below is a range read followed by an insert
        // that the unique index CANNOT back up (PostgreSQL treats NULL
        // `project_id` values as distinct), so serialization is what stops two
        // concurrent admins from both winning.
        { isolationLevel: "serializable" },
      );
      return Object.freeze({ status: this.toStatus(row) });
    });
  }

  async update(input: UpdateTaskStatusServiceInput): Promise<TaskStatusMutationResult> {
    const operation = await this.authorizeSettings(input);
    return this.authorizationEntry.run(operation, async () => {
      const name = input.name === undefined ? undefined : this.assertName(input.name);
      const row = await this.database.transaction(
        async (tx) => {
          const current = await this.readRow(tx, input.statusId);
          if (name !== undefined && name !== current.name) {
            if (current.isBuiltIn) this.builtInProtected();
            await this.assertNameFree(tx, current.projectId, name, current.id);
          }
          const [updated] = await tx
            .update(taskStatuses)
            .set({
              updatedAt: new Date(),
              ...(name === undefined ? {} : { name }),
              ...(input.color === undefined ? {} : { color: input.color }),
            })
            .where(
              and(
                eq(taskStatuses.id, input.statusId),
                whereWorkspace(taskStatuses, this.tenantContext),
              ),
            )
            .returning(this.statusSelection());
          if (updated === undefined) this.notFound();
          await this.recordMutation(tx, "update", input.statusId, input);
          return updated;
        },
        { isolationLevel: "serializable" },
      );
      return Object.freeze({ status: this.toStatus(row) });
    });
  }

  /**
   * No reassignment step and no destination argument: `tasks.custom_status_id`
   * is `ON DELETE SET NULL`, and a task carrying a custom status never lost its
   * built-in `status`, so every affected task simply falls back to it.
   *
   * A note is NOT the same: `notes.board_column_id` is also `ON DELETE SET
   * NULL`, but a note has no fallback placement, so it silently leaves the
   * board. Both counts are taken first so the client can spell out each
   * consequence before and after the delete.
   */
  async remove(input: StatusSelector): Promise<TaskStatusDeleteResult> {
    const operation = await this.authorizeSettings(input);
    return this.authorizationEntry.run(operation, async () => {
      const counts = await this.database.transaction(
        async (tx) => {
          const current = await this.readRow(tx, input.statusId);
          if (current.isBuiltIn) this.builtInProtected();
          const [usage] = await tx
            .select({ count: sql<number>`cast(count(*) as integer)` })
            .from(tasks)
            .where(
              and(
                eq(tasks.customStatusId, input.statusId),
                whereWorkspace(tasks, this.tenantContext),
              ),
            );
          const [noteUsage] = await tx
            .select({ count: sql<number>`cast(count(*) as integer)` })
            .from(notes)
            .where(
              and(
                eq(notes.boardColumnId, input.statusId),
                whereWorkspace(notes, this.tenantContext),
              ),
            );
          await this.recordMutation(tx, "delete", input.statusId, input);
          const deleted = await tx
            .delete(taskStatuses)
            .where(
              and(
                eq(taskStatuses.id, input.statusId),
                whereWorkspace(taskStatuses, this.tenantContext),
              ),
            )
            .returning({ id: taskStatuses.id });
          if (deleted.length !== 1) this.notFound();
          return { affected: usage?.count ?? 0, affectedNotes: noteUsage?.count ?? 0 };
        },
        { isolationLevel: "serializable" },
      );
      return Object.freeze({ id: input.statusId, deleted: true as const, ...counts });
    });
  }

  // ------------------------------------------------------------------------ //
  // Authorization
  // ------------------------------------------------------------------------ //

  private authorizeListScope(input: ListTaskStatusesServiceInput): Promise<AuthorizedOperation> {
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

  private authorizeSettings(input: ScopedInput): Promise<AuthorizedOperation> {
    return this.authorizationEntry.authorizeUser({
      principal: input.principal,
      workspaceId: input.workspaceId,
      action: "settings.update",
      resource: { kind: "settings" },
      requestId: input.requestId,
    });
  }

  // ------------------------------------------------------------------------ //
  // Validation
  // ------------------------------------------------------------------------ //

  /**
   * Re-parsed with the SHARED schema rather than a second copy of the rule, so
   * the reserved built-in names (`todo`, `in_progress`, `done`, `canceled`,
   * case-insensitive) are rejected identically no matter which transport, job,
   * or test calls the service.
   */
  private assertName(value: string): string {
    const parsed = taskStatusNameSchema.safeParse(value);
    if (!parsed.success) {
      throw new ApiHttpException(HttpStatus.BAD_REQUEST, {
        code: "VALIDATION_ERROR",
        message: "The status name is invalid.",
      });
    }
    return parsed.data;
  }

  /**
   * Name uniqueness INSIDE the transaction, for both scopes.
   *
   * The `(workspace_id, project_id, name)` unique index covers project-scoped
   * rows only: PostgreSQL treats NULL `project_id` values as distinct, so two
   * workspace-wide statuses called "Blocked" would both be accepted. Checking
   * here covers the hole, and covering the project case too keeps a duplicate
   * from surfacing as a driver-level 500 instead of a stated conflict.
   */
  private async assertNameFree(
    tx: DatabaseTransaction,
    projectId: string | null,
    name: string,
    excludeId: string | null,
  ): Promise<void> {
    const [existing] = await tx
      .select({ id: taskStatuses.id })
      .from(taskStatuses)
      .where(
        and(
          whereWorkspace(taskStatuses, this.tenantContext),
          projectId === null
            ? isNull(taskStatuses.projectId)
            : eq(taskStatuses.projectId, projectId),
          eq(taskStatuses.name, name),
          ...(excludeId === null ? [] : [ne(taskStatuses.id, excludeId)]),
        ),
      )
      .limit(1);
    if (existing !== undefined) {
      throw new ApiHttpException(HttpStatus.CONFLICT, {
        code: "CONFLICT",
        message: "A status with that name already exists.",
      });
    }
  }

  private async assertProject(tx: DatabaseTransaction, projectId: string): Promise<void> {
    const [project] = await tx
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, projectId), whereWorkspace(projects, this.tenantContext)))
      .limit(1);
    if (project === undefined) this.notFound();
  }

  // ------------------------------------------------------------------------ //
  // Rows
  // ------------------------------------------------------------------------ //

  /**
   * `max(sort_order) + 1` across the whole workspace, so a new column appends
   * behind everything already visible on any board.
   *
   * ponytail: no reordering endpoint in this part — columns only append. The
   * column is already `double precision`, so inserting between two existing
   * statuses is a midpoint write whenever reordering is wanted, with no
   * migration and no renumbering pass.
   */
  private async nextSortOrder(tx: DatabaseTransaction): Promise<number> {
    const [top] = await tx
      .select({ value: sql<number | null>`max(${taskStatuses.sortOrder})` })
      .from(taskStatuses)
      .where(whereWorkspace(taskStatuses, this.tenantContext));
    return (top?.value ?? 0) + 1;
  }

  /** Workspace-wide statuses plus one project's own. */
  private visibleScope(projectId: string): SQL {
    return or(isNull(taskStatuses.projectId), eq(taskStatuses.projectId, projectId)) as SQL;
  }

  private statusSelection() {
    return {
      id: taskStatuses.id,
      workspaceId: taskStatuses.workspaceId,
      projectId: taskStatuses.projectId,
      name: taskStatuses.name,
      color: taskStatuses.color,
      sortOrder: taskStatuses.sortOrder,
      isBuiltIn: taskStatuses.isBuiltIn,
      createdAt: taskStatuses.createdAt,
      updatedAt: taskStatuses.updatedAt,
    };
  }

  private async readRow(tx: DatabaseTransaction, statusId: string): Promise<StatusRow> {
    const [row] = await tx
      .select(this.statusSelection())
      .from(taskStatuses)
      .where(and(eq(taskStatuses.id, statusId), whereWorkspace(taskStatuses, this.tenantContext)))
      .limit(1);
    if (row === undefined) this.notFound();
    return row;
  }

  private async readIdempotentStatus(
    tx: DatabaseTransaction,
    statusId: string,
  ): Promise<StatusRow> {
    try {
      return await this.readRow(tx, statusId);
    } catch (error: unknown) {
      if (error instanceof ApiHttpException && error.getStatus() === HttpStatus.NOT_FOUND) {
        throw new ApiHttpException(HttpStatus.CONFLICT, {
          code: "IDEMPOTENT_RESULT_UNAVAILABLE",
          message: "The idempotent task status result is no longer available.",
        });
      }
      throw error;
    }
  }

  private toStatus(row: StatusRow): CustomTaskStatus {
    return Object.freeze({
      id: row.id,
      workspaceId: row.workspaceId,
      projectId: row.projectId,
      name: row.name,
      // The column is nullable with a database default; the contract is not.
      color: row.color ?? "#6b7280",
      sortOrder: row.sortOrder,
      isBuiltIn: row.isBuiltIn,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    });
  }

  /**
   * Audit only — no `job_outbox` intent. Nothing consumes a board-column event:
   * statuses are not indexed, not notified on, and not fanned out. An outbox row
   * no worker reads is a queue that only ever grows.
   */
  private async recordMutation(
    tx: DatabaseTransaction,
    mutation: TaskStatusMutation,
    entityId: string,
    input: ScopedInput,
  ): Promise<void> {
    await recordAudit(tx, {
      workspaceId: activeWorkspaceId(this.tenantContext),
      userId: input.principal.userId,
      action: TASK_STATUS_AUDIT_ACTIONS[mutation],
      entityType: TASK_STATUS_AUDIT_ENTITY_TYPE,
      entityId,
      // Deliberately empty: a status NAME is user content and belongs in the
      // row, not in a log line.
      metadata: {},
      requestId: input.requestId ?? null,
    });
  }

  private builtInProtected(): never {
    throw new ApiHttpException(HttpStatus.CONFLICT, {
      code: "CONFLICT",
      message: "Built-in statuses cannot be renamed or removed.",
    });
  }

  private notFound(): never {
    throw new ApiHttpException(HttpStatus.NOT_FOUND, {
      code: "NOT_FOUND",
      message: "The requested resource was not found.",
    });
  }
}
