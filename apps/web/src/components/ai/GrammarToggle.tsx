"use client";

import { LoaderCircle } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useGrammarControl } from "@/lib/ai/grammar-control";

/**
 * Part 70 — the per-user grammar and style switch, and the disclosure that has
 * to be read before it can be turned on.
 *
 * ## Why it takes no props
 *
 * The checking itself lives in `NoteEditorSurface`, so a note keeps being
 * checked whether or not this panel is open, and neither component is an
 * ancestor of the other. The hook registers a control on a module store and
 * this reads it — the same shape as `lib/ai/continue-request.ts`. `null` means
 * nothing is registered (no editor, no signed-in user, or a Part 56 historical
 * preview), and then this section does not exist at all.
 *
 * ## Why the disclosure gates the ON transition and nothing else
 *
 * Turning grammar check on is the moment note text starts leaving the browser
 * on its own, without the author pressing a button for each request. That is
 * the one thing a writer has to be told before it happens — so `setEnabled(true)`
 * is reachable ONLY from the dialog's confirm button until the disclosure has
 * been acknowledged. Turning it off starts nothing and shows nothing.
 */

const HINT_ID = "note-ai-grammar-hint";

export function GrammarToggle() {
  const control = useGrammarControl();
  const [disclosureOpen, setDisclosureOpen] = useState(false);

  // Hooks above run unconditionally; the render decision comes after them.
  if (control === null) return null;

  const handleToggle = (): void => {
    if (control.enabled) {
      control.setEnabled(false);
      return;
    }
    if (!control.acknowledged) {
      setDisclosureOpen(true);
      return;
    }
    control.setEnabled(true);
  };

  const countLabel = control.checking
    ? "Checking…"
    : control.count === 0
      ? "No suggestions in this note."
      : `${control.count} ${control.count === 1 ? "suggestion" : "suggestions"} in this note`;

  return (
    <div className="space-y-2 border-t pt-3" data-notted-print-hide>
      <h3 className="text-sm font-semibold">Grammar and style</h3>
      {/*
       * The chord is named HERE rather than added to `EDITOR_SHORTCUTS`, which
       * is a frozen registry wired through `TiptapEditor`'s `handlersRef` and the
       * `EditorShortcuts` extension — and that extension has to stay the LAST
       * entry of the extension array. Registering one chord would mean reopening
       * that ordering invariant to make a grammar popup discoverable, when the
       * control that turns the feature on is the place a reader is already
       * looking. Recorded as follow-up: promote it to the registry if a second
       * grammar chord ever appears.
       */}
      <p className="text-xs text-muted-foreground" id={HINT_ID}>
        Underlines grammar, spelling, and style suggestions in the note as you write. Select an
        underline to see the suggestion, or press Alt and the down arrow to open the one at your
        cursor — nothing is changed until you accept it.
      </p>

      {/*
       * This section's ONE polite region, mounted whether or not there is
       * anything to say: a live region created together with its text is
       * frequently not announced at all. `announcement` is already throttled by
       * `useGrammarControl`, so a fast typist is not flooded.
       */}
      <p
        className="sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-testid="note-ai-grammar-announcement"
      >
        {control.announcement}
      </p>

      <Button
        size="sm"
        variant={control.enabled ? "secondary" : "outline"}
        // No `switch` primitive exists in this repo; `aria-pressed` is the house
        // pattern for a two-state control (the tone and length groups above).
        aria-pressed={control.enabled}
        aria-describedby={HINT_ID}
        data-testid="ai-grammar-toggle"
        onClick={handleToggle}
      >
        {control.enabled ? "Grammar check on" : "Grammar check off"}
      </Button>

      {control.enabled ? (
        <p
          className="flex items-center gap-2 text-xs text-muted-foreground"
          data-testid="note-ai-grammar-count"
        >
          {control.checking ? (
            <LoaderCircle
              className="size-4 animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
          ) : null}
          {countLabel}
        </p>
      ) : null}

      <Dialog open={disclosureOpen} onOpenChange={setDisclosureOpen}>
        <DialogContent data-testid="grammar-disclosure">
          <DialogHeader>
            <DialogTitle>Before grammar check turns on</DialogTitle>
            <DialogDescription>
              Grammar check sends text out of this note to be checked. Here is exactly what that
              means.
            </DialogDescription>
          </DialogHeader>
          <ul className="list-disc space-y-2 pl-5 text-sm">
            <li>
              While it is on, the text of the blocks you edit is sent to the AI provider this
              workspace has configured, so that it can be checked.
            </li>
            <li>
              Notted stores neither that text nor the suggestions that come back. Nothing is written
              to your note until you accept a suggestion yourself.
            </li>
            <li>
              This setting is yours alone. It is stored in this browser and changes nothing for
              anyone else in the workspace.
            </li>
          </ul>
          <DialogFooter className="gap-2">
            <Button
              variant="ghost"
              data-testid="grammar-disclosure-cancel"
              onClick={() => setDisclosureOpen(false)}
            >
              Cancel
            </Button>
            <Button
              data-testid="grammar-disclosure-confirm"
              onClick={() => {
                // The ONLY place a first enable can happen.
                control.setEnabled(true);
                setDisclosureOpen(false);
              }}
            >
              Turn on grammar check
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
