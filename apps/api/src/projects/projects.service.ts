import { createHash, randomUUID } from "node:crypto";

import { HttpStatus, Injectable } from "@nestjs/common";
import { projectCoverImageUrlSchema } from "@notted/shared-validators";
import { and, asc, desc, eq, exists, gte, ilike, lte, notExists, or, type SQL } from "drizzle-orm";

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
import {
  attachments,
  auditLogs,
  jobOutbox,
  type JobOutboxPayload,
  notes,
  projectAccess,
  projects,
  tasks,
  workspaceMembers,
} from "../database/schema";
import {
  activeWorkspaceId,
  assertWorkspaceInsertValues,
  TenantContextService,
  whereWorkspace,
} from "../tenant";

import {
  PROJECT_AUDIT_ACTIONS,
  PROJECT_AUDIT_ENTITY_TYPE,
  PROJECT_DOMAIN_EVENT_IDEMPOTENCY_PREFIX,
  PROJECT_DOMAIN_EVENT_PAYLOAD_VERSION,
  PROJECT_DOMAIN_EVENT_QUEUE,
  PROJECT_DOMAIN_EVENTS,
  type ProjectMutation,
} from "./projects.constants";

import type {
  AuthenticatedPrincipal,
  ProjectCreateResult,
  ProjectDeleteResult,
  ProjectDetail,
  ProjectPage,
  ProjectSortField,
  ProjectStatus,
  ProjectStatusResult,
  ProjectSummary,
  ProjectUpdateResult,
} from "@notted/shared-types";

