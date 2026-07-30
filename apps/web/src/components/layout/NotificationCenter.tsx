"use client";

import { Bell, CheckCheck, LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";

import type { NotificationSummary } from "@notted/shared-types";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  loadNotifications,
  markAllNotificationsRead,
  setNotificationRead,
} from "@/lib/shell/requests";

export function NotificationCenter({
  workspaceId,
  initialUnreadCount,
}: {
  readonly workspaceId: string | null;
  readonly initialUnreadCount: number;
}) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<readonly NotificationSummary[]>([]);
  const [unreadCount, setUnreadCount] = useState(initialUnreadCount);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [announcement, setAnnouncement] = useState("");

  useEffect(() => {
    setUnreadCount(initialUnreadCount);
    setItems([]);
    setPage(1);
  }, [initialUnreadCount, workspaceId]);

  async function load(nextPage = 1): Promise<void> {
    if (workspaceId === null) return;
    setStatus("loading");
    const result = await loadNotifications(workspaceId, nextPage);
    if (!result.ok) {
      setStatus("error");
      return;
    }
    setItems((current) =>
      nextPage === 1 ? result.data.items : [...current, ...result.data.items],
    );
    setUnreadCount(result.data.unreadCount);
    setPage(nextPage);
    setHasMore(result.data.hasMore);
    setStatus("idle");
  }

  async function toggle(item: NotificationSummary): Promise<void> {
    if (workspaceId === null) return;
    const result = await setNotificationRead(workspaceId, item.id, item.readAt === null);
    if (!result.ok) {
      setAnnouncement("Notification update failed. Try again.");
      return;
    }
    setItems((current) =>
      current.map((value) => (value.id === item.id ? result.data.notification : value)),
    );
    setUnreadCount(result.data.unreadCount);
    setAnnouncement(
      result.data.notification.readAt === null
        ? "Notification marked unread."
        : "Notification marked read.",
    );
  }

  async function markAll(): Promise<void> {
    if (workspaceId === null) return;
    const result = await markAllNotificationsRead(workspaceId);
    if (!result.ok) {
      setAnnouncement("Could not mark notifications read. Try again.");
      return;
    }
    const readAt = new Date().toISOString();
    setItems((current) =>
      current.map((item) => (item.readAt === null ? { ...item, readAt } : item)),
    );
    setUnreadCount(0);
    setAnnouncement(`${result.data.updatedCount} notifications marked read.`);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next && items.length === 0) void load();
      }}
    >
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={`Notifications${unreadCount > 0 ? `, ${unreadCount} unread` : ""}`}
          disabled={workspaceId === null}
          className="relative min-h-11 min-w-11"
        >
          <Bell aria-hidden="true" />
          {unreadCount > 0 && (
            <span
              className="absolute right-0 top-0 min-w-5 rounded-full bg-destructive px-1 text-center text-xs font-bold text-destructive-foreground"
              aria-hidden="true"
            >
              {unreadCount > 99 ? "99+" : unreadCount}
            </span>
          )}
        </Button>
      </DialogTrigger>
      <DialogContent className="right-0 top-0 left-auto h-dvh max-h-dvh w-full max-w-md translate-x-0 translate-y-0 content-start rounded-none p-0 sm:right-4 sm:top-16 sm:h-auto sm:max-h-[calc(100dvh-5rem)] sm:w-[26rem] sm:rounded-xl">
        <DialogHeader className="border-b p-5 pr-12 text-left">
          <div className="flex items-center justify-between gap-3">
            <DialogTitle>Notifications</DialogTitle>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void markAll()}
              disabled={unreadCount === 0 || status === "loading"}
            >
              <CheckCheck aria-hidden="true" /> Mark all read
            </Button>
          </div>
          <DialogDescription>
            Updates for this workspace. Read state is saved to your account.
          </DialogDescription>
        </DialogHeader>
        <p className="sr-only" aria-live="polite">
          {announcement}
        </p>
        <div className="min-h-40 overflow-y-auto p-3">
          {status === "loading" && items.length === 0 && (
            <div
              className="flex min-h-40 items-center justify-center gap-2 text-sm text-muted-foreground"
              role="status"
            >
              <LoaderCircle className="animate-spin" aria-hidden="true" /> Loading notifications…
            </div>
          )}
          {status === "error" && (
            <div className="m-2 rounded-lg border border-destructive/40 p-4 text-sm" role="alert">
              <p>Notifications could not be loaded.</p>
              <Button className="mt-3" size="sm" variant="outline" onClick={() => void load(1)}>
                Retry
              </Button>
            </div>
          )}
          {status === "idle" && items.length === 0 && (
            <div
              className="grid min-h-40 place-items-center text-center text-sm text-muted-foreground"
              role="status"
            >
              You’re all caught up.
            </div>
          )}
          <ul className="space-y-2" aria-label="Notification list">
            {items.map((item) => (
              <li
                key={item.id}
                className={`rounded-lg border p-3 ${item.readAt === null ? "border-info/40 bg-info/5" : "bg-card"}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{item.summary}</p>
                    {item.targetLabel !== null && (
                      <p className="mt-1 truncate text-xs text-muted-foreground">
                        {item.targetLabel}
                      </p>
                    )}
                    <p className="mt-1 text-xs text-muted-foreground">
                      <time dateTime={item.createdAt}>
                        {new Date(item.createdAt).toLocaleString()}
                      </time>{" "}
                      · {item.kind}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void toggle(item)}
                    aria-label={`${item.readAt === null ? "Mark read" : "Mark unread"}: ${item.summary}`}
                  >
                    {item.readAt === null ? "Read" : "Unread"}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
          {hasMore && (
            <Button
              variant="outline"
              className="mt-3 w-full"
              onClick={() => void load(page + 1)}
              disabled={status === "loading"}
            >
              {status === "loading" ? "Loading…" : "Load more"}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
