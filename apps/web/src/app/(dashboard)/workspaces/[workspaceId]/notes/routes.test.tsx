import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const browser = vi.hoisted(() =>
  vi.fn(({ view = "normal" }: { view?: string }) => <h1>{view}</h1>),
);
vi.mock("@/components/notes/WorkspaceNoteBrowser", () => ({ WorkspaceNoteBrowser: browser }));

import NotesPage from "./page";
import PinnedNotesPage from "./pinned/page";
import RecentNotesPage from "./recent/page";
import WorkspaceTemplatesPage from "./templates/page";
import WorkspaceTrashPage from "./trash/page";

const params = Promise.resolve({ workspaceId: "30000000-0000-4000-8000-000000000001" });
const searchParams = Promise.resolve({});

describe("workspace note view routes", () => {
  it.each([
    ["normal", NotesPage],
    ["recent", RecentNotesPage],
    ["pinned", PinnedNotesPage],
    ["templates", WorkspaceTemplatesPage],
    ["trash", WorkspaceTrashPage],
  ] as const)("routes %s through the one server-backed browser", async (view, Page) => {
    render(await Page({ params, searchParams }));
    expect(screen.getByRole("heading", { name: view })).toBeVisible();
  });
});
