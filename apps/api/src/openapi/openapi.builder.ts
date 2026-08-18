import { RequestMethod } from "@nestjs/common";
// `@nestjs/common/constants` is a published entry point of the installed
// package and exports the decorator metadata keys ("path" and "method").
import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import * as validators from "@notted/shared-validators";
import { z } from "zod";

import { AppModule } from "../app.module";

import { OPENAPI_ROUTES, type OpenApiRouteDoc } from "./openapi.routes";

import type { ZodType } from "zod";

/** Mirrors `app.setGlobalPrefix("api/v1", { exclude: [...] })` in `main.ts`. */
const GLOBAL_PREFIX = "/api/v1";
const PREFIX_EXCLUDED = new Set(["/health/live", "/health/ready"]);

const SUPPORTED_VERBS = new Set(["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]);

type JsonObject = Record<string, unknown>;
type Constructor = new (...args: never[]) => object;

export interface DiscoveredRoute {
  /** Uppercase HTTP verb. */
  readonly method: string;
  /** OpenAPI-shaped route without the global prefix, e.g. `/workspaces/{id}`. */
  readonly path: string;
  /** `"<METHOD> <path>"`, the `OPENAPI_ROUTES` key. */
  readonly key: string;
}

function isConstructor(value: unknown): value is Constructor {
  return typeof value === "function";
}

interface ModuleRef {
  readonly type: Constructor;
  readonly host: object;
}

/** Unwraps `forwardRef(() => M)` and dynamic modules down to the module class. */
function resolveModuleRef(entry: unknown): ModuleRef | undefined {
  if (isConstructor(entry)) return { type: entry, host: entry };
  if (typeof entry !== "object" || entry === null) return undefined;
  const record = entry as JsonObject;
  if (typeof record.forwardRef === "function") {
    return resolveModuleRef((record.forwardRef as () => unknown)());
  }
  if (isConstructor(record.module)) return { type: record.module, host: entry };
  return undefined;
}

function moduleMetadata(ref: ModuleRef, key: string): unknown[] {
  const inline = (ref.host as JsonObject)[key];
  if (Array.isArray(inline)) return inline;
  const reflected: unknown = Reflect.getMetadata(key, ref.type);
  return Array.isArray(reflected) ? reflected : [];
}

/** Every controller class reachable from `AppModule`, deduplicated. */
export function collectControllers(root: Constructor = AppModule): Constructor[] {
  const seen = new Set<Constructor>();
  const controllers = new Set<Constructor>();
  const queue: unknown[] = [root];

  while (queue.length > 0) {
    const ref = resolveModuleRef(queue.pop());
    if (ref === undefined || seen.has(ref.type)) continue;
    seen.add(ref.type);
    for (const controller of moduleMetadata(ref, "controllers")) {
      if (isConstructor(controller)) controllers.add(controller);
    }
    queue.push(...moduleMetadata(ref, "imports"));
  }

  return [...controllers];
}

/** `RequestMethod` is a numeric enum, so its reverse mapping is the verb name. */
export function httpVerb(ordinal: number): string {
  const name: unknown = (RequestMethod as unknown as Record<number, string>)[ordinal];
  if (typeof name !== "string" || !SUPPORTED_VERBS.has(name)) {
    throw new Error(`Unsupported RequestMethod ordinal for OpenAPI: ${String(ordinal)}`);
  }
  return name;
}

/** `/notes/:noteId/versions/:versionId` -> `/notes/{noteId}/versions/{versionId}`. */
export function toOpenApiPath(expressPath: string): string {
  const segments = expressPath
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => (segment.startsWith(":") ? `{${segment.slice(1)}}` : segment));
  return `/${segments.join("/")}`;
}

/** Prefixes with `/api/v1` unless `main.ts` excludes the path from the prefix. */
export function applyGlobalPrefix(path: string): string {
  if (PREFIX_EXCLUDED.has(path)) return path;
  return path === "/" ? GLOBAL_PREFIX : `${GLOBAL_PREFIX}${path}`;
}

/**
 * Reads the route inventory straight off Nest's decorator metadata. No Nest
 * application is created and no provider is instantiated, so this needs
 * neither environment variables nor a database — and no route can be silently
 * missing from the document.
 */
export function discoverRoutes(root: Constructor = AppModule): DiscoveredRoute[] {
  const routes: DiscoveredRoute[] = [];

  for (const controller of collectControllers(root)) {
    const basePath: unknown = Reflect.getMetadata(PATH_METADATA, controller);
    const base = typeof basePath === "string" ? basePath : "";
    const prototype = (controller as { readonly prototype: object }).prototype;

    for (const property of Object.getOwnPropertyNames(prototype)) {
      if (property === "constructor") continue;
      const descriptor = Object.getOwnPropertyDescriptor(prototype, property);
      const handler: unknown = descriptor?.value;
      if (typeof handler !== "function") continue;
      const methodPath: unknown = Reflect.getMetadata(PATH_METADATA, handler);
      const ordinal: unknown = Reflect.getMetadata(METHOD_METADATA, handler);
      if (typeof methodPath !== "string" || typeof ordinal !== "number") continue;

      const method = httpVerb(ordinal);
      const path = toOpenApiPath(`${base}/${methodPath}`);
      routes.push({ method, path, key: `${method} ${path}` });
    }
  }

  return routes.sort((left, right) => left.key.localeCompare(right.key));
}

/** `tagPageSchema` -> `TagPage`; `noteDocumentImageAttrs` -> `NoteDocumentImageAttrs`. */
export function componentName(exportName: string): string {
  const stem = exportName.endsWith("Schema") ? exportName.slice(0, -"Schema".length) : exportName;
  return stem.charAt(0).toUpperCase() + stem.slice(1);
}

interface SchemaCatalog {
  readonly names: ReadonlyMap<ZodType, string>;
  readonly components: Readonly<Record<string, JsonObject>>;
}

/**
 * Converts every named schema in `@notted/shared-validators` once, so shared
 * shapes become `$ref`s instead of being inlined at every use site.
 */
function buildSchemaCatalog(): SchemaCatalog {
  const registry = z.registry<{ id: string }>();
  const names = new Map<ZodType, string>();
  const taken = new Map<string, string>();

  for (const [exportName, value] of Object.entries(validators)) {
    if (!(value instanceof z.ZodType)) continue;
    const name = componentName(exportName);
    const clash = taken.get(name);
    if (clash !== undefined) {
      throw new Error(
        `OpenAPI component name collision: ${clash} and ${exportName} both map to ${name}`,
      );
    }
    taken.set(name, exportName);
    names.set(value, name);
    registry.add(value, { id: name });
  }

  const converted = z.toJSONSchema(registry, {
    target: "draft-2020-12",
    io: "input",
    unrepresentable: "any",
    uri: (id: string) => `#/components/schemas/${id}`,
    override: (context) => {
      // The TipTap document schema is deeply recursive and expands to ~99 KB of
      // JSON Schema. Collapse it: the node contract belongs in prose, not here.
      if (context.zodSchema === validators.noteDocumentSchema) {
        for (const key of Object.keys(context.jsonSchema)) {
          delete (context.jsonSchema as unknown as JsonObject)[key];
        }
        Object.assign(context.jsonSchema, {
          type: "object",
          description:
            "TipTap document JSON. See the note document contract in @notted/shared-validators.",
        });
      }
    },
  }).schemas as unknown as Record<string, JsonObject>;

  const components: Record<string, JsonObject> = {};
  for (const [name, schema] of Object.entries(converted)) {
    // `$schema`/`$id` are per-document keywords; OpenAPI components carry neither.
    const component: JsonObject = { ...schema };
    delete component.$schema;
    delete component.$id;
    components[name] = component;
  }

  return { names, components };
}

function schemaRef(catalog: SchemaCatalog, schema: ZodType): JsonObject {
  const name = catalog.names.get(schema);
  if (name === undefined) {
    throw new Error(
      "OPENAPI_ROUTES referenced a schema @notted/shared-validators does not export by name",
    );
  }
  return { $ref: `#/components/schemas/${name}` };
}

function collectRefs(node: unknown, out: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) collectRefs(item, out);
    return;
  }
  if (typeof node !== "object" || node === null) return;
  for (const [key, value] of Object.entries(node)) {
    if (key === "$ref" && typeof value === "string") {
      out.add(value.slice(value.lastIndexOf("/") + 1));
    } else {
      collectRefs(value, out);
    }
  }
}

