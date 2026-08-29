/*
 * `AuthorizationRepository` had no unit suite at all.
 *
 * `authorization-http.test.ts` covers the guard and the interceptor and cannot
 * reach any of this, and `test/authorization.integration.test.ts` is DB-gated —
 * so on a developer machine without `DATABASE_URL` nothing exercised the loaders
 * that decide what a caller may see. Four audit findings land in this one file,
 * which is why it gets its own suite rather than an addition elsewhere.
 *
 * The database is a per-table FIFO double, modelled on
 * `storage-maintenance.service.test.ts`. It records the `where` clause each
 * query builds, so a scoping assertion can read the rendered SQL through
 * `PgDialect` — the idiom `queue-outbox.repository.test.ts` already uses. The
 * double deliberately does NOT apply `where`, so an assertion about behaviour
 * proves intent while the SQL assertion is the one that detects a regression;
 * each test says which it is.
 */

import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { TenantContextService, createTenantContext } from "../tenant";

import { AuthorizationRepository } from "./authorization.repository";

import type { DatabaseService } from "../database/database.service";
import type { SQL } from "drizzle-orm";

const WORKSPACE_ID = "10000000-0000-4000-8000-000000000001";
const ACTOR_ID = "10000000-0000-4000-8000-000000000002";
const NOTE_ID = "10000000-0000-4000-8000-000000000003";
const PROJECT_ID = "10000000-0000-4000-8000-000000000004";

type Row = Record<string, unknown>;

/** Query name -> `table:sortedProjectionKeys`, so a test can queue by intent. */
const SELECT_NAMES: Record<string, string> = {
  "notes:creatorId,id,parentId,projectId,workspaceId": "note",
  "note_shares:permission": "noteShare",
  "projects:isRestricted": "project",
  "project_access:role": "projectGrant",
  "notes:id": "scopedDirect",
  "comments:creatorId,id,noteId,parentId": "comment",
  "comments:noteId": "parentComment",
  "workspace_members:userId": "delegationMembership",
};

interface SelectChain {
  innerJoin: () => SelectChain;
  where: (condition: SQL | undefined) => SelectChain;
  limit: () => SelectChain;
  then: (resolve: (rows: readonly Row[]) => unknown) => unknown;
}

function tableName(table: unknown): string {
  const symbols = Object.getOwnPropertySymbols(table);
  for (const symbol of symbols) {
    if (!symbol.description?.includes("Name")) continue;
    const value = (table as Record<symbol, unknown>)[symbol];
    if (typeof value === "string") return value;
  }
  return "unknown";
}

interface Harness {
  readonly repository: AuthorizationRepository;
  readonly wheres: Map<string, SQL | undefined>;
  readonly order: string[];
  /** Highest number of queries in flight at once. 1 means fully serial. */
  readonly peakInFlight: () => number;
}

function harness(selects: Record<string, (readonly Row[])[]>): Harness {
  const queues = new Map<string, (readonly Row[])[]>();
  for (const [name, results] of Object.entries(selects)) queues.set(name, [...results]);

  const wheres = new Map<string, SQL | undefined>();
  const order: string[] = [];
  let inFlight = 0;
  let peak = 0;

  function chain(name: string, rows: readonly Row[]): SelectChain {
    const value: SelectChain = {
      innerJoin: () => value,
      where: (condition) => {
        if (!wheres.has(name)) wheres.set(name, condition);
        return value;
      },
      limit: () => value,
      then: (resolve) => {
        // Resolution is deferred by a microtask so overlapping awaits are
        // observable: `Promise.all` over five loaders shows peak 5, a serial
        // chain shows 1.
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        return Promise.resolve().then(() => {
          inFlight -= 1;
          return resolve(rows);
        });
      },
    };
    return value;
  }

  const db = {
    select: (projection: Readonly<Record<string, unknown>>) => ({
      from: (table: unknown): SelectChain => {
        const signature = `${tableName(table)}:${Object.keys(projection).sort().join(",")}`;
        const name = SELECT_NAMES[signature] ?? signature;
        order.push(name);
        return chain(name, queues.get(name)?.shift() ?? []);
      },
    }),
  };

  const tenant = new TenantContextService();
  const repository = new AuthorizationRepository(
    { db } as unknown as DatabaseService,
    tenant as unknown as TenantContextService,
  );

  return {
    repository: new Proxy(repository, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver) as unknown;
        if (typeof value !== "function") return value;
        // Every call runs inside the tenant context these tests describe.
        return (...args: unknown[]) =>
          tenant.run(createTenantContext({ workspaceId: WORKSPACE_ID, userId: ACTOR_ID }), () =>
            (value as (...inner: unknown[]) => unknown).apply(target, args),
          );
      },
    }),
    wheres,
    order,
    peakInFlight: () => peak,
  };
}

