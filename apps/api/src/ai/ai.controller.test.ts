// Part 67 — transport-level assertions for the AI controller.
//
// The controller itself is thin, so what is worth asserting is the metadata a
// reader cannot see from the method body: that every handler carries an
// authorization spec (a missing one 403s every API-key caller while still
// serving sessions — see the file header on `ai.controller.ts`), that the two
// admin routes pick the right action, and that a malformed body or query is
// refused before the service is reached.

import { RequestMethod } from "@nestjs/common";
import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { AI_API_PATHS } from "@notted/shared-types";
import { describe, expect, it, vi } from "vitest";

import { setAuthPrincipal } from "../auth/auth-principal";
import {
  AUTHORIZATION_HTTP_SPEC,
  type HttpAuthorizationSpec,
} from "../authorization/authorization-http.decorator";
import { RATE_LIMIT_TIER } from "../common/rate-limit/rate-limit.decorator";

import { AiController } from "./ai.controller";

import type { AiStreamService } from "./ai-stream.service";
import type { AiService } from "./ai.service";
import type { MeetingExtractionService } from "./meeting-extraction.service";
import type { AuthService } from "../auth/auth.service";
import type { Request, Response } from "express";

const USER_ID = "a0000000-0000-4000-8000-000000000001";
const WORKSPACE_ID = "a0000000-0000-4000-8100-000000000001";
const API_KEY = "sk-live-000000000000000000000000000";

const validBody = Object.freeze({
  provider: "openai",
  model: "gpt-4o-mini",
  apiKey: API_KEY,
  isEnabled: true,
  dailyTokenQuota: 1_000,
  rateLimitPerMinute: 5,
  contentConsent: true,
});

function request(params: Record<string, string> = { workspaceId: WORKSPACE_ID }): Request {
  const value = {
    params,
    header: () => "https://app.notted.test",
  } as unknown as Request;
  setAuthPrincipal(value, {
    userId: USER_ID,
    sessionId: "session",
    method: "opaque-session",
    assurance: "single-factor",
    authenticatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    isFresh: true,
  });
  return value;
}

function controller(
  service: Partial<AiService>,
  origin = vi.fn(),
  run = vi.fn().mockResolvedValue(undefined),
  meetings: Partial<MeetingExtractionService> = {},
): AiController {
  return new AiController(
    service as AiService,
    {
      assertTrustedMutationOrigin: origin,
    } as unknown as AuthService,
    { run } as unknown as AiStreamService,
    meetings as MeetingExtractionService,
  );
}

/** The streaming routes take `@Res()`; nothing in this file writes to it. */
const responseStub = {} as Response;

const NOTE_ID = "a0000000-0000-4000-8200-000000000001";

function specFor(handler: keyof AiController): HttpAuthorizationSpec {
  const spec: unknown = Reflect.getMetadata(
    AUTHORIZATION_HTTP_SPEC,
    AiController.prototype[handler],
  );
  if (spec === undefined) throw new Error(`missing authorization spec for ${handler}`);
  return spec as HttpAuthorizationSpec;
}

describe("AiController routing and authorization", () => {
  it("publishes the final canonical REST paths under the versioned prefix", () => {
    expect(AI_API_PATHS.config(":workspaceId")).toBe("/api/v1/workspaces/:workspaceId/ai/config");
    expect(AI_API_PATHS.usage(":workspaceId")).toBe("/api/v1/workspaces/:workspaceId/ai/usage");
    expect(AI_API_PATHS.status(":workspaceId")).toBe("/api/v1/workspaces/:workspaceId/ai/status");
    expect(AI_API_PATHS.summarize(":workspaceId")).toBe(
      "/api/v1/workspaces/:workspaceId/ai/summarize",
    );
    expect(AI_API_PATHS.continue(":workspaceId")).toBe(
      "/api/v1/workspaces/:workspaceId/ai/continue",
    );
    expect(AI_API_PATHS.rewrite(":workspaceId")).toBe("/api/v1/workspaces/:workspaceId/ai/rewrite");
    expect(AI_API_PATHS.meetingExtraction(":workspaceId")).toBe(
      "/api/v1/workspaces/:workspaceId/ai/meeting-extraction",
    );
    expect(AI_API_PATHS.tagSuggestions(":workspaceId")).toBe(
      "/api/v1/workspaces/:workspaceId/ai/tag-suggestions",
    );
    expect(Reflect.getMetadata(PATH_METADATA, AiController)).toBe("workspaces/:workspaceId/ai");
  });

  it.each([
    ["getConfig", RequestMethod.GET, "ai.configure"],
    ["updateConfig", RequestMethod.PUT, "ai.configure"],
    ["getUsage", RequestMethod.GET, "ai.configure"],
    // The member-reachable routes; everything else is admin-only.
    ["getStatus", RequestMethod.GET, "ai.use"],
    ["summarize", RequestMethod.POST, "ai.use"],
    ["continueWriting", RequestMethod.POST, "ai.use"],
    ["rewrite", RequestMethod.POST, "ai.use"],
    ["extractMeeting", RequestMethod.POST, "ai.use"],
    ["suggestTags", RequestMethod.POST, "ai.use"],
  ] as const)("binds %s to its verb and authorization action", (handler, method, action) => {
    expect(Reflect.getMetadata(METHOD_METADATA, AiController.prototype[handler])).toBe(method);
    expect(specFor(handler).action).toBe(action);

    const scoped = request();
    expect(specFor(handler).workspaceId(scoped)).toBe(WORKSPACE_ID);
    expect(specFor(handler).resource(scoped)).toEqual({ kind: "workspace" });
  });
});

