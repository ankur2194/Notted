import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, gt, inArray } from "drizzle-orm";

import { AI_CONFIG, type AiConfig } from "../config/ai.config";
import { DatabaseService, type DatabaseTransaction } from "../database/database.service";
import { noteEmbeddings, notes } from "../database/schema";
import { TenantContextService, whereWorkspace } from "../tenant";

import { canonicalEmbeddingSource, type CanonicalEmbeddingSource } from "./embedding-source";

export interface AuthoritativeEmbeddingSource extends CanonicalEmbeddingSource {
  readonly noteId: string;
}
export interface EmbeddingMetadata {
  readonly model: string;
  readonly dimensions: number;
  readonly contentHash: string;
}
export interface StaleEmbeddingPage {
  readonly noteIds: readonly string[];
  readonly nextCursor?: string;
}

@Injectable()
export class NoteEmbeddingRepository {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(TenantContextService) private readonly tenantContext: TenantContextService,
    @Inject(AI_CONFIG) private readonly ai: AiConfig,
  ) {}

  async loadSource(noteId: string): Promise<AuthoritativeEmbeddingSource | null> {
    const [row] = await this.database.db
      .select({ id: notes.id, title: notes.title, contentPlain: notes.contentPlain })
      .from(notes)
      .where(
        and(
          eq(notes.id, noteId),
          eq(notes.isDeleted, false),
          whereWorkspace(notes, this.tenantContext),
        ),
      )
      .limit(1);
    return row === undefined
      ? null
      : {
          noteId: row.id,
          ...canonicalEmbeddingSource(
            row.title,
            row.contentPlain,
            this.ai.embeddings.maxSourceCharacters,
          ),
        };
  }

  async metadata(noteId: string): Promise<EmbeddingMetadata | null> {
    const [row] = await this.database.db
      .select({
        model: noteEmbeddings.model,
        dimensions: noteEmbeddings.dimensions,
        contentHash: noteEmbeddings.contentHash,
      })
      .from(noteEmbeddings)
      .innerJoin(
        notes,
        and(eq(notes.id, noteEmbeddings.noteId), whereWorkspace(notes, this.tenantContext)),
      )
      .where(eq(noteEmbeddings.noteId, noteId))
      .limit(1);
    return row ?? null;
  }

  /** Transactional authoritative re-read plus conditional upsert closes the provider-response race. */
  async upsertIfSourceCurrent(input: {
    readonly noteId: string;
    readonly expectedHash: string;
    readonly vector: readonly number[];
    readonly model: string;
    readonly dimensions: 1536;
  }): Promise<boolean> {
    return this.database.transaction(async (tx) => this.upsertCas(tx, input), {
      isolationLevel: "serializable",
    });
  }

  private async upsertCas(
    tx: DatabaseTransaction,
    input: {
      readonly noteId: string;
      readonly expectedHash: string;
      readonly vector: readonly number[];
      readonly model: string;
      readonly dimensions: 1536;
    },
  ): Promise<boolean> {
    const [row] = await tx
      .select({ title: notes.title, contentPlain: notes.contentPlain })
      .from(notes)
      .where(
        and(
          eq(notes.id, input.noteId),
          eq(notes.isDeleted, false),
          whereWorkspace(notes, this.tenantContext),
        ),
      )
      .for("update")
      .limit(1);
    if (
      row === undefined ||
      canonicalEmbeddingSource(row.title, row.contentPlain, this.ai.embeddings.maxSourceCharacters)
        .contentHash !== input.expectedHash
    )
      return false;
    await tx
      .insert(noteEmbeddings)
      .values({
        noteId: input.noteId,
        embedding: [...input.vector],
        model: input.model,
        dimensions: input.dimensions,
        contentHash: input.expectedHash,
      })
      .onConflictDoUpdate({
        target: noteEmbeddings.noteId,
        set: {
          embedding: [...input.vector],
          model: input.model,
          dimensions: input.dimensions,
          contentHash: input.expectedHash,
          createdAt: new Date(),
        },
      });
    return true;
  }

  async stalePage(input: {
    readonly model: string;
    readonly dimensions: number;
    readonly afterId?: string;
    readonly limit: number;
  }): Promise<StaleEmbeddingPage> {
    const limit = Math.min(500, Math.max(1, input.limit));
    const rows = await this.database.db
      .select({
        id: notes.id,
        title: notes.title,
        contentPlain: notes.contentPlain,
        model: noteEmbeddings.model,
        dimensions: noteEmbeddings.dimensions,
        contentHash: noteEmbeddings.contentHash,
      })
      .from(notes)
      .leftJoin(noteEmbeddings, eq(noteEmbeddings.noteId, notes.id))
      .where(
        and(
          eq(notes.isDeleted, false),
          whereWorkspace(notes, this.tenantContext),
          input.afterId === undefined ? undefined : gt(notes.id, input.afterId),
        ),
      )
      .orderBy(asc(notes.id))
      .limit(limit);
    const noteIds = rows
      .filter(
        (row) =>
          row.model !== input.model ||
          row.dimensions !== input.dimensions ||
          row.contentHash !==
            canonicalEmbeddingSource(
              row.title,
              row.contentPlain,
              this.ai.embeddings.maxSourceCharacters,
            ).contentHash,
      )
      .map(({ id }) => id);
    const last = rows.at(-1);
    return Object.freeze({
      noteIds: Object.freeze(noteIds),
      ...(rows.length === limit && last !== undefined ? { nextCursor: last.id } : {}),
    });
  }

  async deleteForWorkspaceNoteIds(noteIds: readonly string[]): Promise<void> {
    if (noteIds.length === 0) return;
    const scoped = this.database.db
      .select({ id: notes.id })
      .from(notes)
      .where(and(inArray(notes.id, [...noteIds]), whereWorkspace(notes, this.tenantContext)));
    await this.database.db.delete(noteEmbeddings).where(inArray(noteEmbeddings.noteId, scoped));
  }
}
