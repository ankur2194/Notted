import { Inject, Injectable } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";

import { DatabaseService } from "../database/database.service";
import { attachments, noteEmbeddings, notes } from "../database/schema";
import {
  EMBEDDING_DIMENSIONS,
  isUsableEmbeddingVector,
} from "../infrastructure/embeddings/embedding-provider";
import { TenantContextService, whereWorkspace } from "../tenant";

export interface SemanticCandidate {
  readonly id: string;
  readonly similarity: number;
}
export interface SemanticFilters {
  readonly projectId?: string;
  readonly authorId?: string;
  readonly hasAttachments?: boolean;
  readonly createdFrom?: number;
  readonly createdTo?: number;
  readonly updatedFrom?: number;
  readonly updatedTo?: number;
}

@Injectable()
export class SemanticSearchRepository {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(TenantContextService) private readonly tenantContext: TenantContextService,
  ) {}
  async search(input: {
    readonly vector: readonly number[];
    readonly model: string;
    readonly dimensions: number;
    readonly filters: SemanticFilters;
    readonly limit: number;
    readonly offset: number;
  }): Promise<readonly SemanticCandidate[]> {
    if (input.dimensions !== EMBEDDING_DIMENSIONS || !isUsableEmbeddingVector(input.vector))
      throw new Error("embedding_dimension_mismatch");
    const [incompatible] = await this.database.db
      .select({ id: noteEmbeddings.id })
      .from(noteEmbeddings)
      .innerJoin(notes, eq(notes.id, noteEmbeddings.noteId))
      .where(
        and(
          whereWorkspace(notes, this.tenantContext),
          eq(notes.isDeleted, false),
          sql`(${noteEmbeddings.model} <> ${input.model} or ${noteEmbeddings.dimensions} <> ${input.dimensions})`,
        ),
      )
      .limit(1);
    if (incompatible !== undefined) throw new Error("embedding_model_dimension_mismatch");
    const vectorLiteral = `[${input.vector.join(",")}]`;
    const distance = sql<number>`${noteEmbeddings.embedding} <=> ${vectorLiteral}::vector`;
    return this.database.db
      .select({ id: notes.id, similarity: sql<number>`1 - (${distance})` })
      .from(noteEmbeddings)
      .innerJoin(notes, eq(notes.id, noteEmbeddings.noteId))
      .where(
        and(
          // Security boundary is inside the same SQL statement that evaluates <=>.
          whereWorkspace(notes, this.tenantContext),
          eq(notes.isDeleted, false),
          eq(noteEmbeddings.model, input.model),
          eq(noteEmbeddings.dimensions, input.dimensions),
          input.filters.projectId === undefined
            ? undefined
            : eq(notes.projectId, input.filters.projectId),
          input.filters.authorId === undefined
            ? undefined
            : eq(notes.createdById, input.filters.authorId),
          input.filters.hasAttachments === undefined
            ? undefined
            : input.filters.hasAttachments
              ? sql`exists (select 1 from ${attachments} where ${attachments.noteId} = ${notes.id} and ${attachments.workspaceId} = ${this.tenantContext.get().workspaceId} and ${attachments.processingStatus} = 'ready')`
              : sql`not exists (select 1 from ${attachments} where ${attachments.noteId} = ${notes.id} and ${attachments.workspaceId} = ${this.tenantContext.get().workspaceId} and ${attachments.processingStatus} = 'ready')`,
          input.filters.createdFrom === undefined
            ? undefined
            : sql`${notes.createdAt} >= ${new Date(input.filters.createdFrom)}`,
          input.filters.createdTo === undefined
            ? undefined
            : sql`${notes.createdAt} <= ${new Date(input.filters.createdTo)}`,
          input.filters.updatedFrom === undefined
            ? undefined
            : sql`${notes.updatedAt} >= ${new Date(input.filters.updatedFrom)}`,
          input.filters.updatedTo === undefined
            ? undefined
            : sql`${notes.updatedAt} <= ${new Date(input.filters.updatedTo)}`,
        ),
      )
      .orderBy(distance)
      .limit(Math.min(200, Math.max(1, input.limit)))
      .offset(Math.min(10000, Math.max(0, input.offset)));
  }
}
