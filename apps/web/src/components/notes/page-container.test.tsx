import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ updateNote: vi.fn(), refresh: vi.fn() }));

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock("@/lib/notes/requests", () => ({ updateNote: mocks.updateNote }));

import { PageContainer } from "./PageContainer";

import type { PageSize } from "@notted/shared-types";

import { FOCUS_MODE_ATTRIBUTE, isFocusModeEnabled, setFocusMode } from "@/lib/notes/focus-mode";
import { PAGE_PREFERENCES_KEY } from "@/lib/notes/page-preferences";

afterEach(() => {
  setFocusMode(false);
});

const WORKSPACE_ID = "30000000-0000-4000-8000-000000000001";
const NOTE_ID = "30000000-0000-4000-8000-000000000002";

function updated(pageSize: PageSize, version: number) {
  return { ok: true, data: { note: { pageSize, version } } };
}

function view(
  options: {
    readonly canUpdate?: boolean;
    readonly initialPageSize?: PageSize;
    readonly initialVersion?: number;
  } = {},
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <PageContainer
        workspaceId={WORKSPACE_ID}
        noteId={NOTE_ID}
        initialPageSize={options.initialPageSize ?? "a4"}
        initialVersion={options.initialVersion ?? 3}
        canUpdate={options.canUpdate ?? true}
      >
        <div data-testid="editor-stand-in">Note body</div>
      </PageContainer>
    </QueryClientProvider>,
  );
}

function paper(): HTMLElement {
  return screen.getByTestId("notted-page-paper");
}

/** The layout announcement region: zoom, margins, focus mode, page size. */
function liveRegion(): HTMLElement {
  return screen.getByTestId("note-layout-status");
}

/**
 * The save announcement region (Part 39). Save state is kept apart from the
 * layout announcements so a zoom change cannot overwrite "Couldn't save".
 */
function saveRegion(): HTMLElement {
  return screen.getByTestId("note-save-status");
}

describe("PageContainer layout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Queued `mockResolvedValueOnce` values survive `clearAllMocks`, so an
    // unconsumed one would answer the next test's first request.
    mocks.updateNote.mockReset();
    window.localStorage.clear();
  });

  it("renders the editor it wraps inside the paper", () => {
    view();
    expect(screen.getByTestId("editor-stand-in")).toBeInTheDocument();
    expect(paper()).toContainElement(screen.getByTestId("editor-stand-in"));
  });

  it("drives the sheet from physical units, not a pixel constant", () => {
    view();
    // The px measurement (794 x 1123) is asserted in `page-geometry.test.ts` and
    // verified for real in Playwright; what belongs here is that the element is
    // handed the physical size and the public content-width token.
    expect(paper().style.getPropertyValue("--notted-page-width")).toBe("210mm");
    expect(paper().style.getPropertyValue("--notted-page-height")).toBe("297mm");
    expect(paper().style.getPropertyValue("--notted-page-margin-x")).toBe("20mm");
    expect(paper().style.getPropertyValue("--notted-page-margin-y")).toBe("25mm");
    expect(paper().style.getPropertyValue("--notted-page-content-width")).toBe(
      "calc(210mm - 40mm)",
    );
  });

  it("keeps the page-break guide overlay inert and hidden from assistive technology", () => {
    const { container } = view();
    const guides = container.querySelector(".notted-page-breaks");
    expect(guides).not.toBeNull();
    expect(guides).toHaveAttribute("aria-hidden", "true");
    // jsdom reports every rect as zero and implements no `ResizeObserver`, so
    // nothing is measurable and nothing is drawn. The offsets themselves are
    // proven in `page-geometry.test.ts`; the layout is verified in Playwright.
    expect(guides?.childElementCount).toBe(0);
  });

  it("emits an @page rule for the current sheet, which no CSS class could select", () => {
    view({ initialPageSize: "a4" });
    expect(screen.getByTestId("notted-page-rule")).toHaveTextContent(
      "@page { size: 210mm 297mm; margin: 25mm 20mm; }",
    );
  });

  it("offers a named, keyboard-reachable scroll region that traps nothing", async () => {
    const user = userEvent.setup();
    view();
    const region = screen.getByRole("region", { name: "Note page" });
    expect(region).toHaveAttribute("tabindex", "0");
    region.focus();
    expect(region).toHaveFocus();
    await user.tab();
    expect(region).not.toHaveFocus();
  });
});

