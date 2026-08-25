import { createHash, randomUUID } from "node:crypto";

import { HttpStatus, Injectable } from "@nestjs/common";
import { TAG_DEFAULT_COLOR } from "@notted/shared-validators";
import { and, asc, desc, eq, ilike, sql, type SQL } from "drizzle-orm";

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
import {
  jobOutbox,
  type JobOutboxPayload,
  notes,
  noteTags,
  tags,
  tasks,
  taskTags,
} from "../database/schema";
import { NoteSearchIndexProducer } from "../search/note-search-index-producer";
import {
  activeWorkspaceId,
  assertWorkspaceInsertValues,
  TenantContextService,
  whereWorkspace,
} from "../tenant";
import { isUniqueViolationOnConstraint } from "../workspaces/workspaces.service";

import {
  TAG_AUDIT_ENTITY_TYPE,
  TAG_DOMAIN_EVENT_IDEMPOTENCY_PREFIX,
  TAG_DOMAIN_EVENT_PAYLOAD_VERSION,
  TAG_DOMAIN_EVENT_QUEUE,
  TAG_DOMAIN_EVENTS,
  TAG_MAX_PER_WORKSPACE,
  TAG_NAME_UNIQUE_CONSTRAINT,
  type TagMutation,
} from "./tags.constants";

import type {
  AuthenticatedPrincipal,
  TagCreateResult,
  TagDeleteResult,
  TagPage,
  TagSortField,
  TagSummary,
  TagUpdateResult,
} from "@notted/shared-types";

interface ScopedInput {
  readonly principal: AuthenticatedPrincipal;
  readonly workspaceId: string;
  readonly requestId?: string | null;
}

interface TagRow {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly color: string | null;
  readonly createdAt: Date;
  readonly noteCount: number;
  readonly taskCount: number;
}

export interface ListTagsServiceInput extends ScopedInput {
  readonly page: number;
  readonly limit: number;
  readonly name?: string;
  readonly sortBy: TagSortField;
  readonly sortDirection: "asc" | "desc";
}

export interface CreateTagServiceInput extends ScopedInput {
  readonly name: string;
  readonly color: string;
  readonly idempotencyKey: string;
}

export interface UpdateTagServiceInput extends ScopedInput {
  readonly tagId: string;
  readonly name?: string;
  readonly color?: string;
}

export interface DeleteTagServiceInput extends ScopedInput {
  readonly tagId: string;
}

