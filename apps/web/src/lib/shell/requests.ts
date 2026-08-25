import { SHELL_API_PATHS } from "@notted/shared-types";
import {
  notificationEmailPreferenceSchema,
  notificationPageSchema,
  notificationReadResultSchema,
  notificationsMarkAllResultSchema,
  workspaceSelectorSchema,
} from "@notted/shared-validators";

import type {
  NotificationEmailPreference,
  NotificationPage,
  NotificationReadResult,
  NotificationsMarkAllResult,
} from "@notted/shared-types";

import { apiOrigin } from "@/lib/api/api-origin";

export type ShellRequestResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly kind: "forbidden" | "network" | "invalid" };

function notificationsPath(workspaceId: string): string {
  return SHELL_API_PATHS.notifications.replace(":workspaceId", encodeURIComponent(workspaceId));
}

async function requestJson<T>(
  url: URL | string,
  init: RequestInit,
  parse: (value: unknown) => { success: true; data: T } | { success: false },
): Promise<ShellRequestResult<T>> {
  try {
    const response = await fetch(url, {
      ...init,
      cache: "no-store",
      credentials: "include",
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) {
      return {
        ok: false,
        kind:
          response.status === 401 || response.status === 403 || response.status === 404
            ? "forbidden"
            : "network",
      };
    }
    const parsed = parse(await response.json());
    return parsed.success ? { ok: true, data: parsed.data } : { ok: false, kind: "invalid" };
  } catch {
    return { ok: false, kind: "network" };
  }
}

export function loadNotifications(
  workspaceId: string,
  page = 1,
): Promise<ShellRequestResult<NotificationPage>> {
  const url = new URL(notificationsPath(workspaceId), apiOrigin());
  url.searchParams.set("page", String(page));
  url.searchParams.set("limit", "20");
  return requestJson(url, { method: "GET" }, (value) => notificationPageSchema.safeParse(value));
}

export function setNotificationRead(
  workspaceId: string,
  notificationId: string,
  isRead: boolean,
): Promise<ShellRequestResult<NotificationReadResult>> {
  return requestJson(
    new URL(`${notificationsPath(workspaceId)}/${encodeURIComponent(notificationId)}`, apiOrigin()),
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isRead }),
    },
    (value) => notificationReadResultSchema.safeParse(value),
  );
}

export function markAllNotificationsRead(
  workspaceId: string,
): Promise<ShellRequestResult<NotificationsMarkAllResult>> {
  return requestJson(
    new URL(`${notificationsPath(workspaceId)}/read-all`, apiOrigin()),
    { method: "POST", headers: { "Content-Type": "application/json" } },
    (value) => notificationsMarkAllResultSchema.safeParse(value),
  );
}

/**
 * Mention-email opt-out, the control the mention email's footer links to.
 *
 * Read and write share one response schema because the preference IS its own
 * result — `{mentionEmail}` in, `{mentionEmail}` out — so a drift between the
 * toggle's optimistic value and the server's answer is impossible to express.
 */
export function loadMentionEmailPreference(
  workspaceId: string,
): Promise<ShellRequestResult<NotificationEmailPreference>> {
  return requestJson(
    new URL(`${notificationsPath(workspaceId)}/email-preference`, apiOrigin()),
    { method: "GET" },
    (value) => notificationEmailPreferenceSchema.safeParse(value),
  );
}

export function setMentionEmailPreference(
  workspaceId: string,
  mentionEmail: boolean,
): Promise<ShellRequestResult<NotificationEmailPreference>> {
  return requestJson(
    new URL(`${notificationsPath(workspaceId)}/email-preference`, apiOrigin()),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mentionEmail }),
    },
    (value) => notificationEmailPreferenceSchema.safeParse(value),
  );
}

export async function selectWorkspace(workspaceId: string): Promise<ShellRequestResult<true>> {
  const parsed = workspaceSelectorSchema.safeParse({ workspaceId });
  if (!parsed.success) return { ok: false, kind: "invalid" };
  try {
    const response = await fetch("/api/shell/workspace", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(parsed.data),
      signal: AbortSignal.timeout(8_000),
    });
    return response.ok
      ? { ok: true, data: true }
      : {
          ok: false,
          kind: response.status === 403 || response.status === 404 ? "forbidden" : "network",
        };
  } catch {
    return { ok: false, kind: "network" };
  }
}
