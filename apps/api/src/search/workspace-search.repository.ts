import { Inject, Injectable } from "@nestjs/common";
import { asc, gt, inArray } from "drizzle-orm";
import { z } from "zod";

import { DatabaseService } from "../database/database.service";
import { workspaces } from "../database/schema";

const workspaceIdSchema = z.string().uuid();
const pageSizeSchema = z.number().int().min(1).max(1_000);

/** Platform-only enumeration of tenancy roots; it never reads tenant content. */
@Injectable()
export class WorkspaceSearchRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async listWorkspaceIdsPage(options: {
    readonly afterId?: string;
    readonly limit: number;
  }): Promise<readonly string[]> {
    const limit = pageSizeSchema.parse(options.limit);
    const afterId =
      options.afterId === undefined ? undefined : workspaceIdSchema.parse(options.afterId);
    const query = this.database.db.select({ id: workspaces.id }).from(workspaces);
    const rows =
      afterId === undefined
        ? await query.orderBy(asc(workspaces.id)).limit(limit)
        : await query.where(gt(workspaces.id, afterId)).orderBy(asc(workspaces.id)).limit(limit);
    return rows.map(({ id }) => workspaceIdSchema.parse(id));
  }

  async existingWorkspaceIds(ids: readonly string[]): Promise<ReadonlySet<string>> {
    const parsed = z
      .array(workspaceIdSchema)
      .min(1)
      .max(1_000)
      .parse([...new Set(ids)]);
    const rows = await this.database.db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(inArray(workspaces.id, parsed));
    return new Set(rows.map(({ id }) => id));
  }
}
