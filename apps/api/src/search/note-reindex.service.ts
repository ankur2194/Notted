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
        projected += page.documents.length;
      }
      if (page.documents.length < BATCH_SIZE || page.nextCursor === undefined) break;
      cursor = page.nextCursor;
    }

    /*
     * Reconciliation is streamed one index page at a time.
     *
     * It used to materialise TWO id sets first — every authoritative note id in
     * the workspace, and every indexed document id — and only then compare them.
     * Both are O(notes in the workspace) resident strings held for the whole
     * run, in a command whose entire job is the largest workspaces.
     *
     * Nothing needed them: `loadNoteLiveness` re-proves a page against
     * PostgreSQL immediately before anything is deleted, which is the same
     * protection the old candidate recheck gave notes created mid-scan, and it
     * is the authority — the projection set was only ever a pre-filter.
     */
    let staleDeleted = 0;
    // Two counters on purpose: `offset` is where the next page starts (it moves
    // by the survivors, because deleting shifts later pages back), while
    // `scanned` is how much of the listing has been examined and is what decides
    // when the walk is done.
    let offset = 0;
    let scanned = 0;
    for (;;) {
      const page = await this.noteIndex.listWorkspaceDocumentIds(workspaceId, {
        offset,
        limit: BATCH_SIZE,
      });
      if (page.ids.length === 0) break;
      const liveness = await this.projection.loadNoteLiveness(page.ids);
      const live = new Map(liveness.map(({ id, updatedAt }) => [id, updatedAt]));
      const staleIds = page.ids.filter((id) => !live.has(id));

      // A note that changed after the boundary was outside the projection pass
      // above (it filters `updatedAt <= boundary`), so it is refreshed here
      // rather than left to its incremental job — the property the old
      // "recheck drift candidates" branch provided.
      const drifted = [...live].filter(([, updatedAt]) => updatedAt > boundary).map(([id]) => id);
      if (drifted.length > 0) {
        const documents = await this.projection.loadDocumentsForNoteIds(drifted);
        if (documents.length > 0) await this.noteIndex.updateDocuments(documents);
      }

      if (staleIds.length > 0) {
        await this.noteIndex.deleteDocuments(staleIds);
        staleDeleted += staleIds.length;
        // Close the delete/recreate race. A commit after this read still has its
        // transactional incremental job; an interrupted run is safe to rerun.
        const recreated = await this.projection.loadDocumentsForNoteIds(staleIds);
        if (recreated.length > 0) await this.noteIndex.updateDocuments(recreated);
      }

      // `deleteDocuments` awaits the Meilisearch task before returning, so by
      // now the deleted documents are gone and every later page has shifted
      // back by exactly that many. Anything recreated is appended and re-examined
      // at the end of the walk, which is harmless.
      offset += page.ids.length - staleIds.length;
      scanned += page.ids.length;
      if (scanned >= page.total) break;
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