describe("PageContainer zoom", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Queued `mockResolvedValueOnce` values survive `clearAllMocks`, so an
    // unconsumed one would answer the next test's first request.
    mocks.updateNote.mockReset();
    window.localStorage.clear();
  });

  it("announces a zoom change politely and scales the paper", async () => {
    const user = userEvent.setup();
    view();
    await user.selectOptions(screen.getByLabelText("Zoom"), "1.25");

    expect(liveRegion()).toHaveTextContent("Zoom set to 125%.");
    expect(paper()).toHaveAttribute("data-zoom-scale", "1.25");
    expect(paper().style.transform).toBe("translateX(-50%) scale(1.25)");
  });

  it("keeps zoom controls in the tab order and marks the limit with aria-disabled", async () => {
    const user = userEvent.setup();
    view();
    await user.selectOptions(screen.getByLabelText("Zoom"), "0.5");

    const zoomOut = screen.getByRole("button", { name: "Zoom out" });
    expect(zoomOut).toHaveAttribute("aria-disabled", "true");
    // Never natively disabled: that would drop the control out of the tab order
    // mid-interaction, which is the trap the Part 34 toolbar avoided.
    expect(zoomOut).not.toBeDisabled();
    zoomOut.focus();
    expect(zoomOut).toHaveFocus();

    await user.click(zoomOut);
    expect(paper()).toHaveAttribute("data-zoom-scale", "0.5");
    expect(screen.getByRole("button", { name: "Zoom in" })).not.toHaveAttribute("aria-disabled");
  });

  it("steps between levels from the keyboard", async () => {
    const user = userEvent.setup();
    view();
    screen.getByRole("button", { name: "Zoom in" }).focus();
    await user.keyboard("{Enter}");
    expect(paper()).toHaveAttribute("data-zoom-scale", "1.25");
    await user.keyboard("{Enter}");
    expect(paper()).toHaveAttribute("data-zoom-scale", "1.5");
  });

  it("offers both fit modes and resolves them to 100% where nothing can be measured", async () => {
    const user = userEvent.setup();
    view();
    const select = screen.getByLabelText("Zoom");
    expect(within(select).getByRole("option", { name: "Fit to width" })).toBeInTheDocument();
    expect(within(select).getByRole("option", { name: "Fit to page" })).toBeInTheDocument();

    // jsdom reports every box as zero and implements no `ResizeObserver`, so a
    // fit mode must degrade to 100% rather than produce a NaN transform.
    await user.selectOptions(select, "fit-width");
    expect(liveRegion()).toHaveTextContent("Zoom set to Fit to width, 100%.");
    expect(paper()).toHaveAttribute("data-zoom-scale", "1");
    expect(paper().style.transform).toBe("translateX(-50%) scale(1)");
  });

  it("does not intercept pointer or keyboard input at a non-default zoom", async () => {
    const user = userEvent.setup();
    const clicked = vi.fn();
    const typed = vi.fn();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <PageContainer
          workspaceId={WORKSPACE_ID}
          noteId={NOTE_ID}
          initialPageSize="a4"
          initialVersion={3}
          canUpdate
        >
          <button type="button" onClick={clicked}>
            Inside the page
          </button>
          <input aria-label="Body" onChange={(event) => typed(event.target.value)} />
        </PageContainer>
      </QueryClientProvider>,
    );
    await user.selectOptions(screen.getByLabelText("Zoom"), "1.5");

    // Part 36 recorded that a `scale()` ancestor changes what `clientRect()`
    // reports; the suggestion popovers render inside this subtree and scale
    // with it. What must never change is that the container itself stays out of
    // the way of every event aimed at the editor.
    await user.click(screen.getByRole("button", { name: "Inside the page" }));
    expect(clicked).toHaveBeenCalledTimes(1);
    await user.type(screen.getByLabelText("Body"), "hi");
    expect(typed).toHaveBeenLastCalledWith("hi");
  });

  it("restores a stored zoom and margin preference on mount", async () => {
    window.localStorage.setItem(
      PAGE_PREFERENCES_KEY,
      JSON.stringify({ zoom: 0.75, margins: { x: 12, y: 30 } }),
    );
    view();
    await waitFor(() => expect(paper()).toHaveAttribute("data-zoom-scale", "0.75"));
    expect(paper().style.getPropertyValue("--notted-page-margin-x")).toBe("12mm");
    expect(paper().style.getPropertyValue("--notted-page-margin-y")).toBe("30mm");
    expect(screen.getByLabelText("Side margin (mm)")).toHaveValue(12);
  });
});

