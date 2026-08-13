import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GlobalSearchDialog } from "./GlobalSearchDialog";

import { Dialog } from "@/components/ui/dialog";

const mocks = vi.hoisted(() => ({
  requestSearchSuggestions: vi.fn(),
  push: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock("@/lib/search/requests", () => ({
  requestSearchSuggestions: mocks.requestSearchSuggestions,
  SEARCH_SUGGESTION_DEFAULT_LIMIT: 8,
}));

const workspaceId = "53000000-0000-4000-8000-0000000000a0";
const noteId = "53000000-0000-4000-8000-0000000000b1";

function suggestion(title = "Release notes") {
  return {
    noteId,
    title,
    updatedAt: "2026-08-01T00:00:00.000Z",
  };
}

function recentKey(): string {
  return `notted.search.recents.${workspaceId}`;
}

/**
 * `GlobalSearchDialog` renders the palette CONTENT (it reuses the shared
 * `DialogContent`), so the harness supplies the controlling `<Dialog>` exactly
 * as `TopBar` does in production. The palette's own `open`/`onOpenChange` props
 * drive its focus and reset effects and let navigation close it.
 */
function PaletteHarness({
  workspaceId,
  startOpen = true,
}: {
  readonly workspaceId: string | null;
  readonly startOpen?: boolean;
}) {
  const [open, setOpen] = useState(startOpen);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <GlobalSearchDialog workspaceId={workspaceId} open={open} onOpenChange={setOpen} />
    </Dialog>
  );
}

function renderPalette(workspaceId: string | null, startOpen = true): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <PaletteHarness workspaceId={workspaceId} startOpen={startOpen} />
    </QueryClientProvider>,
  );
}

