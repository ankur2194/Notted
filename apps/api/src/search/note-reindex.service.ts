import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";

import { MeilisearchService } from "../infrastructure/meilisearch/meilisearch.service";
import { createTenantContext, TenantContextService } from "../tenant";

import { NoteIndexRepository } from "./note-index.repository";
import { NoteProjectionRepository } from "./note-projection.repository";
import { WorkspaceSearchRepository } from "./workspace-search.repository";

import type { NoteProjectionCursor } from "./note-projection.repository";

const workspaceIdSchema = z.string().uuid();
const BATCH_SIZE = 500;

export interface WorkspaceReindexResult {
  readonly status: "completed" | "disabled";
  readonly workspaceId: string;
  readonly indexUid: string;
  readonly projected: number;
  readonly staleDeleted: number;
}

export interface AllWorkspacesReindexResult {
  readonly status: "completed" | "disabled";
  readonly indexUid: string;
  readonly workspacesReindexed: number;
  readonly projected: number;
  readonly staleDeleted: number;
  readonly orphanWorkspacesPurged: number;
}

/** Rebuilds PostgreSQL-authoritative note projections without resetting an index. */
@Injectable()
export class NoteReindexService {
  constructor(
    @Inject(NoteProjectionRepository) private readonly projection: NoteProjectionRepository,
    @Inject(NoteIndexRepository) private readonly noteIndex: NoteIndexRepository,
    @Inject(WorkspaceSearchRepository) private readonly workspaces: WorkspaceSearchRepository,
    @Inject(MeilisearchService) private readonly meilisearch: MeilisearchService,
    @Inject(TenantContextService) private readonly tenantContext: TenantContextService,
  ) {}

  async reindexWorkspace(workspaceId: string): Promise<WorkspaceReindexResult> {
    const parsedWorkspaceId = workspaceIdSchema.parse(workspaceId);
    if (!this.meilisearch.isEnabled()) {
      return disabledWorkspaceResult(parsedWorkspaceId, this.noteIndex.indexUid);
    }
    return this.tenantContext.run(
      createTenantContext({ workspaceId: parsedWorkspaceId, userId: null }),
      () => this.reindexActiveWorkspace(parsedWorkspaceId),
    );
  }

  /** Explicit platform operation: reindex every authoritative tenancy root, then purge orphans. */
  async reindexAllWorkspaces(): Promise<AllWorkspacesReindexResult> {
    if (!this.meilisearch.isEnabled()) {
      return {
        status: "disabled",
        indexUid: this.noteIndex.indexUid,
        workspacesReindexed: 0,
        projected: 0,
        staleDeleted: 0,
        orphanWorkspacesPurged: 0,
      };
    }
    await this.noteIndex.ensureIndex();
    let afterId: string | undefined;
    let workspacesReindexed = 0;
    let projected = 0;
    let staleDeleted = 0;
    for (;;) {
      const ids = await this.workspaces.listWorkspaceIdsPage({ afterId, limit: BATCH_SIZE });
      for (const workspaceId of ids) {
        const result = await this.tenantContext.run(
          createTenantContext({ workspaceId, userId: null }),
          () => this.reindexActiveWorkspace(workspaceId),
        );
        workspacesReindexed += 1;
        projected += result.projected;
        staleDeleted += result.staleDeleted;
      }
      if (ids.length < BATCH_SIZE) break;
      afterId = ids.at(-1);
    }

    const indexedWorkspaceIds = await this.collectIndexedWorkspaceIds();
    let orphanWorkspacesPurged = 0;
    for (const ids of chunks(indexedWorkspaceIds, BATCH_SIZE)) {
      const existing = await this.workspaces.existingWorkspaceIds(ids);
      for (const workspaceId of ids) {
        if (!existing.has(workspaceId)) {
          await this.noteIndex.deleteWorkspaceDocuments(workspaceId);
          orphanWorkspacesPurged += 1;
        }
      }
    }
    return {
      status: "completed",
      indexUid: this.noteIndex.indexUid,
      workspacesReindexed,
      projected,
      staleDeleted,
      orphanWorkspacesPurged,
    };
  }

  private async reindexActiveWorkspace(workspaceId: string): Promise<WorkspaceReindexResult> {
    // Kept per workspace (including --all) so an interrupted settings rollout
    // is repaired by the next tenant processed or by a rerun.
    await this.noteIndex.ensureIndex();
    const authoritativeIds = new Set<string>();
    const boundary = new Date();
    let cursor: NoteProjectionCursor | undefined;
    let projected = 0;
    for (;;) {
      const page = await this.projection.loadWorkspacePage({
        boundary,
        limit: BATCH_SIZE,
        ...(cursor === undefined ? {} : { after: cursor }),
      });
      if (page.documents.length > 0) {
        await this.noteIndex.updateDocuments(page.documents);
        for (const document of page.documents) authoritativeIds.add(document.id);
        projected += page.documents.length;
      }
      if (page.documents.length < BATCH_SIZE || page.nextCursor === undefined) break;
      cursor = page.nextCursor;
    }

    const indexedIds: string[] = [];
    let offset = 0;
    for (;;) {
      const page = await this.noteIndex.listWorkspaceDocumentIds(workspaceId, {
        offset,
        limit: BATCH_SIZE,
      });
      indexedIds.push(...page.ids);
      offset += page.ids.length;
      if (page.ids.length === 0 || offset >= page.total) break;
    }

    let staleDeleted = 0;
    for (const candidateIds of chunks(
      indexedIds.filter((id) => !authoritativeIds.has(id)),
      BATCH_SIZE,
    )) {
      // Re-prove candidates immediately before deletion. This protects notes
      // created while the projection pages were being scanned.
      const nowLive = await this.projection.loadDocumentsForNoteIds(candidateIds);
      const liveIds = new Set(nowLive.map(({ id }) => id));
      const staleIds = candidateIds.filter((id) => !liveIds.has(id));
      if (nowLive.length > 0) await this.noteIndex.updateDocuments(nowLive);
      if (staleIds.length === 0) continue;
      await this.noteIndex.deleteDocuments(staleIds);
      staleDeleted += staleIds.length;
      // Close the delete/recreate race. A commit after this read still has its
      // transactional incremental job; an interrupted run is safe to rerun.
      const recreated = await this.projection.loadDocumentsForNoteIds(staleIds);
      if (recreated.length > 0) await this.noteIndex.updateDocuments(recreated);
    }
    return {
      status: "completed",
      workspaceId,
      indexUid: this.noteIndex.indexUid,
      projected,
      staleDeleted,
    };
  }

  private async collectIndexedWorkspaceIds(): Promise<readonly string[]> {
    const ids = new Set<string>();
    let offset = 0;
    for (;;) {
      const page = await this.noteIndex.listDocumentWorkspaceReferences({
        offset,
        limit: BATCH_SIZE,
      });
      for (const document of page.documents) ids.add(document.workspaceId);
      offset += page.documents.length;
      if (page.documents.length === 0 || offset >= page.total) break;
    }
    return [...ids];
  }
}

function disabledWorkspaceResult(workspaceId: string, indexUid: string): WorkspaceReindexResult {
  return { status: "disabled", workspaceId, indexUid, projected: 0, staleDeleted: 0 };
}

function chunks<T>(values: readonly T[], size: number): readonly (readonly T[])[] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}
