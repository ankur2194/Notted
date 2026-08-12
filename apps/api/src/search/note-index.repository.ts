import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { z } from "zod";

import { StructuredLogger } from "../common/logging/structured-logger.service";
import { MEILISEARCH_CONFIG, type MeilisearchConfig } from "../config/meilisearch.config";
import { MeilisearchService } from "../infrastructure/meilisearch/meilisearch.service";

import {
  NOTE_INDEX_PRIMARY_KEY,
  NOTE_INDEX_SETTINGS,
  noteIndexDocumentSchema,
  noteIndexUid,
  type NoteIndexDocument,
} from "./note-index.document";

const documentIdSchema = z.string().uuid();
const pageRequestSchema = z
  .object({
    offset: z.number().int().nonnegative(),
    limit: z.number().int().min(1).max(1_000),
  })
  .strict();
const documentIdPageSchema = z
  .object({
    results: z.array(z.object({ id: documentIdSchema }).strict()).readonly(),
    offset: z.number().int().nonnegative(),
    limit: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  })
  .strict();
const documentReferencePageSchema = z
  .object({
    results: z
      .array(z.object({ id: documentIdSchema, workspaceId: documentIdSchema }).strict())
      .readonly(),
    offset: z.number().int().nonnegative(),
    limit: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  })
  .strict();

export interface NoteIndexDocumentIdPage {
  readonly ids: readonly string[];
  readonly offset: number;
  readonly limit: number;
  readonly total: number;
}

export interface NoteIndexDocumentReferencePage {
  readonly documents: readonly { readonly id: string; readonly workspaceId: string }[];
  readonly offset: number;
  readonly limit: number;
  readonly total: number;
}

@Injectable()
export class NoteIndexRepository implements OnModuleInit {
  readonly indexUid: string;

  constructor(
    @Inject(MEILISEARCH_CONFIG) config: MeilisearchConfig,
    @Inject(MeilisearchService) private readonly meilisearch: MeilisearchService,
    @Inject(StructuredLogger) private readonly logger: StructuredLogger,
  ) {
    this.indexUid = noteIndexUid(config.indexPrefix);
  }

  async onModuleInit(): Promise<void> {
    if (!this.meilisearch.isEnabled()) {
      return;
    }
    try {
      await this.ensureIndex();
    } catch {
      this.logger.failure(
        { dependency: "meilisearch", status: "down", durationMs: 0, reason: "index_setup" },
        "Search index setup failed",
      );
    }
  }

  async ensureIndex(): Promise<void> {
    await this.meilisearch.ensureIndex(this.indexUid, NOTE_INDEX_PRIMARY_KEY);
    await this.meilisearch.updateIndexSettings(this.indexUid, NOTE_INDEX_SETTINGS);
  }

  async addDocuments(documents: readonly NoteIndexDocument[]): Promise<void> {
    await this.meilisearch.addDocuments(this.indexUid, parseDocuments(documents));
  }

  async updateDocuments(documents: readonly NoteIndexDocument[]): Promise<void> {
    await this.meilisearch.updateDocuments(this.indexUid, parseDocuments(documents));
  }

  async deleteDocuments(documentIds: readonly string[]): Promise<void> {
    const parsedIds = parseDocumentIds(documentIds);
    if (parsedIds.length === 0) {
      return;
    }
    await this.meilisearch.deleteDocuments(this.indexUid, parsedIds);
  }

  async deleteWorkspaceDocuments(workspaceId: string): Promise<void> {
    const parsedWorkspaceId = parseDocumentId(workspaceId);
    await this.meilisearch.deleteDocumentsByFilter(
      this.indexUid,
      `workspaceId = "${parsedWorkspaceId}"`,
    );
  }

  async deleteWorkspaceDocumentsByIds(
    workspaceId: string,
    documentIds: readonly string[],
  ): Promise<void> {
    const parsedWorkspaceId = parseDocumentId(workspaceId);
    const parsedIds = parseDocumentIds(documentIds);
    if (parsedIds.length === 0) return;
    const idList = parsedIds.map((id) => JSON.stringify(id)).join(", ");
    await this.meilisearch.deleteDocumentsByFilter(
      this.indexUid,
      `workspaceId = "${parsedWorkspaceId}" AND id IN [${idList}]`,
    );
  }

  async listDocumentIds(options: {
    readonly offset: number;
    readonly limit: number;
  }): Promise<NoteIndexDocumentIdPage> {
    const parsedOptions = parsePageRequest(options);
    const rawPage = await this.meilisearch.getDocumentsPage(this.indexUid, {
      ...parsedOptions,
      fields: ["id"],
    });
    const page = parseDocumentIdPage(rawPage);
    return {
      ids: page.results.map(({ id }) => id),
      offset: page.offset,
      limit: page.limit,
      total: page.total,
    };
  }

  async listWorkspaceDocumentIds(
    workspaceId: string,
    options: { readonly offset: number; readonly limit: number },
  ): Promise<NoteIndexDocumentIdPage> {
    const parsedWorkspaceId = parseDocumentId(workspaceId);
    const parsedOptions = parsePageRequest(options);
    const rawPage = await this.meilisearch.getDocumentsPage(this.indexUid, {
      ...parsedOptions,
      fields: ["id"],
      // UUID parsing is the escaping boundary: only canonical UUID characters
      // can reach the Meilisearch filter expression.
      filter: `workspaceId = "${parsedWorkspaceId}"`,
    });
    const page = parseDocumentIdPage(rawPage);
    return {
      ids: page.results.map(({ id }) => id),
      offset: page.offset,
      limit: page.limit,
      total: page.total,
    };
  }

  async listDocumentWorkspaceReferences(options: {
    readonly offset: number;
    readonly limit: number;
  }): Promise<NoteIndexDocumentReferencePage> {
    const parsedOptions = parsePageRequest(options);
    const rawPage = await this.meilisearch.getDocumentsPage(this.indexUid, {
      ...parsedOptions,
      fields: ["id", "workspaceId"],
    });
    const page = parseDocumentReferencePage(rawPage);
    return {
      documents: page.results,
      offset: page.offset,
      limit: page.limit,
      total: page.total,
    };
  }
}

function parseDocuments(documents: readonly NoteIndexDocument[]): readonly NoteIndexDocument[] {
  const result = z.array(noteIndexDocumentSchema).min(1).max(1_000).safeParse(documents);
  if (!result.success) {
    throw new Error("Invalid note index documents");
  }
  return result.data;
}

function parseDocumentIds(documentIds: readonly string[]): readonly string[] {
  const result = z.array(documentIdSchema).max(1_000).safeParse(documentIds);
  if (!result.success) {
    throw new Error("Invalid note index document IDs");
  }
  return result.data;
}

function parseDocumentId(documentId: string): string {
  const result = documentIdSchema.safeParse(documentId);
  if (!result.success) {
    throw new Error("Invalid note index document ID");
  }
  return result.data;
}

function parsePageRequest(options: { readonly offset: number; readonly limit: number }) {
  const result = pageRequestSchema.safeParse(options);
  if (!result.success) {
    throw new Error("Invalid note index page request");
  }
  return result.data;
}

function parseDocumentIdPage(page: unknown) {
  const result = documentIdPageSchema.safeParse(page);
  if (!result.success) {
    throw new Error("Invalid note index document ID page");
  }
  return result.data;
}

function parseDocumentReferencePage(page: unknown) {
  const result = documentReferencePageSchema.safeParse(page);
  if (!result.success) {
    throw new Error("Invalid note index document reference page");
  }
  return result.data;
}
