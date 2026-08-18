import "reflect-metadata";

import { Controller, Get, Module, RequestMethod, forwardRef } from "@nestjs/common";
import { describe, expect, it } from "vitest";

import {
  applyGlobalPrefix,
  buildOpenApiDocument,
  collectControllers,
  componentName,
  discoverRoutes,
  httpVerb,
  isWorkspaceScoped,
  toOpenApiPath,
} from "./openapi.builder";

// eslint-disable-next-line @darraghor/nestjs-typed/injectable-should-be-provided -- test fixture: registered in the local WidgetsModule below and never in the application graph
@Controller("widgets")
class WidgetsController {
  @Get(":widgetId")
  read(): string {
    return "widget";
  }
}

@Module({ controllers: [WidgetsController] })
class WidgetsModule {}

@Module({ imports: [forwardRef(() => WidgetsModule)] })
class ForwardRefModule {}

@Module({ imports: [{ module: WidgetsModule, controllers: [WidgetsController] }] })
class DynamicModule {}

describe("toOpenApiPath", () => {
  it("converts express parameters to OpenAPI parameters", () => {
    expect(toOpenApiPath("/notes/:noteId/versions/:versionId")).toBe(
      "/notes/{noteId}/versions/{versionId}",
    );
  });

  it("normalizes empty and doubled separators to a single leading slash", () => {
    expect(toOpenApiPath("/")).toBe("/");
    expect(toOpenApiPath("workspaces//tags/")).toBe("/workspaces/tags");
  });
});

describe("httpVerb", () => {
  it("maps RequestMethod ordinals to their verb", () => {
    expect(httpVerb(RequestMethod.GET)).toBe("GET");
    expect(httpVerb(RequestMethod.POST)).toBe("POST");
    expect(httpVerb(RequestMethod.PUT)).toBe("PUT");
    expect(httpVerb(RequestMethod.DELETE)).toBe("DELETE");
    expect(httpVerb(RequestMethod.PATCH)).toBe("PATCH");
  });

  it("rejects ordinals that cannot be documented as one verb", () => {
    expect(() => httpVerb(RequestMethod.ALL)).toThrow(/Unsupported RequestMethod/u);
    expect(() => httpVerb(-1)).toThrow(/Unsupported RequestMethod/u);
  });
});

describe("applyGlobalPrefix", () => {
  it("prefixes documented routes with the global prefix", () => {
    expect(applyGlobalPrefix("/workspaces/{id}/tags")).toBe("/api/v1/workspaces/{id}/tags");
    expect(applyGlobalPrefix("/")).toBe("/api/v1");
  });

  it("leaves the health probes main.ts excludes from the prefix alone", () => {
    expect(applyGlobalPrefix("/health/live")).toBe("/health/live");
    expect(applyGlobalPrefix("/health/ready")).toBe("/health/ready");
  });
});

describe("componentName", () => {
  it("strips the Schema suffix and pascal-cases the stem", () => {
    expect(componentName("tagPageSchema")).toBe("TagPage");
    expect(componentName("noteDocumentImageAttrs")).toBe("NoteDocumentImageAttrs");
  });
});

describe("isWorkspaceScoped", () => {
  it("treats routes below a workspace as API-key addressable", () => {
    expect(isWorkspaceScoped("/workspaces/{workspaceId}/tags")).toBe(true);
    expect(isWorkspaceScoped("/workspaces/{id}")).toBe(true);
  });

  it("treats collection and session routes as session-only", () => {
    expect(isWorkspaceScoped("/workspaces")).toBe(false);
    expect(isWorkspaceScoped("/auth/session")).toBe(false);
    expect(isWorkspaceScoped("/health/live")).toBe(false);
  });
});

describe("collectControllers", () => {
  it("walks plain, forwardRef, and dynamic module references", () => {
    expect(collectControllers(WidgetsModule)).toEqual([WidgetsController]);
    expect(collectControllers(ForwardRefModule)).toEqual([WidgetsController]);
    expect(collectControllers(DynamicModule)).toEqual([WidgetsController]);
  });

  it("discovers routes from decorator metadata without booting Nest", () => {
    expect(discoverRoutes(WidgetsModule)).toEqual([
      { method: "GET", path: "/widgets/{widgetId}", key: "GET /widgets/{widgetId}" },
    ]);
  });
});

describe("buildOpenApiDocument", () => {
  const document = buildOpenApiDocument();
  const schemas = document.components.schemas as Record<string, Record<string, unknown>>;

  it("collapses the recursive TipTap document schema", () => {
    expect(schemas.NoteDocument).toEqual({
      type: "object",
      description: expect.stringContaining("TipTap document"),
    });
  });

  it("serializes to JSON well under the size the uncollapsed document would reach", () => {
    const serialized = JSON.stringify(document);
    expect(JSON.parse(serialized)).toEqual(document);
    expect(serialized.length).toBeLessThan(500_000);
  });

  it("documents every discovered route exactly once", () => {
    const operations = Object.values(document.paths).flatMap((methods) =>
      Object.keys(methods as Record<string, unknown>),
    );
    expect(operations).toHaveLength(discoverRoutes().length);
  });
});
