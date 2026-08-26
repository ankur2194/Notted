import { describe, expect, it } from "vitest";
import { z } from "zod";

import { CommentsTrpcRouter } from "../src/comments/comments.trpc";
import { NotesTrpcRouter } from "../src/notes/notes.trpc";
import { OPENAPI_ROUTES } from "../src/openapi/openapi.routes";
import { TagsTrpcRouter } from "../src/tags/tags.trpc";
import { TasksTrpcRouter } from "../src/tasks/tasks.trpc";
import { TrpcRootRouter } from "../src/trpc/trpc-root.service";
import { WorkspacesTrpcRouter } from "../src/workspaces/workspaces.trpc";

import type { ZodType } from "zod";

/**
 * Part 75: REST and tRPC validate the same payloads with the SAME schema object.
 *
 * ADR 0002 says both transports reuse one set of services and one set of Zod
 * contracts. That is currently a convention: nothing fails when a tRPC
 * procedure quietly starts accepting a shape the REST route rejects, and the
 * divergence would only surface as a client that works through one transport
 * and 400s through the other.
 *
 * The check is possible **statically, by reference identity**: a procedure's
 * input parser is a `z.object` whose `data` (or `query`) member IS the exported
 * schema, and `OPENAPI_ROUTES` names the same export for the REST route. So no
 * database, no HTTP, no application boot — the routers are constructed directly
 * with `{} as never` services, which is safe because every constructor only
 * closes over its arguments and the procedure resolvers are never invoked here.
 *
 * **What this proves and what it does not.** It proves the two transports share
 * one *schema*. It proves nothing about runtime behaviour: authorization,
 * tenant scoping, idempotency, and error mapping are equal-or-not for reasons
 * this file cannot see, and are covered by `authorization.integration.test.ts`,
 * `tenant-isolation.test.ts`, and the per-resource integration suites.
 *
 * Verified against @trpc/server 11.18.0: `_def.inputs` and `_def.output` both
 * survive onto built procedures and hold the original schema objects by
 * reference. A tRPC upgrade that erases them fails this file loudly rather than
 * degrading it to a no-op — which is the point.
 *
 * Like `openapi.contract.test.ts`, the inventory is **bidirectional**: the map
 * must name every discovered procedure and name no procedure that is gone, so a
 * new procedure fails the build until somebody classifies it.
 */

/** Where the shared payload schema sits inside a procedure's input object. */
type PayloadLocation =
  /** `z.object({ ...selectors, data: <schema> })` — the mutation shape. */
  | "data"
  /** `z.object({ ...selectors, query: <schema> })` — the list shape. */
  | "query"
  /** The input parser IS the shared schema, with no selector wrapper. */
  | "whole"
  /** Selectors only; the REST counterpart carries no body and no query. */
  | "selectors";

interface ParityEntry {
  /** `"<METHOD> <path>"` in `OPENAPI_ROUTES`, or `null` with no REST twin. */
  readonly route: string | null;
  readonly payload: PayloadLocation;
  /**
   * Set when the two transports deliberately use DIFFERENT payload schemas.
   * The assertion then inverts: the schemas must NOT be identical, so removing
   * the divergence forces this entry to be revisited rather than rotting.
   */
  readonly divergence?: string;
}

/**
 * Every tRPC procedure, classified.
 *
 * Grouped by resource, in router order. Adding a procedure without adding a row
 * here fails `every discovered procedure is classified` below.
 */
