import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import {
  EDITOR_SHORTCUTS,
  EDITOR_SHORTCUT_GROUPS,
  describeShortcutKeys,
  editorShortcutsForGroup,
  formatShortcutKeys,
} from "./keyboard-shortcuts";
import { KeyboardShortcutsDialog } from "./KeyboardShortcutsDialog";

import { renderEditor } from "@/test/editor-harness";

function DialogHarness() {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>
        Open shortcuts
      </button>
      <KeyboardShortcutsDialog open={open} onOpenChange={setOpen} />
    </div>
  );
}

describe("keyboard shortcuts dialog", () => {
  it("lists every declared binding, grouped, with visible and spoken keys", async () => {
    const user = userEvent.setup();
    render(<DialogHarness />);
    await user.click(screen.getByRole("button", { name: "Open shortcuts" }));

    const dialog = await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
    for (const group of EDITOR_SHORTCUT_GROUPS) {
      if (editorShortcutsForGroup(group.id).length === 0) continue;
      expect(within(dialog).getByRole("heading", { name: group.label })).toBeInTheDocument();
    }

    for (const shortcut of EDITOR_SHORTCUTS) {
      const row = dialog.querySelector(`[data-shortcut-id="${shortcut.id}"]`);
      expect(row, `missing row for ${shortcut.id}`).not.toBeNull();
      if (row === null) continue;
      expect(row).toHaveTextContent(shortcut.description);
      // jsdom reports a non-Apple platform, so the Ctrl rendition is expected.
      const caps = Array.from(row.querySelectorAll("kbd")).map((cap) => cap.textContent);
      expect(caps).toEqual([...formatShortcutKeys(shortcut.binding, false)]);
      expect(row).toHaveTextContent(describeShortcutKeys(shortcut.binding, false));
    }

    const rows = dialog.querySelectorAll("[data-shortcut-id]");
    expect(rows).toHaveLength(EDITOR_SHORTCUTS.length);
  });

  it("closes on Escape and restores focus to the trigger", async () => {
    const user = userEvent.setup();
    render(<DialogHarness />);
    const trigger = screen.getByRole("button", { name: "Open shortcuts" });
    trigger.focus();
    await user.click(trigger);

    const dialog = await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));

    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Keyboard shortcuts" })).not.toBeInTheDocument(),
    );
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("opens from the editor toolbar button and restores focus to it", async () => {
    const { user } = await renderEditor();
    const trigger = screen.getByRole("button", { name: /^Keyboard shortcuts/u });
    await user.click(trigger);

    await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Keyboard shortcuts" })).not.toBeInTheDocument(),
    );
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("stays reachable from the toolbar when the note is read only", async () => {
    const { user } = await renderEditor({ editable: false });
    await user.click(screen.getByRole("button", { name: /^Keyboard shortcuts/u }));
    expect(await screen.findByRole("dialog", { name: "Keyboard shortcuts" })).toBeInTheDocument();
  });
});