describe("AiController delegation", () => {
  it("forwards the read routes with the parsed scope", async () => {
    const getConfig = vi.fn().mockResolvedValue({ provider: "openai" });
    const getStatus = vi.fn().mockResolvedValue({ enabled: true });
    const instance = controller({ getConfig, getStatus });

    await instance.getConfig(request());
    await instance.getStatus(request());

    for (const method of [getConfig, getStatus]) {
      expect(method).toHaveBeenCalledWith({
        principal: expect.objectContaining({ userId: USER_ID }),
        workspaceId: WORKSPACE_ID,
        requestId: null,
      });
    }
  });

  it("enforces a trusted origin and forwards the parsed body on a config write", async () => {
    const updateConfig = vi.fn().mockResolvedValue({ provider: "openai" });
    const origin = vi.fn();
    await controller({ updateConfig }, origin).updateConfig(request(), validBody);

    expect(origin).toHaveBeenCalledOnce();
    expect(updateConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        provider: "openai",
        model: "gpt-4o-mini",
        apiKey: API_KEY,
        isEnabled: true,
        dailyTokenQuota: 1_000,
        rateLimitPerMinute: 5,
        contentConsent: true,
      }),
    );
  });

  it("applies the shared schema's defaults so a partial body cannot half-apply", async () => {
    const updateConfig = vi.fn().mockResolvedValue({ provider: "disabled" });
    await controller({ updateConfig }).updateConfig(request(), { provider: "disabled" });

    expect(updateConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "disabled",
        model: null,
        isEnabled: false,
        dailyTokenQuota: 50_000,
        rateLimitPerMinute: 10,
        contentConsent: false,
      }),
    );
  });

  it.each([
    ["an unknown field", { ...validBody, sneaky: true }],
    ["a key that is too short to be real", { ...validBody, apiKey: "short" }],
    ["enabling with no model", { ...validBody, model: null }],
    ["enabling without consent", { ...validBody, contentConsent: false }],
    ["enabling a disabled provider", { ...validBody, provider: "disabled" }],
  ] as const)("rejects %s before touching the service", (_label, body) => {
    const updateConfig = vi.fn();
    const origin = vi.fn();

    expect(() => controller({ updateConfig }, origin).updateConfig(request(), body)).toThrow(
      "The request is invalid.",
    );
    // The origin check runs first, and deliberately: a cross-site write is
    // refused whether or not its body happens to parse.
    expect(origin).toHaveBeenCalledOnce();
    expect(updateConfig).not.toHaveBeenCalled();
  });

  it("coerces the usage window from its query string and bounds it", async () => {
    const getUsage = vi.fn().mockResolvedValue({ totalRequests: 0 });
    await controller({ getUsage }).getUsage(request(), { days: "7" });
    expect(getUsage).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: WORKSPACE_ID, days: 7 }),
    );

    await controller({ getUsage }).getUsage(request(), {});
    expect(getUsage).toHaveBeenLastCalledWith(expect.objectContaining({ days: 30 }));

    for (const query of [{ days: "0" }, { days: "91" }, { days: "7", extra: "1" }]) {
      expect(() => controller({ getUsage }).getUsage(request(), query)).toThrow(
        "The request is invalid.",
      );
    }
  });
});

/**
 * Part 68 — the streaming routes. The controller's whole job here is
 * origin, parse, build the right prompt, delegate; the SSE mechanics and the
 * fail-closed ordering are `ai-stream.service.test.ts`.
 */