const PARITY: Readonly<Record<string, ParityEntry>> = {
  "workspace.create": { route: "POST /workspaces", payload: "whole" },
  "workspace.list": { route: "GET /workspaces", payload: "whole" },
  "workspace.read": { route: "GET /workspaces/{id}", payload: "selectors" },
  "workspace.update": { route: "PATCH /workspaces/{id}", payload: "data" },
  "workspace.delete": { route: "DELETE /workspaces/{id}", payload: "data" },
  "workspace.storageUsage": {
    route: "GET /workspaces/{workspaceId}/storage",
    payload: "selectors",
  },

  "note.list": { route: "GET /workspaces/{workspaceId}/notes", payload: "query" },
  "note.create": { route: "POST /workspaces/{workspaceId}/notes", payload: "data" },
  "note.read": { route: "GET /workspaces/{workspaceId}/notes/{noteId}", payload: "selectors" },
  "note.update": { route: "PATCH /workspaces/{workspaceId}/notes/{noteId}", payload: "data" },
  "note.delete": { route: "DELETE /workspaces/{workspaceId}/notes/{noteId}", payload: "data" },
  "note.move": { route: "POST /workspaces/{workspaceId}/notes/{noteId}/move", payload: "data" },
  "note.copy": { route: "POST /workspaces/{workspaceId}/notes/{noteId}/copy", payload: "data" },
  "note.restore": {
    route: "POST /workspaces/{workspaceId}/notes/{noteId}/restore",
    payload: "data",
  },
  "note.permanentDelete": {
    route: "POST /workspaces/{workspaceId}/notes/{noteId}/permanent-delete",
    payload: "data",
  },
  "note.navigation": { route: "GET /workspaces/{workspaceId}/notes/navigation", payload: "query" },
  "note.versions": {
    route: "GET /workspaces/{workspaceId}/notes/{noteId}/versions",
    payload: "query",
  },
  "note.version": {
    route: "GET /workspaces/{workspaceId}/notes/{noteId}/versions/{versionId}",
    payload: "selectors",
  },
  "note.restoreVersion": {
    route: "POST /workspaces/{workspaceId}/notes/{noteId}/versions/{versionId}/restore",
    payload: "data",
  },

  "folder.list": { route: "GET /workspaces/{workspaceId}/folders", payload: "query" },
  "folder.create": { route: "POST /workspaces/{workspaceId}/folders", payload: "data" },
  "folder.update": { route: "PATCH /workspaces/{workspaceId}/folders/{folderId}", payload: "data" },
  "folder.delete": {
    route: "DELETE /workspaces/{workspaceId}/folders/{folderId}",
    payload: "data",
  },

  "tag.list": { route: "GET /workspaces/{workspaceId}/tags", payload: "query" },
  "tag.create": { route: "POST /workspaces/{workspaceId}/tags", payload: "data" },
  "tag.update": { route: "PATCH /workspaces/{workspaceId}/tags/{tagId}", payload: "data" },
  "tag.delete": { route: "DELETE /workspaces/{workspaceId}/tags/{tagId}", payload: "selectors" },

  "task.list": {
    route: "GET /workspaces/{workspaceId}/tasks",
    payload: "query",
    // `taskListInputSchema` vs `taskListQuerySchema`, documented in
    // `packages/shared-validators/src/task.schema.ts`: tRPC carries JSON, so a
    // caller writes `isCompleted: false` and means the boolean, while the REST
    // form only ever sees the query-string token `"false"`. The tRPC schema is
    // the REST one widened to accept both, so it is strictly more permissive —
    // never less — and nothing that works over REST breaks over tRPC.
    divergence: "JSON booleans vs query-string tokens for isCompleted",
  },
  "task.read": { route: "GET /workspaces/{workspaceId}/tasks/{taskId}", payload: "selectors" },
  "task.create": { route: "POST /workspaces/{workspaceId}/tasks", payload: "data" },
  "task.update": { route: "PATCH /workspaces/{workspaceId}/tasks/{taskId}", payload: "data" },
  "task.delete": { route: "DELETE /workspaces/{workspaceId}/tasks/{taskId}", payload: "selectors" },
  "task.reorder": {
    route: "POST /workspaces/{workspaceId}/tasks/{taskId}/reorder",
    payload: "data",
  },
  "task.bulk": { route: "POST /workspaces/{workspaceId}/tasks/bulk", payload: "data" },

  "comment.list": {
    route: "GET /workspaces/{workspaceId}/notes/{noteId}/comments",
    payload: "query",
  },
  "comment.create": {
    route: "POST /workspaces/{workspaceId}/notes/{noteId}/comments",
    payload: "data",
  },
  "comment.update": {
    route: "PATCH /workspaces/{workspaceId}/notes/{noteId}/comments/{commentId}",
    payload: "data",
  },
  "comment.delete": {
    route: "DELETE /workspaces/{workspaceId}/notes/{noteId}/comments/{commentId}",
    payload: "selectors",
  },
  "comment.setResolution": {
    route: "POST /workspaces/{workspaceId}/notes/{noteId}/comments/{commentId}/resolution",
    payload: "data",
  },
};

interface BuiltProcedure {
  readonly _def: {
    readonly type: "query" | "mutation" | "subscription";
    readonly inputs?: readonly unknown[];
    readonly output?: unknown;
  };
}

