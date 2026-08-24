import { AI_API_PATHS } from "@notted/shared-types";
import {
  aiConfigUpdateSchema,
  aiConfigViewSchema,
  aiUsageQuerySchema,
  aiUsageSummarySchema,
} from "@notted/shared-validators";

import type { ApiRequestResult } from "@/lib/api/request-json";
import type { AiConfigView, AiUsageSummary } from "@notted/shared-types";
import type { AiConfigUpdateInput } from "@notted/shared-validators";

import { json, requestJson, validIds } from "@/lib/api/request-json";

/**
 * Part 67 — the browser half of workspace AI configuration.
 *
 * Mirrors `@/lib/api-keys/requests`: every response is `safeParse`d against the
 * shared schema so an off-contract body is a failure rather than a silent cast,
 * and the workspace id is UUID-checked before a request is allowed to leave.
 *
 * There is deliberately no `fetchAiStatus` here. Nothing in this slice reads it
 * — the settings form is admin-only and needs the full config — and an unused
 * wrapper is a contract to keep in step for no reader.
 */

/** The stored configuration. Never carries the credential — only `hasCredentials`. */
export function fetchAiConfig(workspaceId: string): Promise<ApiRequestResult<AiConfigView>> {
  if (!validIds(workspaceId)) return Promise.resolve({ ok: false, kind: "invalid" });
  return requestJson(AI_API_PATHS.config(workspaceId), {}, (value) =>
    aiConfigViewSchema.safeParse(value),
  );
}

/**
 * Replaces the whole configuration.
 *
 * `parsed.data` is what goes on the wire, and that matters for one field: the
 * schema leaves `apiKey` ABSENT when the caller omitted it, which is how the
 * server is told "keep the stored credential". Sending `""` would instead be a
 * rejected value, so the property is never synthesized here.
 */
export function updateAiConfig(
  workspaceId: string,
  input: AiConfigUpdateInput,
): Promise<ApiRequestResult<AiConfigView>> {
  const parsed = aiConfigUpdateSchema.safeParse(input);
  if (!validIds(workspaceId) || !parsed.success) {
    return Promise.resolve({ ok: false, kind: "invalid" });
  }
  return requestJson(AI_API_PATHS.config(workspaceId), json("PUT", parsed.data), (value) =>
    aiConfigViewSchema.safeParse(value),
  );
}

/**
 * Token, request, and cost roll-up over a bounded window.
 *
 * The window is validated in its serialized form for the same reason as the API
 * key list query: that is exactly what goes on the wire, and an out-of-range
 * `days` would otherwise be a 400 the reader can do nothing about.
 */
export function fetchAiUsage(
  workspaceId: string,
  days = 30,
): Promise<ApiRequestResult<AiUsageSummary>> {
  const search = new URLSearchParams({ days: String(days) });
  if (!validIds(workspaceId) || !aiUsageQuerySchema.safeParse({ days: String(days) }).success) {
    return Promise.resolve({ ok: false, kind: "invalid" });
  }
  return requestJson(`${AI_API_PATHS.usage(workspaceId)}?${search.toString()}`, {}, (value) =>
    aiUsageSummarySchema.safeParse(value),
  );
}