/** Keeps only the components the documented operations can actually reach. */
function reachableComponents(
  catalog: SchemaCatalog,
  paths: JsonObject,
): Record<string, JsonObject> {
  const pending = new Set<string>();
  collectRefs(paths, pending);

  const kept: Record<string, JsonObject> = {};
  const queue = [...pending];
  while (queue.length > 0) {
    const name = queue.pop();
    if (name === undefined || name in kept) continue;
    const component = catalog.components[name];
    if (component === undefined) continue;
    kept[name] = component;
    const nested = new Set<string>();
    collectRefs(component, nested);
    queue.push(...nested);
  }

  return Object.fromEntries(Object.entries(kept).sort(([a], [b]) => a.localeCompare(b)));
}

const PATH_PARAMETER = /\{([^}]+)\}/gu;

function pathParameters(path: string): JsonObject[] {
  return [...path.matchAll(PATH_PARAMETER)].map(([, name]) => ({
    name,
    in: "path",
    required: true,
    schema: { type: "string" },
  }));
}

function queryParameters(schema: ZodType, path: string): JsonObject[] {
  const converted = z.toJSONSchema(schema, {
    target: "draft-2020-12",
    io: "input",
    unrepresentable: "any",
  }) as unknown as JsonObject;
  const properties = converted.properties;
  if (typeof properties !== "object" || properties === null) return [];
  const required = new Set(Array.isArray(converted.required) ? converted.required : []);
  const fromPath = new Set([...path.matchAll(PATH_PARAMETER)].map(([, name]) => name));

  return (
    Object.entries(properties as Record<string, unknown>)
      // A value the route already carries in its path is not also a query parameter.
      .filter(([name]) => !fromPath.has(name))
      .map(([name, propertySchema]) => ({
        name,
        in: "query",
        required: required.has(name),
        schema: propertySchema,
      }))
  );
}