function renderedSql(condition: SQL | undefined): string {
  if (condition === undefined) return "";
  return new PgDialect().sqlToQuery(condition).sql;
}

describe("AuthorizationRepository", () => {
  /*
   * `projectFacts` returned `restricted: true` on a workspace-scoped miss --
   * fail-closed -- but then loaded the actor's `project_access` grant for that
   * raw id with NO workspace predicate, and `projectCanRead` ORs the two. So a
   * miss produced `{ restricted: true, actorAccess: "viewer" }` from the OTHER
   * workspace's grant, and the policy allowed the read.
   *
   * Unreachable in a live database -- the composite FKs make a cross-workspace
   * `project_id` impossible to store -- which is exactly why it can only be
   * proven here, against a double, and why the fix is hardening rather than a
   * patch to an open hole.
   */
  it("fails closed when a project is not in the active workspace", async () => {
    const test = harness({
      note: [
        [
          {
            id: NOTE_ID,
            workspaceId: WORKSPACE_ID,
            projectId: PROJECT_ID,
            parentId: null,
            creatorId: ACTOR_ID,
          },
        ],
      ],
      noteShare: [[]],
      // The workspace-scoped project lookup misses...
      project: [[]],
      // ...while a grant for the same raw id exists in another workspace.
      projectGrant: [[{ role: "viewer" }]],
    });

    const facts = await test.repository.loadResource({ kind: "note", id: NOTE_ID }, ACTOR_ID);

    expect(facts?.project).toEqual({ restricted: true, actorAccess: null });
    // The grant query must not have run at all once the project missed.
    expect(test.order).not.toContain("projectGrant");
  });

  /*
   * `note_shares`, `project_access` and `comments` carry no `workspace_id`, and
   * `tenant/workspace-scope.ts` names all three as tables that must be scoped
   * through a parent join. Each was scoped by parent id alone: correct today,
   * because every caller derives that id from a workspace-scoped row, but the
   * parent-comment probe read a foreign-tenant row before discarding it, and
   * the delegation grant takes a `projectId` this function has not proven.
   *
   * This is the assertion that detects a regression: the double ignores `where`,
   * so only the rendered SQL can show the join is gone.
   */
  it("scopes the note-share lookup through its parent note", async () => {
    const test = harness({
      note: [
        [
          {
            id: NOTE_ID,
            workspaceId: WORKSPACE_ID,
            projectId: null,
            parentId: null,
            creatorId: ACTOR_ID,
          },
        ],
      ],
      noteShare: [[{ permission: "view" }]],
    });

    await test.repository.loadResource({ kind: "note", id: NOTE_ID }, ACTOR_ID);

    expect(renderedSql(test.wheres.get("noteShare"))).toContain('"notes"."workspace_id"');
  });

  it("scopes the parent-comment probe through its note", async () => {
    const test = harness({
      comment: [[{ id: "comment-1", creatorId: ACTOR_ID, noteId: NOTE_ID, parentId: "comment-0" }]],
      note: [
        [
          {
            id: NOTE_ID,
            workspaceId: WORKSPACE_ID,
            projectId: null,
            parentId: null,
            creatorId: ACTOR_ID,
          },
        ],
      ],
      noteShare: [[]],
      parentComment: [[{ noteId: NOTE_ID }]],
    });

    await test.repository.loadResource({ kind: "comment", id: "comment-1" }, ACTOR_ID);

    expect(renderedSql(test.wheres.get("parentComment"))).toContain('"notes"."workspace_id"');
  });

  /*
   * `loadNote` awaited its five independent reads one at a time, so a single
   * authorized note read cost six serial round trips before any data came back
   * -- and `loadComment` nests a whole `loadNote` inside itself on top of that.
   */
  it("issues the independent note loaders together, not one at a time", async () => {
    const test = harness({
      note: [
        [
          {
            id: NOTE_ID,
            workspaceId: WORKSPACE_ID,
            projectId: PROJECT_ID,
            parentId: "parent-1",
            creatorId: ACTOR_ID,
          },
        ],
      ],
      noteShare: [[{ permission: "edit" }]],
      project: [[{ isRestricted: false }]],
      projectGrant: [[]],
      scopedDirect: [[{ id: "parent-1" }]],
    });

    await test.repository.loadResource({ kind: "note", id: NOTE_ID }, ACTOR_ID);

    // Share, parent, project and tag are independent of one another; serial
    // execution shows a peak of 1.
    expect(test.peakInFlight()).toBeGreaterThan(1);
  });
});
