import "reflect-metadata";

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  applyGlobalPrefix,
  buildOpenApiDocument,
  discoverRoutes,
} from "../src/openapi/openapi.builder";
import { OPENAPI_ROUTES } from "../src/openapi/openapi.routes";

// Needs no database, no Redis, and no environment: the builder reads decorator
// metadata and committed Zod schemas only.
const COMMITTED_PATH = resolve(__dirname, "../../../docs/openapi.json");

const document = buildOpenApiDocument();
const paths = document.paths as Record<string, Record<string, Record<string, unknown>>>;
const components = document.components as {
  readonly schemas: Record<string, unknown>;
  readonly securitySchemes: Record<string, Record<string, unknown>>;
};

function operations(): { method: string; path: string; operation: Record<string, unknown> }[] {
  return Object.entries(paths).flatMap(([path, methods]) =>
    Object.entries(methods).map(([method, operation]) => ({ method, path, operation })),
  );
}

/** Every property name reachable from a JSON Schema node, following `$ref`s. */
function reachableProperties(node: unknown, seen: Set<string>, out: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) reachableProperties(item, seen, out);
    return;
  }
  if (typeof node !== "object" || node === null) return;

  for (const [key, value] of Object.entries(node)) {
    if (key === "$ref" && typeof value === "string") {
      const name = value.slice(value.lastIndexOf("/") + 1);
      if (seen.has(name)) continue;
      seen.add(name);
      reachableProperties(components.schemas[name], seen, out);
      continue;
    }
    if (key === "properties" && typeof value === "object" && value !== null) {
      for (const property of Object.keys(value)) out.add(property);
    }
    reachableProperties(value, seen, out);
  }
}

function responseProperties(operation: Record<string, unknown>): Set<string> {
  const responses = operation.responses as Record<string, { content?: unknown }> | undefined;
  const out = new Set<string>();
  reachableProperties(responses?.["2XX"]?.content, new Set<string>(), out);
  return out;
}

describe("OpenAPI route inventory", () => {
  const discovered = discoverRoutes();

  it("documents every route Nest actually registers", () => {
    const undocumented = discovered.filter((route) => !(route.key in OPENAPI_ROUTES));
    expect(undocumented.map((route) => route.key)).toEqual([]);
  });

  it("has no documented route that no controller serves", () => {
    const keys = new Set(discovered.map((route) => route.key));
    const orphaned = Object.keys(OPENAPI_ROUTES).filter((key) => !keys.has(key));
    expect(orphaned).toEqual([]);
  });

  it("emits one operation per discovered route under the global prefix", () => {
    const emitted = new Set(
      operations().map(({ method, path }) => `${method.toUpperCase()} ${path}`),
    );
    const expected = new Set(
      discovered.map((route) => `${route.method} ${applyGlobalPrefix(route.path)}`),
    );
    expect(emitted).toEqual(expected);
  });
});

describe("committed docs/openapi.json", () => {
  it("matches what the current code builds", () => {
    const committed: unknown = JSON.parse(readFileSync(COMMITTED_PATH, "utf8"));
    // Fails whenever a route, schema, or description changes without a
    // `pnpm --filter @notted/api openapi:generate`.
    expect(committed).toEqual(JSON.parse(JSON.stringify(document)));
  });
});

describe("API key security scheme", () => {
  it("declares an HTTP bearer scheme for the workspace API key", () => {
    expect(components.securitySchemes.apiKey).toMatchObject({
      type: "http",
      scheme: "bearer",
      bearerFormat: "ntd_pk_*",
    });
    expect(document.security).toEqual([{ apiKey: [] }]);
  });

  it("leaves the API key applicable to every workspace-scoped route", () => {
    const notScoped = operations()
      .filter(({ path }) => path.startsWith("/api/v1/workspaces/"))
      .filter(({ operation }) => operation.security !== undefined)
      .map(({ method, path }) => `${method.toUpperCase()} ${path}`);
    expect(notScoped).toEqual([]);
  });

  it("opts session-only routes out of the API key rather than promising it works", () => {
    const stillPromised = operations()
      .filter(({ path }) => !path.startsWith("/api/v1/workspaces/"))
      .filter(({ operation }) => operation.security === undefined)
      .map(({ method, path }) => `${method.toUpperCase()} ${path}`);
    expect(stillPromised).toEqual([]);
  });
});

describe("credential secret exposure", () => {
  it("never documents a stored credential hash or ciphertext anywhere in the document", () => {
    const serialized = JSON.stringify(document);
    expect(serialized).not.toContain("keyHash");
    // Part 66. The webhook signing secret is stored as an encrypted blob; the
    // column and its key version must never reach a documented response shape.
    expect(serialized).not.toContain("encryptedSecret");
    expect(serialized).not.toContain("encryptionKeyVersion");
  });

  /**
   * THE ALLOW-LIST IS THE POINT. Every route named here hands a caller a raw
   * credential exactly once and can never hand it back; adding a route to this
   * list is a deliberate security decision, and a route arriving here by
   * accident is the leak this test exists to catch.
   *
   * Part 65 added API-key creation. Part 66 adds webhook creation and webhook
   * secret rotation: rotation is a second minting event, so unlike an API key
   * the same endpoint can legitimately issue a fresh secret more than once.
   */
  it("returns a secret only from the routes that mint one", () => {
    const exposing = operations()
      .filter(({ operation }) => responseProperties(operation).has("secret"))
      .map(({ method, path }) => `${method.toUpperCase()} ${path}`)
      .sort();
    expect(exposing).toEqual([
      "POST /api/v1/workspaces/{workspaceId}/api-keys",
      "POST /api/v1/workspaces/{workspaceId}/webhooks",
      "POST /api/v1/workspaces/{workspaceId}/webhooks/{webhookId}/rotate-secret",
    ]);
  });
});