interface ProjectRow {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly description: string | null;
  readonly coverImageUrl: string | null;
  readonly color: string | null;
  readonly status: ProjectStatus;
  readonly dueDate: Date | null;
  readonly isArchived: boolean;
  readonly createdById: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

interface ScopedInput {
  readonly principal: AuthenticatedPrincipal;
  readonly workspaceId: string;
  readonly requestId?: string | null;
}

export interface ListProjectsInput extends ScopedInput {
  readonly page: number;
  readonly limit: number;
  readonly status?: ProjectStatus;
  readonly archived?: boolean;
  readonly dueFrom?: string;
  readonly dueTo?: string;
  readonly name?: string;
  readonly sortBy: ProjectSortField;
  readonly sortDirection: "asc" | "desc";
}

export interface CreateProjectServiceInput extends ScopedInput {
  readonly name: string;
  readonly description?: string | null;
  readonly coverImageUrl?: string | null;
  readonly color?: string;
  readonly status?: ProjectStatus;
  readonly dueAt?: string | null;
  readonly idempotencyKey?: string;
}

export interface ReadProjectInput extends ScopedInput {
  readonly projectId: string;
}

export interface UpdateProjectServiceInput extends ReadProjectInput {
  readonly name?: string;
  readonly description?: string | null;
  readonly coverImageUrl?: string | null;
  readonly color?: string;
  readonly status?: ProjectStatus;
  readonly dueAt?: string | null;
}

/**
 * Project lifecycle application service. Every workspace operation first
 * enters Part 24 authorization, then performs all tenant-owned SQL inside the
 * authorized Part 19 context. Each mutation commits the business change,
 * append-only audit row, and identifier-only outbox intent atomically.
 */
@Injectable()
export class ProjectsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly authorizationEntry: AuthorizationEntryService,
    private readonly tenantContext: TenantContextService,
  ) {}

  async list(input: ListProjectsInput): Promise<ProjectPage> {
    const operation = await this.authorizationEntry.authorizeUser({
      principal: input.principal,
      workspaceId: input.workspaceId,
      action: "workspace.read",
      resource: { kind: "workspace" },
      requestId: input.requestId,
    });
    return this.authorizationEntry.run(operation, async () => {
      const [membership] = await this.database.db
        .select({ role: workspaceMembers.role })
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.userId, input.principal.userId),
            whereWorkspace(workspaceMembers, this.tenantContext),
          ),
        )
        .limit(1);
      if (membership === undefined) return this.notFound();

      const conditions: SQL[] = [whereWorkspace(projects, this.tenantContext)];
      if (input.status !== undefined) conditions.push(eq(projects.status, input.status));
      if (input.archived !== undefined) conditions.push(eq(projects.isArchived, input.archived));
      if (input.dueFrom !== undefined)
        conditions.push(gte(projects.dueDate, new Date(input.dueFrom)));
      if (input.dueTo !== undefined) conditions.push(lte(projects.dueDate, new Date(input.dueTo)));
      if (input.name !== undefined) {
        const escaped = input.name.replace(/[%_\\]/g, "\\$&");
        conditions.push(ilike(projects.name, `%${escaped}%`));
      }

      // Owner/admin bypass project grants. For editor/viewer, this SQL predicate
      // exactly mirrors Part 24: no access rows = inherited workspace access;
      // one or more rows = restricted and the actor needs an explicit row. The
      // predicate is applied before OFFSET/LIMIT, so inaccessible rows do not
      // occupy pages and no total/count is disclosed.
      if (membership.role !== "owner" && membership.role !== "admin") {
        const anyGrant = this.database.db
          .select({ id: projectAccess.id })
          .from(projectAccess)
          .where(eq(projectAccess.projectId, projects.id));
        const actorGrant = this.database.db
          .select({ id: projectAccess.id })
          .from(projectAccess)
          .where(
            and(
              eq(projectAccess.projectId, projects.id),
              eq(projectAccess.userId, input.principal.userId),
            ),
          );
        conditions.push(or(notExists(anyGrant), exists(actorGrant)) as SQL);
      }

      const sortColumn =
        input.sortBy === "name"
          ? projects.name
          : input.sortBy === "createdAt"
            ? projects.createdAt
            : input.sortBy === "dueAt"
              ? projects.dueDate
              : projects.updatedAt;
      const order = input.sortDirection === "asc" ? asc(sortColumn) : desc(sortColumn);
      const rows = await this.database.db
        .select(this.projectSelection())
        .from(projects)
        .where(and(...conditions))
        .orderBy(order, asc(projects.id))
        .limit(input.limit + 1)
        .offset((input.page - 1) * input.limit);
      return Object.freeze({
        items: Object.freeze(rows.slice(0, input.limit).map((row) => this.toSummary(row))),
        page: input.page,
        limit: input.limit,
        hasMore: rows.length > input.limit,
      });
    });
  }

  async create(input: CreateProjectServiceInput): Promise<ProjectCreateResult> {
    const operation = await this.authorizationEntry.authorizeUser({
      principal: input.principal,
      workspaceId: input.workspaceId,
      action: "project.create",
      resource: { kind: "workspace" },
      requestId: input.requestId,
    });
    return this.authorizationEntry.run(operation, async () => {
      const projectId = randomUUID();
      const status = input.status ?? "active";
      const idempotency = createApiIdempotencyIdentity({
        actorUserId: input.principal.userId,
        operation: `project.create:${input.workspaceId}`,
        key: input.idempotencyKey ?? input.requestId ?? randomUUID(),
        payload: {
          name: input.name,
          description: input.description ?? null,
          coverImageUrl: input.coverImageUrl ?? null,
          color: input.color ?? null,
          status,
          dueAt: input.dueAt ?? null,
        },
      });
      const project = await this.database.transaction(async (tx) => {
        await lockApiIdempotency(tx, idempotency);
        const replay = await loadApiIdempotency(tx, idempotency);
        if (replay !== null) {
          assertIdempotencyPayload(replay, idempotency);
          return this.readIdempotentProject(tx, replay.resourceId);
        }
        await this.assertCoverAttachmentReady(tx, input.coverImageUrl);
        const values = assertWorkspaceInsertValues(
          {
            id: projectId,
            workspaceId: activeWorkspaceId(this.tenantContext),
            name: input.name,
            description: input.description ?? null,
            coverImageUrl: input.coverImageUrl ?? null,
            color: input.color,
            status,
            dueDate:
              input.dueAt === undefined || input.dueAt === null ? null : new Date(input.dueAt),
            isArchived: status === "archived",
            createdById: input.principal.userId,
          },
          this.tenantContext,
          "project.create",
        );
        await tx.insert(projects).values(values);
        await this.recordMutation(tx, "create", projectId, input);
        await storeApiIdempotency(tx, idempotency, projectId);
        return this.readRow(tx, projectId);
      });
      return Object.freeze({ project: Object.freeze(this.toDetail(project)) });
    });
  }

  async read(input: ReadProjectInput): Promise<ProjectDetail> {
    const operation = await this.authorizeProject(input, "project.read");
    return this.authorizationEntry.run(operation, async () =>
      Object.freeze(this.toDetail(await this.readDatabaseRow(input.projectId))),
    );
  }

  async update(input: UpdateProjectServiceInput): Promise<ProjectUpdateResult> {
    const operation = await this.authorizeProject(input, "project.update");
    return this.authorizationEntry.run(operation, async () => {
      const project = await this.database.transaction(async (tx) => {
        await this.readRow(tx, input.projectId);
        await this.assertCoverAttachmentReady(tx, input.coverImageUrl);
        const changes: Partial<typeof projects.$inferInsert> = { updatedAt: new Date() };
        if (input.name !== undefined) changes.name = input.name;
        if (input.description !== undefined) changes.description = input.description;
        if (input.coverImageUrl !== undefined) changes.coverImageUrl = input.coverImageUrl;
        if (input.color !== undefined) changes.color = input.color;
        if (input.dueAt !== undefined)
          changes.dueDate = input.dueAt === null ? null : new Date(input.dueAt);
        if (input.status !== undefined) {
          changes.status = input.status;
          changes.isArchived = input.status === "archived";
        }
        await tx
          .update(projects)
          .set(changes)
          .where(
            and(eq(projects.id, input.projectId), whereWorkspace(projects, this.tenantContext)),
          );
        await this.recordMutation(tx, "update", input.projectId, input, {
          fields: Object.freeze(
            ["name", "description", "coverImageUrl", "color", "status", "dueAt"].filter(
              (field) => input[field as keyof UpdateProjectServiceInput] !== undefined,
            ),
          ),
        });
        return this.readRow(tx, input.projectId);
      });
      return Object.freeze({ project: Object.freeze(this.toDetail(project)) });
    });
  }

  archive(input: ReadProjectInput): Promise<ProjectStatusResult> {
    return this.transition(input, "archive", "archived");
  }

  complete(input: ReadProjectInput): Promise<ProjectStatusResult> {
    return this.transition(input, "complete", "completed");
  }

  restore(input: ReadProjectInput): Promise<ProjectStatusResult> {
    return this.transition(input, "restore", "active");
  }

  async delete(input: ReadProjectInput): Promise<ProjectDeleteResult> {
    const operation = await this.authorizeProject(input, "project.delete");
    return this.authorizationEntry.run(operation, async () => {
      await this.database.transaction(async (tx) => {
        await this.readRow(tx, input.projectId);
        // Both project links use workspace+project NO ACTION composite FKs.
        // Nullify only active-tenant rows first; the notes/tasks survive as
        // standalone rows and unrelated/cross-tenant rows cannot be touched.
        await tx
          .update(notes)
          .set({ projectId: null })
          .where(
            and(eq(notes.projectId, input.projectId), whereWorkspace(notes, this.tenantContext)),
          );
        await tx
          .update(tasks)
          .set({ projectId: null })
          .where(
            and(eq(tasks.projectId, input.projectId), whereWorkspace(tasks, this.tenantContext)),
          );
        await this.recordMutation(tx, "delete", input.projectId, input);
        const deleted = await tx
          .delete(projects)
          .where(
            and(eq(projects.id, input.projectId), whereWorkspace(projects, this.tenantContext)),
          )
          .returning({ id: projects.id });
        if (deleted.length !== 1) return this.notFound();
      });
      return Object.freeze({ id: input.projectId, deleted: true as const });
    });
  }

  private async transition(
    input: ReadProjectInput,
    mutation: "archive" | "complete" | "restore",
    status: ProjectStatus,
  ): Promise<ProjectStatusResult> {
    const operation = await this.authorizeProject(input, "project.update");
    return this.authorizationEntry.run(operation, async () => {
      const project = await this.database.transaction(async (tx) => {
        await this.readRow(tx, input.projectId);
        await tx
          .update(projects)
          .set({ status, isArchived: status === "archived", updatedAt: new Date() })
          .where(
            and(eq(projects.id, input.projectId), whereWorkspace(projects, this.tenantContext)),
          );
        await this.recordMutation(tx, mutation, input.projectId, input, { status });
        return this.readRow(tx, input.projectId);
      });
      return Object.freeze({ project: Object.freeze(this.toDetail(project)) });
    });
  }

  private authorizeProject(
    input: ReadProjectInput,
    action: "project.read" | "project.update" | "project.delete",
  ) {
    return this.authorizationEntry.authorizeUser({
      principal: input.principal,
      workspaceId: input.workspaceId,
      action,
      resource: { kind: "project", id: input.projectId },
      requestId: input.requestId,
    });
  }

  private async readDatabaseRow(projectId: string): Promise<ProjectRow> {
    const [row] = await this.database.db
      .select(this.projectSelection())
      .from(projects)
      .where(and(eq(projects.id, projectId), whereWorkspace(projects, this.tenantContext)))
      .limit(1);
    if (row === undefined) return this.notFound();
    return row;
  }

  private async readRow(tx: DatabaseTransaction, projectId: string): Promise<ProjectRow> {
    const [row] = await tx
      .select(this.projectSelection())
      .from(projects)
      .where(and(eq(projects.id, projectId), whereWorkspace(projects, this.tenantContext)))
      .limit(1);
    if (row === undefined) return this.notFound();
    return row;
  }

  private async readIdempotentProject(
    tx: DatabaseTransaction,
    projectId: string,
  ): Promise<ProjectRow> {
    try {
      return await this.readRow(tx, projectId);
    } catch (error: unknown) {
      if (error instanceof ApiHttpException && error.getStatus() === HttpStatus.NOT_FOUND) {
        throw new ApiHttpException(HttpStatus.CONFLICT, {
          code: "IDEMPOTENT_RESULT_UNAVAILABLE",
          message: "The idempotent project result is no longer available.",
        });
      }
      throw error;
    }
  }

  private projectSelection() {
    return {
      id: projects.id,
      workspaceId: projects.workspaceId,
      name: projects.name,
      description: projects.description,
      coverImageUrl: projects.coverImageUrl,
      color: projects.color,
      status: projects.status,
      dueDate: projects.dueDate,
      isArchived: projects.isArchived,
      createdById: projects.createdById,
      createdAt: projects.createdAt,
      updatedAt: projects.updatedAt,
    };
  }

  private async assertCoverAttachmentReady(
    tx: DatabaseTransaction,
    coverImageUrl: string | null | undefined,
  ): Promise<void> {
    if (coverImageUrl === undefined || coverImageUrl === null) return;
    const parsed = projectCoverImageUrlSchema.safeParse(coverImageUrl);
    if (!parsed.success) {
      throw new ApiHttpException(HttpStatus.BAD_REQUEST, {
        code: "VALIDATION_ERROR",
        message: "The project cover reference is invalid.",
      });
    }
    const prefix = "/api/v1/attachments/";
    const attachmentId = parsed.data.slice(prefix.length);
    const [attachment] = await tx
      .select({ id: attachments.id })
      .from(attachments)
      .where(
        and(
          eq(attachments.id, attachmentId),
          eq(attachments.processingStatus, "ready"),
          whereWorkspace(attachments, this.tenantContext),
        ),
      )
      .limit(1);
    if (attachment === undefined) this.notFound();
  }

  private async recordMutation(
    tx: DatabaseTransaction,
    mutation: ProjectMutation,
    projectId: string,
    input: ScopedInput,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    await tx.insert(auditLogs).values({
      workspaceId: activeWorkspaceId(this.tenantContext),
      userId: input.principal.userId,
      action: PROJECT_AUDIT_ACTIONS[mutation],
      entityType: PROJECT_AUDIT_ENTITY_TYPE,
      entityId: projectId,
      metadata,
      requestId: input.requestId ?? null,
    });

    const intentId = randomUUID();
    const eventName = PROJECT_DOMAIN_EVENTS[mutation];
    const payload: JobOutboxPayload = Object.freeze({
      action: eventName,
      intentId,
      workspaceId: activeWorkspaceId(this.tenantContext),
      resourceIds: Object.freeze([projectId]),
      actorId: input.principal.userId,
    });
    await tx.insert(jobOutbox).values({
      id: intentId,
      workspaceId: activeWorkspaceId(this.tenantContext),
      queueName: PROJECT_DOMAIN_EVENT_QUEUE,
      jobType: eventName,
      payloadVersion: PROJECT_DOMAIN_EVENT_PAYLOAD_VERSION,
      payload,
      payloadHash: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
      idempotencyKey: `${PROJECT_DOMAIN_EVENT_IDEMPOTENCY_PREFIX}${eventName}:${projectId}:${intentId}`,
      correlationId: input.requestId ?? null,
    });
  }

  private toSummary(row: ProjectRow): ProjectSummary {
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      name: row.name,
      description: row.description,
      coverImageUrl: row.coverImageUrl,
      color: row.color ?? "#3b82f6",
      status: row.status,
      isArchived: row.status === "archived",
      dueAt: row.dueDate?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private toDetail(row: ProjectRow): ProjectDetail {
    return { ...this.toSummary(row), createdById: row.createdById };
  }

  private notFound(): never {
    throw new ApiHttpException(HttpStatus.NOT_FOUND, {
      code: "NOT_FOUND",
      message: "The requested resource was not found.",
    });
  }
}