/** Workspace-scoped routes are the ones an API key can address. */
export function isWorkspaceScoped(path: string): boolean {
  return path.startsWith("/workspaces/");
}

/**
 * A declared schema that arrives as `undefined` means the installed build of
 * `@notted/shared-validators` predates the schema the map imports. Left alone
 * that silently drops a request body or response from the document, so fail
 * loudly instead.
 */
function assertDeclaredSchemas(route: DiscoveredRoute, doc: OpenApiRouteDoc): void {
  for (const part of ["query", "body", "response"] as const) {
    if (part in doc && doc[part] === undefined) {
      throw new Error(
        `OPENAPI_ROUTES["${route.key}"].${part} is undefined. Rebuild @notted/shared-validators.`,
      );
    }
  }
}

function operation(
  catalog: SchemaCatalog,
  route: DiscoveredRoute,
  doc: OpenApiRouteDoc,
): JsonObject {
  assertDeclaredSchemas(route, doc);
  const parameters = [
    ...pathParameters(route.path),
    ...(doc.query === undefined ? [] : queryParameters(doc.query, route.path)),
  ];

  const responseSchema =
    doc.response === undefined
      ? undefined
      : doc.responseIsArray === true
        ? { type: "array", items: schemaRef(catalog, doc.response) }
        : schemaRef(catalog, doc.response);

  return {
    summary: doc.summary,
    tags: [...doc.tags],
    ...(doc.description === undefined ? {} : { description: doc.description }),
    ...(parameters.length === 0 ? {} : { parameters }),
    ...(doc.body === undefined
      ? {}
      : {
          requestBody: {
            required: true,
            content: { "application/json": { schema: schemaRef(catalog, doc.body) } },
          },
        }),
    responses: {
      "2XX": {
        description: doc.summary,
        ...(responseSchema === undefined
          ? {}
          : { content: { "application/json": { schema: responseSchema } } }),
      },
    },
    // Document-level `security` grants the API key everywhere; routes it cannot
    // address opt out explicitly rather than inheriting a false promise.
    ...(isWorkspaceScoped(route.path) ? {} : { security: [] }),
  };
}

export interface OpenApiDocument extends JsonObject {
  readonly openapi: string;
  readonly info: JsonObject;
  readonly paths: JsonObject;
  readonly components: JsonObject;
}

/**
 * Builds the public `/api/v1` OpenAPI document from Nest route metadata and the
 * committed shared Zod schemas. Pure: no I/O, no environment, no database.
 */
export function buildOpenApiDocument(): OpenApiDocument {
  const catalog = buildSchemaCatalog();
  const paths: JsonObject = {};

  for (const route of discoverRoutes()) {
    const doc = OPENAPI_ROUTES[route.key];
    // An undocumented route is a contract-test failure, not a build failure.
    if (doc === undefined) continue;
    const documentedPath = applyGlobalPrefix(route.path);
    const entry = (paths[documentedPath] ??= {}) as JsonObject;
    entry[route.method.toLowerCase()] = operation(catalog, route, doc);
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "Notted API",
      version: "1.0.0",
      description:
        "The versioned public integration surface of Notted. Every path below is served under " +
        "the `/api/v1` prefix and is covered by the compatibility promise of that version. " +
        "tRPC is the first-party transport for the Notted web client only: it is an internal " +
        "implementation detail, is not part of this public contract, and may change without a " +
        "version bump. Workspace-scoped routes accept an API key bearer token; the session-only " +
        "routes declare `security: []` and are reachable with a browser session alone.",
    },
    security: [{ apiKey: [] }],
    paths: Object.fromEntries(Object.entries(paths).sort(([a], [b]) => a.localeCompare(b))),
    components: {
      securitySchemes: {
        apiKey: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "ntd_pk_*",
          description:
            "Workspace API key, sent as `Authorization: Bearer ntd_pk_...`. A key is bound to " +
            "one workspace and carries `read`, `write`, or `admin` scopes; a request is " +
            "authorized only when the key's workspace matches the route's `workspaceId` and its " +
            "scopes cover the action. The secret is returned once, when the key is created.",
        },
      },
      schemas: reachableComponents(catalog, paths),
    },
  };
}