function buildProcedures(): Readonly<Record<string, BuiltProcedure>> {
  // The services are never called: only the constructors run, and each one just
  // stores its arguments inside closures the resolvers would use.
  const unused = {} as never;
  const root = new TrpcRootRouter(
    new WorkspacesTrpcRouter(unused, unused, unused),
    new NotesTrpcRouter(unused, unused),
    new TagsTrpcRouter(unused, unused),
    new TasksTrpcRouter(unused, unused),
    new CommentsTrpcRouter(unused, unused),
  );
  const procedures: unknown = (root.router as unknown as { _def: { procedures: unknown } })._def
    .procedures;
  if (typeof procedures !== "object" || procedures === null) {
    throw new Error("tRPC no longer exposes router._def.procedures; this contract cannot run");
  }
  return procedures as Readonly<Record<string, BuiltProcedure>>;
}

const PROCEDURES = buildProcedures();

function inputParser(path: string): ZodType | undefined {
  const inputs = PROCEDURES[path]?._def.inputs;
  if (inputs === undefined) return undefined;
  expect(inputs.length, `${path} composes more than one input parser`).toBeLessThanOrEqual(1);
  return inputs[0] as ZodType | undefined;
}

function inputMember(path: string, key: "data" | "query"): unknown {
  const parser = inputParser(path);
  if (!(parser instanceof z.ZodObject)) return undefined;
  return (parser.shape as Record<string, unknown>)[key];
}

interface RouteDoc {
  readonly body?: ZodType;
  readonly query?: ZodType;
  readonly response?: ZodType;
}

function routeDoc(route: string): RouteDoc {
  const doc = (OPENAPI_ROUTES as Record<string, RouteDoc | undefined>)[route];
  // A throw, not an `expect`, because the caller dereferences the result and
  // `expect(...).toBeDefined()` does not narrow the type.
  if (doc === undefined) throw new Error(`${route} is not documented in OPENAPI_ROUTES`);
  return doc;
}

const entries = Object.entries(PARITY);

describe("tRPC and REST share one set of Zod contracts", () => {
  it("classifies every discovered procedure, and no procedure that is gone", () => {
    // Bidirectional, exactly like openapi.contract.test.ts: a new procedure
    // fails here until it is classified above, and a deleted one fails until
    // its row is removed.
    expect([...Object.keys(PROCEDURES)].sort()).toEqual([...Object.keys(PARITY)].sort());
  });

  it("still finds the tRPC internals this contract reads", () => {
    // If a tRPC upgrade stops carrying the schemas onto built procedures, every
    // assertion below would silently compare `undefined` with `undefined`.
    const probe = PROCEDURES["note.create"];
    if (probe === undefined) throw new Error("note.create disappeared; re-anchor this probe");
    expect(probe._def.inputs, "@trpc/server no longer exposes _def.inputs").toBeDefined();
    expect(probe._def.output, "@trpc/server no longer exposes _def.output").toBeDefined();
  });

  it.each(entries.filter(([, entry]) => entry.route !== null))(
    "%s reuses its REST route's schemas",
    (path, entry) => {
      if (entry.route === null) return;
      const doc = routeDoc(entry.route);

      switch (entry.payload) {
        case "data": {
          expect(doc.body, `${entry.route} documents no request body`).toBeDefined();
          expect(
            inputMember(path, "data"),
            `${path} does not reuse ${entry.route}'s body schema`,
          ).toBe(doc.body);
          break;
        }
        case "query": {
          expect(doc.query, `${entry.route} documents no query schema`).toBeDefined();
          const actual = inputMember(path, "query");
          if (entry.divergence === undefined) {
            expect(actual, `${path} does not reuse ${entry.route}'s query schema`).toBe(doc.query);
          } else {
            // Inverted on purpose: when the divergence is resolved upstream this
            // fails, forcing the note above to be removed rather than left lying.
            expect(
              actual,
              `${path} now matches ${entry.route}; drop its "divergence" note`,
            ).not.toBe(doc.query);
          }
          break;
        }
        case "whole": {
          const shared = doc.body ?? doc.query;
          expect(shared, `${entry.route} documents neither a body nor a query`).toBeDefined();
          expect(inputParser(path), `${path} does not reuse ${entry.route}'s schema`).toBe(shared);
          break;
        }
        case "selectors": {
          expect(doc.body, `${entry.route} grew a body; reclassify ${path}`).toBeUndefined();
          expect(doc.query, `${entry.route} grew a query; reclassify ${path}`).toBeUndefined();
          break;
        }
      }
    },
  );

  it.each(entries.filter(([, entry]) => entry.route !== null))(
    "%s returns its REST route's response schema",
    (path, entry) => {
      if (entry.route === null) return;
      const doc = routeDoc(entry.route);
      expect(doc.response, `${entry.route} documents no response schema`).toBeDefined();
      expect(
        PROCEDURES[path]?._def.output,
        `${path} does not return ${entry.route}'s response schema`,
      ).toBe(doc.response);
    },
  );
});