describe("PageContainer margins", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Queued `mockResolvedValueOnce` values survive `clearAllMocks`, so an
    // unconsumed one would answer the next test's first request.
    mocks.updateNote.mockReset();
    window.localStorage.clear();
  });

  it("applies a valid margin and persists it locally without any request", async () => {
    const user = userEvent.setup();
    view();
    const field = screen.getByLabelText("Side margin (mm)");
    await user.clear(field);
    await user.type(field, "12");
    await user.tab();

    expect(paper().style.getPropertyValue("--notted-page-margin-x")).toBe("12mm");
    expect(paper().style.getPropertyValue("--notted-page-content-width")).toBe(
      "calc(210mm - 24mm)",
    );
    expect(window.localStorage.getItem(PAGE_PREFERENCES_KEY)).toContain('"x":12');
    // Margins are a local viewing preference; the note is never touched.
    expect(mocks.updateNote).not.toHaveBeenCalled();
  });

  it("clamps a margin that would leave no content column", async () => {
    const user = userEvent.setup();
    view();
    const field = screen.getByLabelText("Side margin (mm)");
    await user.clear(field);
    await user.type(field, "900");
    await user.tab();

    expect(field).toHaveValue(84);
    expect(paper().style.getPropertyValue("--notted-page-margin-x")).toBe("84mm");
  });

  it("keeps the current margin when the field is left empty", async () => {
    const user = userEvent.setup();
    view();
    const field = screen.getByLabelText("Top and bottom margin (mm)");
    await user.clear(field);
    await user.tab();

    expect(field).toHaveValue(25);
    expect(paper().style.getPropertyValue("--notted-page-margin-y")).toBe("25mm");
  });
});

