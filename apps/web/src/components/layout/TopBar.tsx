"use client";

import { Menu, Search, UserRound } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState, type RefObject } from "react";

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
  const searchTrigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    function keyboard(event: KeyboardEvent): void {
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
        <div className="relative">
          <Button
            ref={userButton}
            variant="ghost"
            size="icon"
            className="min-h-11 min-w-11"
            aria-label="Open user menu"
            aria-haspopup="menu"
            aria-expanded={userOpen}
            onClick={() => setUserOpen((value) => !value)}
          >
            <UserRound aria-hidden="true" />
          </Button>
          {userOpen && (
            <div
              role="menu"
              className="absolute right-0 mt-2 w-64 rounded-lg border bg-popover p-2 shadow-lg"
            >
              <div className="border-b px-3 py-2">
                <p className="truncate text-sm font-medium">{shell.user.name}</p>
                <p className="truncate text-xs text-muted-foreground">{shell.user.email}</p>
              </div>
              <Link
                role="menuitem"
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
