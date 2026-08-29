"use client";

import { Menu, Search, UserRound } from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useRef, useState, type RefObject } from "react";

import { Breadcrumb, type BreadcrumbItem } from "./Breadcrumb";
import { NotificationCenter } from "./NotificationCenter";

import type { ShellBootstrap } from "@notted/shared-types";

import { LogoutButton } from "@/components/auth/logout-button";
import { GlobalSearchDialog } from "@/components/search/GlobalSearchDialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogTrigger } from "@/components/ui/dialog";

export function TopBar({
  shell,
  breadcrumbs,
  onOpenNavigation,
  navigationTriggerRef,
}: {
  readonly shell: ShellBootstrap;
  readonly breadcrumbs: readonly BreadcrumbItem[];
  readonly onOpenNavigation: () => void;
  readonly navigationTriggerRef: RefObject<HTMLButtonElement | null>;
}) {
  const [commandOpen, setCommandOpen] = useState(false);
  const [userOpen, setUserOpen] = useState(false);
  const userButton = useRef<HTMLButtonElement>(null);
  const userMenu = useRef<HTMLDivElement>(null);
  const userMenuId = useId();
  const searchTrigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    function keyboard(event: KeyboardEvent): void {
      // A binding closer to the event already handled it — the editor's
      // `Mod-k` link chord, an open dialog's Escape. Following the
      // `PageContainer` precedent, a document-level listener never acts on a
      // keystroke someone nearer the target has claimed.
      if (event.defaultPrevented) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        // Do not double-open or toggle when the palette is already capturing
        // the chord: a Radix dialog open above us owns the next keystrokes.
        if (commandOpen) return;
        event.preventDefault();
        // Focus the trigger before opening so Radix restores focus to it on
        // close, even when the shortcut was pressed from elsewhere.
        searchTrigger.current?.focus();
        setCommandOpen(true);
      }
      if (event.key === "Escape" && userOpen) {
        setUserOpen(false);
        userButton.current?.focus();
      }
    }
    document.addEventListener("keydown", keyboard);
    return () => document.removeEventListener("keydown", keyboard);
  }, [userOpen, commandOpen]);

  /*
   * Clicking anywhere else closes it. `pointerdown` rather than `click` so the
   * panel is gone before the click lands on whatever is underneath — the same
   * ordering every popover in the design system relies on. The trigger is
   * excluded because its own `onClick` already toggles; without that, opening
   * would close in the same gesture.
   */
  useEffect(() => {
    if (!userOpen) return;
    function onPointerDown(event: PointerEvent): void {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (userMenu.current?.contains(target) === true) return;
      if (userButton.current?.contains(target) === true) return;
      setUserOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [userOpen]);
  return (
    <header
      className="sticky top-0 z-30 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/85"
      data-notted-focus-hide
      data-notted-print-hide
    >
      <div className="flex min-h-16 items-center gap-2 px-3 sm:px-5">
        <Button
          ref={navigationTriggerRef}
          variant="ghost"
          size="icon"
          className="min-h-11 min-w-11 md:hidden"
          onClick={onOpenNavigation}
          aria-label="Open navigation"
        >
          <Menu aria-hidden="true" />
        </Button>
        <div className="min-w-0 flex-1">
          <Breadcrumb items={breadcrumbs} />
        </div>
        <Dialog open={commandOpen} onOpenChange={setCommandOpen}>
          <DialogTrigger asChild>
            <Button
              ref={searchTrigger}
              variant="outline"
              className="min-h-11 min-w-0 justify-start text-muted-foreground sm:w-40 lg:w-52"
              aria-label="Open command menu and search"
            >
              <Search aria-hidden="true" />
              <span className="hidden sm:inline">Search or run a command</span>
              <kbd className="ml-auto hidden text-xs xl:inline">Ctrl K</kbd>
            </Button>
          </DialogTrigger>
          <GlobalSearchDialog
            workspaceId={shell.currentWorkspace?.workspaceId ?? null}
            open={commandOpen}
            onOpenChange={setCommandOpen}
          />
        </Dialog>
        <NotificationCenter
          workspaceId={shell.currentWorkspace?.workspaceId ?? null}
          initialUnreadCount={shell.notificationUnreadCount}
        />
        {/*
         * A disclosure, not a menu.
         *
         * This was `role="menu"` with `role="menuitem"` children and none of the
         * APG keyboard model behind it — no arrow navigation, no focus
         * containment, no outside-click close, and a `LogoutButton` child that
         * was never a `menuitem` at all. A `role="menu"` that does not implement
         * the model is worse than no role: it promises a screen reader arrow
         * navigation that does not exist.
         *
         * APG's own answer for a short list of links and actions is Disclosure —
         * `<button aria-expanded>` plus revealed content — which needs no roving
         * tab index, no focus containment and no arrow keys, because native Tab
         * through DOM order is already correct. There is no Radix
         * dropdown-menu primitive in this repo (`ImageToolbar` records declining
         * to add one as a repo-wide decision), and `Dialog` is worse still: it
         * announces "dialog", traps focus and renders a modal overlay for two
         * items.
         *
         * Net a deletion of ARIA, plus the outside-click close the menu never
         * had. Escape is handled with the other bindings above.
         */}
        <div className="relative">
          <Button
            ref={userButton}
            variant="ghost"
            size="icon"
            className="min-h-11 min-w-11"
            aria-label="User menu"
            aria-expanded={userOpen}
            aria-controls={userMenuId}
            onClick={() => setUserOpen((value) => !value)}
          >
            <UserRound aria-hidden="true" />
          </Button>
          {userOpen && (
            <div
              ref={userMenu}
              id={userMenuId}
              className="absolute right-0 mt-2 w-64 rounded-lg border bg-popover p-2 shadow-lg"
            >
              <div className="border-b px-3 py-2">
                <p className="truncate text-sm font-medium">{shell.user.name}</p>
                <p className="truncate text-xs text-muted-foreground">{shell.user.email}</p>
              </div>
              <Link
                href="/settings/security"
                className="mt-1 flex min-h-11 items-center rounded-md px-3 text-sm hover:bg-accent"
              >
                Security settings
              </Link>
              <div className="mt-1 border-t pt-2">
                <LogoutButton />
              </div>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