describe("PageContainer page size", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Queued `mockResolvedValueOnce` values survive `clearAllMocks`, so an
    // unconsumed one would answer the next test's first request.
    mocks.updateNote.mockReset();
    window.localStorage.clear();
  });

  it("switches optimistically and adopts the version the server returns", async () => {
    const user = userEvent.setup();
    mocks.updateNote.mockResolvedValueOnce(updated("letter", 4));
    mocks.updateNote.mockResolvedValueOnce(updated("a4", 5));
    view({ initialVersion: 3 });

    await user.click(screen.getByRole("button", { name: "US Letter" }));
    await waitFor(() => expect(paper()).toHaveAttribute("data-page-size", "letter"));
    // Part 39 routes this through the shared autosave machine, so the request
    // now also declares whether it must survive a navigation. A settings press
    // is an explicit act and is not debounced.
    expect(mocks.updateNote).toHaveBeenCalledWith(
      WORKSPACE_ID,
      NOTE_ID,
      { expectedVersion: 3, pageSize: "letter" },
      { keepalive: false },
    );
    expect(screen.getByRole("button", { name: "US Letter" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(paper().style.getPropertyValue("--notted-page-width")).toBe("8.5in");
    expect(liveRegion()).toHaveTextContent("Page size is now US Letter.");
    expect(saveRegion()).toHaveTextContent("Saved.");

    // The response carried the new version, so the next change expects 4 rather
    // than re-sending the stale 3 and conflicting with itself.
    await user.click(screen.getByRole("button", { name: "A4" }));
    await waitFor(() =>
      expect(mocks.updateNote).toHaveBeenLastCalledWith(
        WORKSPACE_ID,
        NOTE_ID,
        { expectedVersion: 4, pageSize: "a4" },
        { keepalive: false },
      ),
    );
  });

  it("is operable from the keyboard alone", async () => {
    const user = userEvent.setup();
    mocks.updateNote.mockResolvedValue(updated("letter", 4));
    view();
    screen.getByRole("button", { name: "US Letter" }).focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(mocks.updateNote).toHaveBeenCalledTimes(1));
  });

  it("restores the exact previous size and version when the change is rejected", async () => {
    const user = userEvent.setup();
    // A terminal kind, because Part 39 now *retries* `unavailable` rather than
    // giving up on the first outage; the exhausted-retry path is covered below.
    mocks.updateNote.mockResolvedValueOnce({ ok: false, kind: "invalid" });
    mocks.updateNote.mockResolvedValueOnce(updated("letter", 4));
    view({ initialVersion: 3 });

    await user.click(screen.getByRole("button", { name: "US Letter" }));
    await waitFor(() => expect(saveRegion()).toHaveTextContent(/did not accept this change/u));
    expect(paper()).toHaveAttribute("data-page-size", "a4");
    expect(screen.getByRole("button", { name: "A4" })).toHaveAttribute("aria-pressed", "true");
    expect(paper().style.getPropertyValue("--notted-page-width")).toBe("210mm");

    // The restored version is the original one, so a retry is not poisoned.
    await user.click(screen.getByRole("button", { name: "US Letter" }));
    await waitFor(() =>
      expect(mocks.updateNote).toHaveBeenLastCalledWith(
        WORKSPACE_ID,
        NOTE_ID,
        { expectedVersion: 3, pageSize: "letter" },
        { keepalive: false },
      ),
    );
  });

  it("offers a reload affordance on a version conflict", async () => {
    const user = userEvent.setup();
    mocks.updateNote.mockResolvedValue({ ok: false, kind: "version-conflict" });
    view();

    await user.click(screen.getByRole("button", { name: "US Letter" }));
    const reload = await screen.findByRole("button", { name: "Reload latest version" });
    expect(saveRegion()).toHaveTextContent(/changed somewhere else/u);
    // Reloading is a real loss, so it says so before it is chosen.
    expect(saveRegion()).toHaveTextContent(/discards the changes you made here/u);
    expect(screen.queryByRole("button", { name: "Retry saving" })).not.toBeInTheDocument();
    await user.click(reload);
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });

  it("announces a denial without claiming the change was applied", async () => {
    const user = userEvent.setup();
    mocks.updateNote.mockResolvedValue({ ok: false, kind: "forbidden-or-not-found" });
    view();

    await user.click(screen.getByRole("button", { name: "US Letter" }));
    await waitFor(() =>
      expect(saveRegion()).toHaveTextContent(/denied, or this note is no longer available/u),
    );
    expect(paper()).toHaveAttribute("data-page-size", "a4");
    const reload = screen.queryByRole("button", { name: "Reload latest version" });
    expect(reload).not.toBeInTheDocument();
  });

  it("shows the size as static text and offers no toggle without edit access", () => {
    view({ canUpdate: false, initialPageSize: "letter" });
    expect(screen.queryByRole("button", { name: "A4" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "US Letter" })).not.toBeInTheDocument();
    expect(screen.getByText(/Page size: US Letter/u)).toHaveAttribute("role", "note");
    // Zoom stays available: reading a note at 150% needs no write permission.
    expect(screen.getByLabelText("Zoom")).toBeInTheDocument();
    // Nothing is ever saved from a read-only page, so no save state is claimed.
    expect(screen.queryByTestId("note-save-status")).not.toBeInTheDocument();
  });

  it("ignores a repeat of the size already applied", async () => {
    const user = userEvent.setup();
    view({ initialPageSize: "a4" });
    await user.click(screen.getByRole("button", { name: "A4" }));
    expect(mocks.updateNote).not.toHaveBeenCalled();
  });

  it("queues a second press instead of dropping it while a save is open", async () => {
    const user = userEvent.setup();
    let settleFirst: (value: unknown) => void = () => undefined;
    mocks.updateNote.mockReturnValueOnce(
      new Promise((resolve) => {
        settleFirst = resolve;
      }),
    );
    mocks.updateNote.mockResolvedValueOnce(updated("a4", 5));
    view({ initialVersion: 3 });

    await user.click(screen.getByRole("button", { name: "US Letter" }));
    await waitFor(() => expect(saveRegion()).toHaveTextContent("Saving…"));

    // The control is never `aria-disabled` mid-save: the press is coalesced
    // into the next patch rather than being refused.
    const a4 = screen.getByRole("button", { name: "A4" });
    expect(a4).not.toHaveAttribute("aria-disabled");
    await user.click(a4);
    expect(mocks.updateNote).toHaveBeenCalledTimes(1);

    settleFirst(updated("letter", 4));
    await waitFor(() => expect(mocks.updateNote).toHaveBeenCalledTimes(2));
    expect(mocks.updateNote).toHaveBeenLastCalledWith(
      WORKSPACE_ID,
      NOTE_ID,
      { expectedVersion: 4, pageSize: "a4" },
      { keepalive: false },
    );
  });
});