describe("AiController streaming routes", () => {
  const cases = [
    {
      handler: "summarize",
      feature: "summarize.v1",
      body: { noteId: NOTE_ID, text: "a note", length: "brief" },
      invalid: [
        { noteId: NOTE_ID, text: "a note", length: "epic" },
        { noteId: "not-a-uuid", text: "a note", length: "brief" },
        { noteId: NOTE_ID, text: "   ", length: "brief" },
        { noteId: NOTE_ID, text: "x".repeat(24_001), length: "brief" },
        { noteId: NOTE_ID, text: "a note", length: "brief", extra: 1 },
      ],
    },
    {
      handler: "continueWriting",
      feature: "continue.v1",
      body: { noteId: NOTE_ID, context: "the sentence so far" },
      invalid: [
        { noteId: NOTE_ID },
        { noteId: NOTE_ID, context: "" },
        { noteId: NOTE_ID, context: "x".repeat(8_001) },
        { noteId: NOTE_ID, context: "ok", text: "ok" },
      ],
    },
    {
      handler: "rewrite",
      feature: "rewrite.v1",
      body: { noteId: NOTE_ID, text: "a selection", tone: "concise" },
      invalid: [
        { noteId: NOTE_ID, text: "a selection", tone: "shouty" },
        { noteId: NOTE_ID, text: "x".repeat(4_001), tone: "concise" },
        { noteId: NOTE_ID, text: "a selection" },
      ],
    },
  ] as const;

  it.each(cases)(
    "$handler parses its body and delegates with the $feature prompt",
    async ({ handler, feature, body }) => {
      const run = vi.fn().mockResolvedValue(undefined);
      const origin = vi.fn();
      await controller({}, origin, run)[handler](request(), responseStub, body);

      expect(origin).toHaveBeenCalledOnce();
      expect(run).toHaveBeenCalledOnce();
      expect(run).toHaveBeenCalledWith(
        expect.objectContaining({
          principal: expect.objectContaining({ userId: USER_ID }),
          workspaceId: WORKSPACE_ID,
          noteId: NOTE_ID,
          requestId: null,
          response: responseStub,
          prompt: expect.objectContaining({ feature, promptVersion: feature }),
        }),
      );
    },
  );

  it.each(cases)(
    "$handler refuses a malformed body before it spends anything",
    ({ handler, invalid }) => {
      for (const body of invalid) {
        const run = vi.fn();
        const origin = vi.fn();
        expect(() => controller({}, origin, run)[handler](request(), responseStub, body)).toThrow(
          "The request is invalid.",
        );
        // The origin check runs first, and deliberately.
        expect(origin).toHaveBeenCalledOnce();
        expect(run).not.toHaveBeenCalled();
      }
    },
  );

  it("puts all three on the sensitive rate-limit tier", () => {
    for (const { handler } of cases) {
      expect(Reflect.getMetadata(RATE_LIMIT_TIER, AiController.prototype[handler])).toBe(
        "sensitive",
      );
    }
  });
});

/**
 * Part 69 — the two JSON routes. Ordinary handlers this time: they return a
 * value, so a refusal or a bad reply is still an error envelope.
 */
describe("AiController JSON routes", () => {
  const TRANSCRIPT = "Ana: we ship Friday. Ben: I will write the migration.";

  it("enforces a trusted origin and forwards the parsed transcript", async () => {
    const extract = vi.fn().mockResolvedValue({ extraction: { attendees: [] } });
    const origin = vi.fn();

    await controller({}, origin, vi.fn(), { extract }).extractMeeting(request(), {
      transcript: TRANSCRIPT,
    });

    expect(origin).toHaveBeenCalledOnce();
    expect(extract).toHaveBeenCalledWith({
      principal: expect.objectContaining({ userId: USER_ID }),
      workspaceId: WORKSPACE_ID,
      requestId: null,
      transcript: TRANSCRIPT,
    });
  });

  it("enforces a trusted origin and forwards the note id and content for tags", async () => {
    const suggestTags = vi.fn().mockResolvedValue({ existing: [], proposed: [] });
    const origin = vi.fn();

    await controller({}, origin, vi.fn(), { suggestTags }).suggestTags(request(), {
      noteId: NOTE_ID,
      content: "a note about the roadmap",
    });

    expect(origin).toHaveBeenCalledOnce();
    expect(suggestTags).toHaveBeenCalledWith({
      principal: expect.objectContaining({ userId: USER_ID }),
      workspaceId: WORKSPACE_ID,
      requestId: null,
      noteId: NOTE_ID,
      content: "a note about the roadmap",
    });
  });

  it.each([
    ["extractMeeting", {}],
    ["extractMeeting", { transcript: "" }],
    ["extractMeeting", { transcript: "   " }],
    ["extractMeeting", { transcript: "x".repeat(100_001) }],
    ["extractMeeting", { transcript: TRANSCRIPT, extra: 1 }],
    ["suggestTags", { noteId: NOTE_ID }],
    ["suggestTags", { noteId: "not-a-uuid", content: "note" }],
    ["suggestTags", { noteId: NOTE_ID, content: "" }],
    ["suggestTags", { noteId: NOTE_ID, content: "x".repeat(50_001) }],
    ["suggestTags", { noteId: NOTE_ID, content: "note", extra: true }],
  ] as const)("%s refuses a malformed body before it spends anything", (handler, body) => {
    const spy = vi.fn();
    const origin = vi.fn();
    const instance = controller({}, origin, vi.fn(), { extract: spy, suggestTags: spy });

    expect(() => instance[handler](request(), body)).toThrow("The request is invalid.");
    // The origin check runs first, and deliberately.
    expect(origin).toHaveBeenCalledOnce();
    expect(spy).not.toHaveBeenCalled();
  });

  it("puts both on the sensitive rate-limit tier", () => {
    for (const handler of ["extractMeeting", "suggestTags"] as const) {
      expect(Reflect.getMetadata(RATE_LIMIT_TIER, AiController.prototype[handler])).toBe(
        "sensitive",
      );
    }
  });
});