describe("GlobalSearchDialog", () => {
  beforeEach(() => {
    mocks.requestSearchSuggestions.mockReset();
    mocks.push.mockReset();
    window.localStorage.clear();
  });

  it("shows a no-workspace message and disables the input when no workspace is selected", () => {
    renderPalette(null);
    const input = screen.getByRole("combobox", { name: "Search notes" }) as HTMLInputElement;
    expect(input).toBeDisabled();
    expect(screen.getByText(/Select a workspace first to search its notes/u)).toBeInTheDocument();
    expect(mocks.requestSearchSuggestions).not.toHaveBeenCalled();
  });

  it("moves focus into the input on open", async () => {
    renderPalette(workspaceId, true);
    await waitFor(() => {
      expect(screen.getByRole("combobox", { name: "Search notes" })).toHaveFocus();
    });
  });

  it("shows recent searches when the query is empty and lets the user clear them", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(
      recentKey(),
      JSON.stringify({
        items: [{ query: "release notes", recordedAt: "2026-08-01T00:00:00.000Z" }],
        version: 1,
      }),
    );
    renderPalette(workspaceId);

    expect(await screen.findByText("release notes")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear recent searches" }));
    expect(screen.queryByText("release notes")).toBeNull();
    expect(window.localStorage.getItem(recentKey())).toBeNull();
  });

  it("fills the query when a recent search is picked", async () => {
    mocks.requestSearchSuggestions.mockResolvedValue({ ok: true, data: [] });
    const user = userEvent.setup();
    window.localStorage.setItem(
      recentKey(),
      JSON.stringify({
        items: [{ query: "roadmap", recordedAt: "2026-08-01T00:00:00.000Z" }],
        version: 1,
      }),
    );
    renderPalette(workspaceId);

    const recent = await screen.findByRole("button", { name: /roadmap/u });
    await user.click(recent);
    const input = screen.getByRole("combobox", { name: "Search notes" }) as HTMLInputElement;
    expect(input.value).toBe("roadmap");
  });

  it("debounces the suggestion fetch and renders matches", async () => {
    mocks.requestSearchSuggestions.mockResolvedValue({ ok: true, data: [suggestion()] });
    const user = userEvent.setup();
    renderPalette(workspaceId);

    const input = screen.getByRole("combobox", { name: "Search notes" });
    await user.type(input, "rel");

    // The fast path is debounced; the suggestion appears after the pause.
    const option = await screen.findByRole("option", { name: /Release notes/u });
    expect(option).toBeInTheDocument();
    expect(mocks.requestSearchSuggestions).toHaveBeenCalledWith(workspaceId, "rel", 8);
  });

  it("navigates to the selected note on Enter", async () => {
    mocks.requestSearchSuggestions.mockResolvedValue({ ok: true, data: [suggestion()] });
    const user = userEvent.setup();
    renderPalette(workspaceId);

    const input = screen.getByRole("combobox", { name: "Search notes" });
    await user.type(input, "rel");
    await screen.findByRole("option", { name: /Release notes/u });
    await user.keyboard("{ArrowDown}");
    await user.keyboard("{Enter}");

    expect(mocks.push).toHaveBeenCalledWith(`/workspaces/${workspaceId}/notes/${noteId}`);
  });

  it("falls back to the full search route on Enter with no selection", async () => {
    mocks.requestSearchSuggestions.mockResolvedValue({ ok: true, data: [] });
    const user = userEvent.setup();
    renderPalette(workspaceId);

    const input = screen.getByRole("combobox", { name: "Search notes" });
    await user.type(input, "roadmap");
    await screen.findByText(/No notes match/u);
    await user.keyboard("{Enter}");

    expect(mocks.push).toHaveBeenCalledWith(`/workspaces/${workspaceId}/search?query=roadmap`);
  });

  it("moves the active option with ArrowDown/ArrowUp", async () => {
    mocks.requestSearchSuggestions.mockResolvedValue({
      ok: true,
      data: [suggestion("Alpha"), suggestion("Beta")],
    });
    const user = userEvent.setup();
    renderPalette(workspaceId);

    const input = screen.getByRole("combobox", { name: "Search notes" });
    await user.type(input, "rel");
    const [first, second] = await screen.findAllByRole("option");
    // The first option is active by default once results arrive.
    await waitFor(() => expect(first).toHaveAttribute("aria-selected", "true"));
    await user.keyboard("{ArrowDown}");
    await waitFor(() => expect(second).toHaveAttribute("aria-selected", "true"));
    await user.keyboard("{ArrowUp}");
    await waitFor(() => expect(first).toHaveAttribute("aria-selected", "true"));
  });

  it("renders the unavailable state instead of crashing when the provider is down", async () => {
    mocks.requestSearchSuggestions.mockResolvedValue({ ok: false, kind: "unavailable" });
    const user = userEvent.setup();
    renderPalette(workspaceId);

    const input = screen.getByRole("combobox", { name: "Search notes" });
    await user.type(input, "rel");
    expect(await screen.findByText(/Search is temporarily unavailable/u)).toBeInTheDocument();
  });

  it("renders a generic error state for a denied request", async () => {
    mocks.requestSearchSuggestions.mockResolvedValue({ ok: false, kind: "invalid" });
    const user = userEvent.setup();
    renderPalette(workspaceId);

    const input = screen.getByRole("combobox", { name: "Search notes" });
    await user.type(input, "rel");
    expect(await screen.findByText(/could not complete this search/u)).toBeInTheDocument();
  });

  it("offers a 'See all results' action that navigates to the full route", async () => {
    mocks.requestSearchSuggestions.mockResolvedValue({ ok: true, data: [suggestion()] });
    const user = userEvent.setup();
    renderPalette(workspaceId);

    const input = screen.getByRole("combobox", { name: "Search notes" });
    await user.type(input, "rel");
    await screen.findByRole("option", { name: /Release notes/u });
    await user.click(screen.getByRole("button", { name: /See all results for/u }));
    expect(mocks.push).toHaveBeenCalledWith(`/workspaces/${workspaceId}/search?query=rel`);
  });

  it("closes on Escape and restores focus to the dialog trigger", async () => {
    const user = userEvent.setup();
    renderPalette(workspaceId);
    const input = screen.getByRole("combobox", { name: "Search notes" });
    await user.type(input, "rel");
    expect(input).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("combobox", { name: "Search notes" })).toBeNull(),
    );
  });
});
