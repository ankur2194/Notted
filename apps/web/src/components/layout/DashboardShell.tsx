"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";

import type { BreadcrumbItem } from "./Breadcrumb";
import type { ShellBootstrap } from "@notted/shared-types";
import type { ReactNode } from "react";

import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { readSidebarPreference, writeSidebarPreference } from "@/lib/shell/sidebar-preference";

function breadcrumbsFor(pathname: string): readonly BreadcrumbItem[] {
  if (pathname === "/") return [{ label: "Dashboard" }];
  if (pathname === "/settings/security") return [{ label: "Settings" }, { label: "Security" }];
  if (pathname === "/workspaces") return [{ label: "Workspaces" }];
  const workspaceMatch = /^\/workspaces\/([^/]+)(\/settings)?$/.exec(pathname);
  if (workspaceMatch) {
    const items: BreadcrumbItem[] = [{ label: "Workspaces", href: "/workspaces" }];
    if (workspaceMatch[2] === "/settings") {
      items.push({ label: "Overview", href: `/workspaces/${workspaceMatch[1]}` });
      items.push({ label: "Settings" });
    } else {
      items.push({ label: "Overview" });
    }
    return items;
  }
  return pathname
    .split("/")
    .filter(Boolean)
    .map((segment) => ({ label: segment.replaceAll("-", " ") }));
}

export function DashboardShell({
  shell,
  children,
}: {
  readonly shell: ShellBootstrap;
  readonly children: ReactNode;
}) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const mobileTrigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setCollapsed(
      readSidebarPreference(typeof window === "undefined" ? null : window.localStorage) ===
        "collapsed",
    );
  }, []);

  function toggleSidebar(): void {
    setCollapsed((current) => {
      const next = !current;
      writeSidebarPreference(
        typeof window === "undefined" ? null : window.localStorage,
        next ? "collapsed" : "expanded",
      );
      return next;
    });
  }

  return (
    <div className="min-h-dvh bg-background">
      <a href="#workspace-navigation" className="skip-link">
        Skip to workspace navigation
      </a>
      <div
        id="workspace-navigation"
        tabIndex={-1}
        className={`fixed inset-y-0 left-0 z-40 hidden border-r md:block ${collapsed ? "w-20" : "w-72"}`}
      >
        <Sidebar shell={shell} collapsed={collapsed} onToggle={toggleSidebar} />
      </div>
      <Dialog open={mobileOpen} onOpenChange={setMobileOpen}>
        <DialogContent
          className="left-0 top-0 h-dvh max-h-dvh w-[min(22rem,88vw)] max-w-none translate-x-0 translate-y-0 gap-0 rounded-none p-0"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            mobileTrigger.current?.focus();
          }}
        >
          <DialogTitle className="sr-only">Workspace navigation</DialogTitle>
          <DialogDescription className="sr-only">
            Navigate Notted and switch your current workspace.
          </DialogDescription>
          <Sidebar shell={shell} collapsed={false} mobile />
        </DialogContent>
      </Dialog>
      <div className={collapsed ? "md:pl-20" : "md:pl-72"}>
        <TopBar
          shell={shell}
          breadcrumbs={breadcrumbsFor(pathname)}
          onOpenNavigation={() => setMobileOpen(true)}
          navigationTriggerRef={mobileTrigger}
        />
        <main
          id="main-content"
          tabIndex={-1}
          className="min-h-[calc(100dvh-4rem)] px-4 py-6 sm:px-6 lg:px-10 lg:py-8"
        >
          {children}
        </main>
      </div>
    </div>
  );
}
