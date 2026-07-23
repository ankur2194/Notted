import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const { toastSpy } = vi.hoisted(() => ({ toastSpy: vi.fn() }));

vi.mock("sonner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("sonner")>();
  return { ...actual, toast: toastSpy };
});

import { CreateNoteDialog } from "@/components/demo/create-note-dialog";

afterEach(() => {
  toastSpy.mockClear();
});

async function openDialog() {
  const user = userEvent.setup();
  const trigger = screen.getByRole("button", { name: "Open UI preview" });
  await user.click(trigger);
  return { user, trigger, dialog: await screen.findByRole("dialog") };
}

describe("CreateNoteDialog", () => {
  it("associates its accessible name and description and initially focuses a control", async () => {
    render(<CreateNoteDialog />);
    const { dialog } = await openDialog();

    expect(dialog).toHaveAccessibleName("Notification preview");
    expect(dialog).toHaveAccessibleDescription(
      "Preview the dialog and notification primitives. This action does not create or save anything.",
    );
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();
  });

  it("contains forward and reverse tab focus", async () => {
    render(<CreateNoteDialog />);
    const { user, dialog } = await openDialog();
    const close = within(dialog).getByRole("button", { name: "Close" });
    const cancel = within(dialog).getByRole("button", { name: "Cancel" });

    await user.keyboard("{Shift>}{Tab}{/Shift}");
    expect(close).toHaveFocus();
    await user.tab();
    expect(cancel).toHaveFocus();
  });

  it.each([
    ["Escape", "{Escape}", "Close"],
    ["explicit cancel", null, "Cancel"],
    ["close control", null, "Close"],
  ])("dismisses with %s and restores trigger focus", async (_label, key, buttonName) => {
    render(<CreateNoteDialog />);
    const { user, trigger, dialog } = await openDialog();

    if (key) await user.keyboard(key);
    else await user.click(within(dialog).getByRole("button", { name: buttonName }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("dismisses after the preview action and makes the exact toast call", async () => {
    render(<CreateNoteDialog />);
    const { user, trigger, dialog } = await openDialog();

    await user.click(within(dialog).getByRole("button", { name: "Show notification" }));

    expect(toastSpy).toHaveBeenCalledOnce();
    expect(toastSpy).toHaveBeenCalledWith("Notifications will appear here.", {
      description: "This is a UI preview; no note or other data was created.",
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});
