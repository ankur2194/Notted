import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { SaveStatusIndicator } from "./SaveStatusIndicator";

import type { AutosaveDescription, AutosaveStatus } from "@/lib/notes/autosave-machine";

function view(
  options: {
    readonly status?: AutosaveStatus;
    readonly description?: Partial<AutosaveDescription>;
    readonly documentRejected?: boolean;
    readonly onRetry?: () => void;
    readonly onReload?: () => void;
  } = {},
) {
  const description: AutosaveDescription = {
    message: "Saved.",
    canRetry: false,
    canReload: false,
    severity: "info",
    ...options.description,
  };
  return render(
    <SaveStatusIndicator
      status={options.status ?? "saved"}
      description={description}
      documentRejected={options.documentRejected ?? false}
      onRetry={options.onRetry ?? vi.fn()}
      onReload={options.onReload ?? vi.fn()}
    />,
  );
}

function statusRegion(): HTMLElement {
  return screen.getByTestId("note-save-status");
}

describe("SaveStatusIndicator", () => {
  it("announces the state politely and in full, not by colour alone", () => {
    view({ status: "saving", description: { message: "Saving…" } });
    const region = statusRegion();

    expect(region).toHaveAttribute("aria-live", "polite");
    expect(region).toHaveAttribute("aria-atomic", "true");
    expect(region).toHaveAttribute("role", "status");
    expect(region).toHaveAttribute("data-save-status", "saving");
    expect(region).toHaveTextContent("Saving…");
  });

  it("offers no affordance while everything is saved", () => {
    view();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(statusRegion()).toHaveTextContent("Saved.");
  });

  it("offers a keyboard-reachable retry when the failure is worth repeating", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    view({
      status: "error",
      description: { message: "Couldn't save.", canRetry: true, severity: "error" },
      onRetry,
    });

    const retry = screen.getByRole("button", { name: "Retry saving" });
    // Never natively disabled, so it cannot leave the tab order under focus.
    expect(retry).not.toBeDisabled();
    retry.focus();
    expect(retry).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("offers reload on a conflict and never a retry alongside it", async () => {
    const user = userEvent.setup();
    const onReload = vi.fn();
    view({
      status: "conflict",
      description: {
        message: "This note changed somewhere else.",
        canReload: true,
        severity: "error",
      },
      onReload,
    });

    expect(screen.queryByRole("button", { name: "Retry saving" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Reload latest version" }));
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it("raises a separate alert when the editor produced content the contract rejects", () => {
    view({ status: "saved", documentRejected: true });

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(/does not allow, so it was not saved/u);
    expect(alert).toHaveTextContent(/until you undo it/u);
    // The status line keeps telling its own truth; the rejection does not
    // replace it, because saving the *previous* content really did succeed.
    expect(statusRegion()).toHaveTextContent("Saved.");
  });

  it("shows no rejection alert once the content is valid again", () => {
    view({ documentRejected: false });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps itself out of a printed note", () => {
    const { container } = view();
    expect(container.querySelector("[data-notted-print-hide]")).not.toBeNull();
  });
});