@Injectable()
export class TagsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly authorizationEntry: AuthorizationEntryService,
    private readonly tenantContext: TenantContextService,
    // Part 51.3 — used to re-sync every note linked to a renamed or deleted
    // tag, since the indexed `tags` field changes for every linked note even
    // when the note row itself is untouched.
    private readonly searchIndexProducer: NoteSearchIndexProducer,
  ) {}

  async list(input: ListTagsServiceInput): Promise<TagPage> {
    const operation = await this.authorizationEntry.authorizeUser({
      principal: input.principal,
      workspaceId: input.workspaceId,
      action: "tag.read",
      resource: { kind: "workspace" },
      requestId: input.requestId,
    });
    return this.authorizationEntry.run(operation, async () => {
      const conditions: SQL[] = [whereWorkspace(tags, this.tenantContext)];
      if (input.name !== undefined) {
        conditions.push(ilike(tags.name, `%${input.name.replace(/[%_\\]/g, "\\$&")}%`));
      }
      // ponytail: usage sort repeats the two count subqueries in ORDER BY
      // rather than referencing the select aliases — PostgreSQL only accepts an
      // output alias standing alone, never inside an expression. Move to a
      // LATERAL join if a workspace ever holds enough tags for it to matter
      // (the cap is TAG_MAX_PER_WORKSPACE).
      const sortExpression =
        input.sortBy === "usage"
          ? sql`${this.noteCount()} + ${this.taskCount()}`
          : input.sortBy === "createdAt"
            ? tags.createdAt
            : tags.name;
      const rows = await this.database.db
        .select(this.tagSelection())
        .from(tags)
        .where(and(...conditions))
        .orderBy(
          input.sortDirection === "asc" ? asc(sortExpression) : desc(sortExpression),
          asc(tags.id),
        )
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

  async create(input: CreateTagServiceInput): Promise<TagCreateResult> {
    const operation = await this.authorizationEntry.authorizeUser({
      principal: input.principal,
      workspaceId: input.workspaceId,
      action: "tag.create",
      resource: { kind: "workspace" },
      requestId: input.requestId,
    });
    return this.authorizationEntry.run(operation, async () => {
      const tagId = randomUUID();
      const idempotency = createApiIdempotencyIdentity({
        actorUserId: input.principal.userId,
        operation: `tag.create:${input.workspaceId}`,
        key: input.idempotencyKey,
        payload: { name: input.name, color: input.color },
      });
      const row = await this.database.transaction(
        async (tx) => {
          await lockApiIdempotency(tx, idempotency);
          const replay = await loadApiIdempotency(tx, idempotency);
          if (replay !== null) {
            assertIdempotencyPayload(replay, idempotency);
            return this.readRow(tx, replay.resourceId);
          }
          await this.assertCapacity(tx);
          await tx
            .insert(tags)
            .values(
              assertWorkspaceInsertValues(
                {
                  id: tagId,
                  workspaceId: activeWorkspaceId(this.tenantContext),
                  name: input.name,
                  color: input.color,
                },
                this.tenantContext,
                "tag.create",
              ),
            )
            .catch((error: unknown) => this.rethrowNameConflict(error));
          await this.recordMutation(tx, "create", tagId, input);
          await storeApiIdempotency(tx, idempotency, tagId);
          return this.readRow(tx, tagId);
        },
        { isolationLevel: "read committed" },
      );
      return Object.freeze({ tag: this.toSummary(row) });
    });
  }

  async update(input: UpdateTagServiceInput): Promise<TagUpdateResult> {
    const operation = await this.authorizationEntry.authorizeUser({
      principal: input.principal,
      workspaceId: input.workspaceId,
      action: "tag.update",
      resource: { kind: "tag", id: input.tagId },
      requestId: input.requestId,
    });
    return this.authorizationEntry.run(operation, async () => {
      const row = await this.database.transaction(async (tx) => {
        // Part 51.3: capture the linked note IDs BEFORE the tag update so the
        // sync intent covers every note whose indexed `tags` field changes.
        // The rename itself does not touch `note_tags`; the index's `tags`
        // field is derived by the projection from `tags.name`, so a rename
        // silently changes the indexed value of every linked note.
        const linkedNoteIds =
          input.name === undefined ? [] : await this.linkedNoteIds(tx, input.tagId);
        const changes: Partial<typeof tags.$inferInsert> = {};
        if (input.name !== undefined) changes.name = input.name;
        if (input.color !== undefined) changes.color = input.color;
        const updated = await tx
          .update(tags)
          .set(changes)
          .where(and(eq(tags.id, input.tagId), whereWorkspace(tags, this.tenantContext)))
          .returning({ id: tags.id })
          .catch((error: unknown) => this.rethrowNameConflict(error));
        if (updated.length === 0) this.notFound();
        await this.recordMutation(tx, "update", input.tagId, input);
        if (linkedNoteIds.length > 0) {
          await this.searchIndexProducer.scheduleSearchSync(tx, input.workspaceId, linkedNoteIds, {
            mutation: TAG_DOMAIN_EVENTS.update,
            correlationId: input.requestId,
            actorId: input.principal.userId,
          });
        }
        return this.readRow(tx, input.tagId);
      });
      return Object.freeze({ tag: this.toSummary(row) });
    });
  }

  async remove(input: DeleteTagServiceInput): Promise<TagDeleteResult> {
    const operation = await this.authorizationEntry.authorizeUser({
      principal: input.principal,
      workspaceId: input.workspaceId,
      action: "tag.delete",
      resource: { kind: "tag", id: input.tagId },
      requestId: input.requestId,
    });
    return this.authorizationEntry.run(operation, async () =>
      this.database.transaction(async (tx) => {
        // Read before delete: the same scoped read both conceals a foreign id as
        // 404 and reports how many note/task assignments the cascade removes.
        const row = await this.readRow(tx, input.tagId);
        // Part 51.3: capture linked note IDs BEFORE the cascade. Tag deletion
        // cascades `note_tags`, after which the IDs cannot be recovered from
        // the junction. Each previously linked note must re-sync because its
        // indexed `tags` field loses this tag's name.
        const linkedNoteIds = await this.linkedNoteIds(tx, input.tagId);
        await tx
          .delete(tags)
          .where(and(eq(tags.id, input.tagId), whereWorkspace(tags, this.tenantContext)));
        await this.recordMutation(tx, "delete", input.tagId, input);
        if (linkedNoteIds.length > 0) {
          await this.searchIndexProducer.scheduleSearchSync(tx, input.workspaceId, linkedNoteIds, {
            mutation: TAG_DOMAIN_EVENTS.delete,
            correlationId: input.requestId,
            actorId: input.principal.userId,
          });
        }
        return Object.freeze({
          tagId: row.id,
          deleted: true as const,
          removedNoteAssignments: row.noteCount,
          removedTaskAssignments: row.taskCount,
        });
      }),
    );
  }

  /**
   * Correlated usage counts, both scoped through the joined parent so a junction
   * row belonging to another tenant can never be counted, and soft-deleted notes
   * are excluded (a trashed note is not a live usage).
   */
  private noteCount(): SQL<number> {
    return sql<number>`(
      select count(*)::int from ${noteTags}
      inner join ${notes} on ${notes.id} = ${noteTags.noteId}
      where ${noteTags.tagId} = ${tags.id}
        and ${notes.isDeleted} = false
        and ${whereWorkspace(notes, this.tenantContext)}
    )`;
  }

  private taskCount(): SQL<number> {
    return sql<number>`(
      select count(*)::int from ${taskTags}
      inner join ${tasks} on ${tasks.id} = ${taskTags.taskId}
      where ${taskTags.tagId} = ${tags.id}
        and ${whereWorkspace(tasks, this.tenantContext)}
    )`;
  }

  private tagSelection() {
    return {
      id: tags.id,
      workspaceId: tags.workspaceId,
      name: tags.name,
      color: tags.color,
      createdAt: tags.createdAt,
      noteCount: this.noteCount(),
      taskCount: this.taskCount(),
    };
  }

  private async readRow(tx: DatabaseTransaction, tagId: string): Promise<TagRow> {
    const [row] = await tx
      .select(this.tagSelection())
      .from(tags)
      .where(and(eq(tags.id, tagId), whereWorkspace(tags, this.tenantContext)))
      .limit(1);
    if (row === undefined) return this.notFound();
    return row;
  }

  /**
   * Part 51.3. The IDs of every live (non-soft-deleted) note linked to `tagId`,
   * scoped through the joined parent so a junction row from another tenant can
   * never appear. Used to fan out `note.search.sync` intents on tag rename and
   * tag delete. Captured BEFORE the cascade so delete-time callers can still
   * read the junction.
   */
  private async linkedNoteIds(tx: DatabaseTransaction, tagId: string): Promise<string[]> {
    const rows = await tx
      .select({ noteId: noteTags.noteId })
      .from(noteTags)
      .innerJoin(notes, eq(notes.id, noteTags.noteId))
      .where(
        and(
          eq(noteTags.tagId, tagId),
          eq(notes.isDeleted, false),
          whereWorkspace(notes, this.tenantContext),
        ),
      );
    return rows.map((row) => row.noteId);
  }

  private async assertCapacity(tx: DatabaseTransaction): Promise<void> {
    const [row] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(tags)
      .where(whereWorkspace(tags, this.tenantContext));
    if ((row?.count ?? 0) >= TAG_MAX_PER_WORKSPACE) {
      throw new ApiHttpException(HttpStatus.CONFLICT, {
        code: "TAG_LIMIT_REACHED",
        message: "This workspace has reached its tag limit.",
      });
    }
  }

  /** A duplicate workspace tag name is a client conflict, never a 500. */
  private rethrowNameConflict(error: unknown): never {
    if (isUniqueViolationOnConstraint(error, TAG_NAME_UNIQUE_CONSTRAINT)) {
      throw new ApiHttpException(HttpStatus.CONFLICT, {
        code: "TAG_NAME_TAKEN",
        message: "A tag with that name already exists in this workspace.",
      });
    }
    throw error;
  }

  private notFound(): never {
    throw new ApiHttpException(HttpStatus.NOT_FOUND, {
      code: "NOT_FOUND",
      message: "The requested resource was not found.",
    });
  }

  private toSummary(row: TagRow): TagSummary {
    return Object.freeze({
      id: row.id,
      workspaceId: row.workspaceId,
      name: row.name,
      color: row.color ?? TAG_DEFAULT_COLOR,
      noteCount: row.noteCount,
      taskCount: row.taskCount,
      createdAt: row.createdAt.toISOString(),
    });
  }

  private async recordMutation(
    tx: DatabaseTransaction,
    mutation: TagMutation,
    entityId: string,
    input: ScopedInput,
  ): Promise<void> {
    const eventName = TAG_DOMAIN_EVENTS[mutation];
    await recordAudit(tx, {
      workspaceId: activeWorkspaceId(this.tenantContext),
      userId: input.principal.userId,
      action: eventName,
      entityType: TAG_AUDIT_ENTITY_TYPE,
      entityId,
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
      queueName: TAG_DOMAIN_EVENT_QUEUE,
      jobType: eventName,
      payloadVersion: TAG_DOMAIN_EVENT_PAYLOAD_VERSION,
      payload,
      payloadHash: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
      idempotencyKey: `${TAG_DOMAIN_EVENT_IDEMPOTENCY_PREFIX}${eventName}:${entityId}:${intentId}`,
      correlationId: input.requestId ?? null,
    });
  }
}