describe("PageContainer save status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Queued `mockResolvedValueOnce` values survive `clearAllMocks`, so an
    // unconsumed one would answer the next test's first request.
    mocks.updateNote.mockReset();
    window.localStorage.clear();
  });

  it("starts with nothing to report and never renders a toast", () => {
    view();
    expect(saveRegion()).toHaveTextContent("No unsaved changes.");
    expect(saveRegion()).toHaveAttribute("aria-live", "polite");
    expect(screen.queryByRole("button", { name: "Retry saving" })).not.toBeInTheDocument();
  });

  it("keeps a save in progress visible while it is on the wire", async () => {
    const user = userEvent.setup();
    mocks.updateNote.mockReturnValueOnce(new Promise(() => undefined));
    view();

    await user.click(screen.getByRole("button", { name: "US Letter" }));
    await waitFor(() => expect(saveRegion()).toHaveTextContent("Saving…"));
    expect(saveRegion()).toHaveAttribute("data-save-status", "saving");
  });
});

/**
 * Backoff has to be driven by fake timers, so these live in their own suite:
 * a test that times out while fake timers are installed would otherwise leave
 * them installed for every suite that follows.
 */
describe("PageContainer save retries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.updateNote.mockReset();
    window.localStorage.clear();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function settle(ms: number): Promise<void> {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  it("retries an outage on its own and offers a manual retry once it gives up", async () => {
    mocks.updateNote.mockResolvedValue({ ok: false, kind: "unavailable", retryable: true });
    view({ initialVersion: 3 });

    fireEvent.click(screen.getByRole("button", { name: "US Letter" }));
    await settle(0);
    expect(saveRegion()).toHaveTextContent(/Retrying/u);

    // 1s, 2s, 4s and 8s of backoff, then it stops rather than looping forever.
    await settle(60_000);
    expect(mocks.updateNote).toHaveBeenCalledTimes(5);
    expect(saveRegion()).toHaveTextContent(/Couldn't save your changes/u);
    // The change definitively did not happen, so the toggle stops claiming it
    // did — while a document would never be rolled back this way.
    expect(paper()).toHaveAttribute("data-page-size", "a4");
    expect(screen.getByRole("button", { name: "Retry saving" })).toBeInTheDocument();
  });

  it("resumes from a manual retry when the outage has passed", async () => {
    mocks.updateNote.mockResolvedValueOnce({ ok: false, kind: "unavailable", retryable: true });
    mocks.updateNote.mockResolvedValue(updated("letter", 4));
    view({ initialVersion: 3 });

    fireEvent.click(screen.getByRole("button", { name: "US Letter" }));
    await settle(0);
    expect(saveRegion()).toHaveTextContent(/Retrying/u);

    await settle(1_000);
    expect(mocks.updateNote).toHaveBeenCalledTimes(2);
    expect(mocks.updateNote).toHaveBeenLastCalledWith(
      WORKSPACE_ID,
      NOTE_ID,
      { expectedVersion: 3, pageSize: "letter" },
      { keepalive: false },
    );
    expect(saveRegion()).toHaveTextContent("Saved.");
    expect(paper()).toHaveAttribute("data-page-size", "letter");
  });
});

describe("PageContainer focus mode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Queued `mockResolvedValueOnce` values survive `clearAllMocks`, so an
    // unconsumed one would answer the next test's first request.
    mocks.updateNote.mockReset();
    window.localStorage.clear();
  });

  function toggle(): HTMLElement {
    return screen.getByRole("button", { name: "Focus mode" });
  }

  function focusAttribute(): string | null {
    return document.documentElement.getAttribute(FOCUS_MODE_ATTRIBUTE);
  }

  it("reports its state through aria-pressed and drives the document attribute", async () => {
    const user = userEvent.setup();
    view();
    expect(toggle()).toHaveAttribute("aria-pressed", "false");
    expect(focusAttribute()).toBeNull();

    await user.click(toggle());
    expect(toggle()).toHaveAttribute("aria-pressed", "true");
    expect(focusAttribute()).toBe("true");

    await user.click(toggle());
    expect(toggle()).toHaveAttribute("aria-pressed", "false");
    // Removed, not set to "false": the CSS hook selects on presence, so a stuck
    // attribute would hide the navigation on every other page.
    expect(focusAttribute()).toBeNull();
  });

  it("is operable from the keyboard alone", async () => {
    const user = userEvent.setup();
    view();
    toggle().focus();
    expect(toggle()).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(focusAttribute()).toBe("true");
    await user.keyboard(" ");
    expect(focusAttribute()).toBeNull();
  });

  it("announces entering and leaving politely", async () => {
    const user = userEvent.setup();
    view();
    // Nothing is announced on mount: no one chose a mode yet.
    expect(liveRegion()).toHaveTextContent("");

    await user.click(toggle());
    expect(liveRegion()).toHaveTextContent(/Focus mode on\./u);
    expect(liveRegion()).toHaveTextContent(/Press Escape to leave focus mode\./u);

    await user.click(toggle());
    expect(liveRegion()).toHaveTextContent("Focus mode off. The full layout is restored.");
  });

  it("announces a change made anywhere else, such as the editor's keyboard shortcut", async () => {
    view();
    await waitFor(() => expect(toggle()).toHaveAttribute("aria-pressed", "false"));
    setFocusMode(true);
    await waitFor(() => expect(toggle()).toHaveAttribute("aria-pressed", "true"));
    expect(liveRegion()).toHaveTextContent(/Focus mode on\./u);
  });

  it("leaves on Escape and returns focus to the toggle", async () => {
    const user = userEvent.setup();
    view();
    await user.click(toggle());
    expect(focusAttribute()).toBe("true");

    // Focus is somewhere else entirely, the way it would be while writing.
    screen.getByRole("region", { name: "Note page" }).focus();
    await user.keyboard("{Escape}");

    expect(focusAttribute()).toBeNull();
    expect(toggle()).toHaveFocus();
  });

  it("ignores an Escape another surface already handled", async () => {
    const user = userEvent.setup();
    view();
    await user.click(toggle());
    // A slash menu, mention menu, or dialog consumes Escape and calls
    // `preventDefault`; closing it must not also drop out of focus mode.
    const handled = new KeyboardEvent("keydown", {
      key: "Escape",
      cancelable: true,
      bubbles: true,
    });
    handled.preventDefault();
    document.dispatchEvent(handled);
    expect(focusAttribute()).toBe("true");
  });

  it("hides the layout controls but never the toggle itself", async () => {
    const user = userEvent.setup();
    view();
    await user.click(toggle());

    // Focus mode hides chrome through `data-notted-focus-hide`; the toggle is
    // deliberately not marked, or there would be no way back by mouse and
    // nothing for Escape to restore focus to.
    expect(screen.getByRole("group", { name: "Zoom controls" })).toHaveAttribute(
      "data-notted-focus-hide",
    );
    expect(screen.getByRole("group", { name: "Page size" })).toHaveAttribute(
      "data-notted-focus-hide",
    );
    expect(toggle()).not.toHaveAttribute("data-notted-focus-hide");
    expect(toggle()).toBeVisible();
  });

  it("restores the prior layout when the page unmounts", async () => {
    const user = userEvent.setup();
    const { unmount } = view();
    await user.click(toggle());
    expect(focusAttribute()).toBe("true");

    unmount();
    expect(focusAttribute()).toBeNull();
    expect(isFocusModeEnabled()).toBe(false);
  });

  it("stays available without edit access, because reading needs no write permission", async () => {
    const user = userEvent.setup();
    view({ canUpdate: false });
    await user.click(toggle());
    expect(focusAttribute()).toBe("true");
    expect(mocks.updateNote).not.toHaveBeenCalled();
  });
});
