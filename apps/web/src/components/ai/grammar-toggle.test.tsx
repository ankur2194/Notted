import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Part 70 — the enablement switch, and the one thing that must happen before it
 * can be switched on for the first time.
 *
 * The control store is mocked at its module boundary: `grammar-control` has its
 * own suite, and what THIS file is about is the ordering — disclose, confirm,
 * only then enable — which belongs entirely to this component.
 */
const grammarControl = vi.hoisted(() => ({ useGrammarControl: vi.fn() }));
vi.mock("@/lib/ai/grammar-control", () => grammarControl);

import { GrammarToggle } from "./GrammarToggle";

import type { GrammarControl } from "@/lib/ai/grammar-control";

const setEnabled = vi.fn();

function control(overrides: Partial<GrammarControl> = {}): GrammarControl {
  return {
    enabled: false,
    acknowledged: false,
    checking: false,
    count: 0,
    announcement: "",
    setEnabled,
    ...overrides,
  };
}

function renderToggle(value: GrammarControl | null) {
  grammarControl.useGrammarControl.mockReturnValue(value);
  return render(<GrammarToggle />);
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("GrammarToggle", () => {
  it("renders nothing when no control is registered", () => {
    const { container } = renderToggle(null);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the disclosure on the first enable and turns nothing on until it is confirmed", async () => {
    renderToggle(control());

    await userEvent.click(screen.getByTestId("ai-grammar-toggle"));

    expect(await screen.findByTestId("grammar-disclosure")).toBeInTheDocument();
    // The disclosure names what leaves the browser, what is not kept, and whose
    // setting this is.
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent(/AI provider this workspace has configured/u);
    expect(dialog).toHaveTextContent(/stores neither that text nor the suggestions/u);
    expect(dialog).toHaveTextContent(/stored in this browser/u);
    expect(setEnabled).not.toHaveBeenCalled();

    await userEvent.click(screen.getByTestId("grammar-disclosure-confirm"));
    expect(setEnabled).toHaveBeenCalledWith(true);
  });

  it("leaves grammar check off when the disclosure is cancelled", async () => {
    renderToggle(control());

    await userEvent.click(screen.getByTestId("ai-grammar-toggle"));
    await userEvent.click(await screen.findByTestId("grammar-disclosure-cancel"));

    expect(setEnabled).not.toHaveBeenCalled();
    expect(screen.queryByTestId("grammar-disclosure")).toBeNull();
    expect(screen.getByTestId("ai-grammar-toggle")).toHaveAttribute("aria-pressed", "false");
  });

  it("skips the disclosure once it has been acknowledged", async () => {
    renderToggle(control({ acknowledged: true }));

    await userEvent.click(screen.getByTestId("ai-grammar-toggle"));

    expect(setEnabled).toHaveBeenCalledWith(true);
    expect(screen.queryByTestId("grammar-disclosure")).toBeNull();
  });

  it("turns off without a disclosure", async () => {
    renderToggle(control({ enabled: true, acknowledged: true }));

    const toggle = screen.getByTestId("ai-grammar-toggle");
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(toggle);

    expect(setEnabled).toHaveBeenCalledWith(false);
    expect(screen.queryByTestId("grammar-disclosure")).toBeNull();
  });

  it("reports how many suggestions the note carries", () => {
    renderToggle(control({ enabled: true, acknowledged: true, count: 3 }));

    expect(screen.getByTestId("note-ai-grammar-count")).toHaveTextContent(
      "3 suggestions in this note",
    );
  });

  it("says a check is running instead of reporting a stale count", () => {
    renderToggle(control({ enabled: true, acknowledged: true, count: 3, checking: true }));

    expect(screen.getByTestId("note-ai-grammar-count")).toHaveTextContent("Checking…");
  });

  it("shows no count at all while grammar check is off", () => {
    renderToggle(control());

    expect(screen.queryByTestId("note-ai-grammar-count")).toBeNull();
  });

  it("announces through one polite region", () => {
    renderToggle(
      control({ enabled: true, acknowledged: true, announcement: "4 suggestions found" }),
    );

    const region = screen.getByTestId("note-ai-grammar-announcement");
    expect(region).toHaveTextContent("4 suggestions found");
    expect(region).toHaveAttribute("aria-live", "polite");
    expect(region).toHaveAttribute("aria-atomic", "true");
    expect(screen.getAllByRole("status")).toHaveLength(1);
  });
});
