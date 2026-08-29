/*
 * The dashboard layout's two redirects.
 *
 * Both sent every unauthenticated visitor to `loginPathFor("/")`, so signing in
 * always landed on the dashboard and the page actually asked for was lost — the
 * bookmarked note, the shared task, the deep link out of an email. The App
 * Router gives a layout no pathname, so `proxy.ts` stamps one on the request and
 * this reads it back.
 */

import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import DashboardLayout from "@/app/(dashboard)/layout";
import { PATHNAME_HEADER } from "@/proxy";

const redirect = vi.fn((path: string) => {
  throw new Error(`REDIRECT:${path}`);
});
const headerValues = new Map<string, string>();
const getServerSession = vi.fn();
const getServerShell = vi.fn();

vi.mock("next/navigation", () => ({ redirect: (path: string) => redirect(path) }));
vi.mock("next/headers", () => ({
  headers: () => Promise.resolve({ get: (name: string) => headerValues.get(name) ?? null }),
}));
vi.mock("@/lib/auth/server-session", () => ({ getServerSession: () => getServerSession() }));
vi.mock("@/lib/shell/server-shell", () => ({ getServerShell: () => getServerShell() }));
vi.mock("@/lib/notes/server-notes", () => ({
  getServerNoteNavigation: vi.fn(),
  getServerFolders: vi.fn(),
}));
vi.mock("@/lib/tags/server-tags", () => ({ getServerTags: vi.fn() }));
vi.mock("@/components/layout/DashboardShell", () => ({ DashboardShell: () => null }));

const NOTE_PATH = "/workspaces/40000000-0000-4000-8000-000000000001/notes/n";

async function renderLayout(): Promise<void> {
  render(await DashboardLayout({ children: null }));
}

describe("dashboard layout redirects", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    headerValues.clear();
    headerValues.set(PATHNAME_HEADER, NOTE_PATH);
    getServerSession.mockResolvedValue({ status: "ready" });
    getServerShell.mockResolvedValue({ status: "ready", data: { currentWorkspace: null } });
  });

  it("carries the requested page into the login redirect when the session is gone", async () => {
    getServerSession.mockResolvedValue({ status: "unauthenticated" });

    await expect(renderLayout()).rejects.toThrow("REDIRECT:");
    expect(redirect).toHaveBeenCalledWith(`/login?redirect=${encodeURIComponent(NOTE_PATH)}`);
  });

  it("carries it into the shell redirect too", async () => {
    getServerShell.mockResolvedValue({ status: "unauthenticated" });

    await expect(renderLayout()).rejects.toThrow("REDIRECT:");
    expect(redirect).toHaveBeenCalledWith(`/login?redirect=${encodeURIComponent(NOTE_PATH)}`);
  });

  it("falls back to the root for a request the proxy matcher skipped", async () => {
    headerValues.clear();
    getServerSession.mockResolvedValue({ status: "unauthenticated" });

    await expect(renderLayout()).rejects.toThrow("REDIRECT:");
    expect(redirect).toHaveBeenCalledWith("/login?redirect=%2F");
  });
});
