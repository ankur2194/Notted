import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PresenceBar } from "./PresenceBar";

import type { NoteCollaborationStatus } from "@/lib/collaboration/note-collaboration-provider";
import type { PresenceRoster, PresenceViewer } from "@/lib/realtime/presence-store";
import type { WorkspaceMemberPage } from "@notted/shared-types";

import { PRESENCE_ROSTER_MAX } from "@/lib/realtime/presence-store";

const mocks = vi.hoisted(() => ({ fetchWorkspaceMemberDirectory: vi.fn() }));
vi.mock("@/lib/notes/member-directory", () => ({
  fetchWorkspaceMemberDirectory: mocks.fetchWorkspaceMemberDirectory,
}));

const WORKSPACE_ID = "30000000-0000-4000-8000-000000000001";

/** Named members the directory can resolve. Index 0 is the local session. */
const PEOPLE = [
  "Ada Lovelace",
  "Alan Turing",
  "Grace Hopper",
  "Katherine Johnson",
  "Edsger Dijkstra",
  "Barbara Liskov",
  "Donald Knuth",
] as const;

function userIdAt(index: number): string {
  return `30000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

const UNKNOWN_ID = "99999999-9999-4999-8999-999999999999";

function memberPage(count: number): WorkspaceMemberPage {
  return {
    items: Array.from({ length: count }, (_unused, index) => ({
      id: userIdAt(index),
      userId: userIdAt(index),
      workspaceId: WORKSPACE_ID,
      name: PEOPLE[index] ?? `Member ${index}`,
      email: `member${index}@example.test`,
      role: "editor" as const,
      joinedAt: "2026-08-01T00:00:00.000Z",
    })),
    page: 1,
    limit: 100,
    hasMore: false,
  } as WorkspaceMemberPage;
}

function viewer(index: number, userId: string = userIdAt(index)): PresenceViewer {
  return {
    presenceId: `presence-${index}`,
    userId,
    colorIndex: index % 8,
    awarenessClientId: 1000 + index,
  };
}

function roster(viewers: readonly PresenceViewer[], overflow = false): PresenceRoster {
  return {
    viewers,
    selfPresenceId: viewers[0]?.presenceId ?? null,
    viewerCount: viewers.length,
    overflow,
  };
}

function view(options: {
  readonly roster: PresenceRoster;
  readonly status?: NoteCollaborationStatus;
  readonly mode?: "pending" | "collaborative" | "solo";
  readonly onReconnect?: () => void;
}) {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <PresenceBar
        mode={options.mode ?? "collaborative"}
        status={options.status ?? "synced"}
        workspaceId={WORKSPACE_ID}
        roster={options.roster}
        selfUserId={userIdAt(0)}
        onReconnect={options.onReconnect ?? (() => {})}
      />
    </QueryClientProvider>,
  );
}

function statusElements(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-collab-status]"));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.fetchWorkspaceMemberDirectory.mockResolvedValue(memberPage(PEOPLE.length));
});

describe("PresenceBar connection status", () => {
  it("renders exactly one status element, and Part 58's vocabulary", async () => {
    const cases: ReadonlyArray<readonly [NoteCollaborationStatus, string]> = [
      ["connecting", "Connecting to live editing"],
      ["synced", "Live editing"],
      ["reconnecting", "Reconnecting"],
      [
        "offline",
        "Offline — changes sync when you reconnect, and are lost if you close this tab first",
      ],
      ["error", "Live editing unavailable — saving normally"],
    ];

    for (const [status, message] of cases) {
      const { unmount } = view({ roster: roster([viewer(0)]), status });

      const elements = statusElements();
      expect(elements).toHaveLength(1);
      const element = elements[0];
      expect(element?.getAttribute("data-collab-status")).toBe(status);
      // One viewer is the local session, so no peer suffix is appended.
      expect(element?.textContent).toBe(message);

      unmount();
    }
  });

  it("counts everyone except this session as a peer", () => {
    view({ roster: roster([viewer(0), viewer(1), viewer(2)]), status: "synced" });
    expect(statusElements()[0]?.textContent).toBe("Live editing · 2 others editing");
  });

  it("renders no status in solo mode", () => {
    view({ roster: roster([viewer(0)]), mode: "solo" });
    expect(statusElements()).toHaveLength(0);
  });
});

describe("PresenceBar reconnect", () => {
  it.each(["reconnecting", "offline", "error"] as const)(
    "offers a never-disabled Reconnect for %s",
    async (status) => {
      const onReconnect = vi.fn();
      view({ roster: roster([viewer(0)]), status, onReconnect });

      const button = screen.getByRole("button", { name: "Reconnect" });
      expect(button).not.toBeDisabled();
      expect(button).not.toHaveAttribute("disabled");

      await userEvent.click(button);
      expect(onReconnect).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["connecting", "synced"] as const)("offers no Reconnect for %s", (status) => {
    view({ roster: roster([viewer(0)]), status });
    expect(screen.queryByRole("button", { name: "Reconnect" })).toBeNull();
  });
});

describe("PresenceBar viewer list", () => {
  it("renders nothing when this session is alone", () => {
    view({ roster: roster([viewer(0)]) });
    expect(screen.queryByTestId("note-presence-initials")).toBeNull();
    expect(screen.queryByTestId("note-presence-trigger")).toBeNull();
    // The status line still stands on its own.
    expect(statusElements()).toHaveLength(1);
  });

  it("collapses past five initials into a count", async () => {
    view({ roster: roster(PEOPLE.map((_unused, index) => viewer(index))) });

    const initials = await screen.findByTestId("note-presence-initials");
    await waitFor(() => expect(within(initials).getByText("AL")).toBeInTheDocument());

    // Five initials plus one "+N more" chip, for seven viewers.
    expect(within(initials).getByText("+2 more")).toBeInTheDocument();
    expect(initials.querySelectorAll("[data-presence-initial]")).toHaveLength(5);
  });

  it("keeps the initials row silent", () => {
    view({ roster: roster([viewer(0), viewer(1)]) });
    expect(screen.getByTestId("note-presence-initials")).toHaveAttribute("aria-live", "off");
  });

  it("names every shown viewer and the remainder on the trigger", async () => {
    view({ roster: roster(PEOPLE.map((_unused, index) => viewer(index))) });

    await waitFor(() =>
      expect(screen.getByTestId("note-presence-trigger")).toHaveAttribute(
        "aria-label",
        "Viewers: Ada Lovelace, Alan Turing, Grace Hopper, Katherine Johnson, Edsger Dijkstra and 2 more (7 viewers)",
      ),
    );
  });

  it("lists every viewer in the dialog", async () => {
    view({ roster: roster([viewer(0), viewer(1), viewer(2)]) });

    await waitFor(() =>
      expect(screen.getByTestId("note-presence-trigger")).toHaveAttribute(
        "aria-label",
        "Viewers: Ada Lovelace, Alan Turing, Grace Hopper (3 viewers)",
      ),
    );
    await userEvent.click(screen.getByTestId("note-presence-trigger"));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("3 viewers")).toBeInTheDocument();

    const items = within(dialog).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    // The local session is marked so a reader does not hunt for themselves.
    expect(items[0]).toHaveTextContent("Ada Lovelace (you)");
    expect(items[1]).toHaveTextContent("Alan Turing");
    expect(items[2]).toHaveTextContent("Grace Hopper");
    for (const item of items) {
      expect(item).toHaveAttribute("data-presence-name-state", "known");
    }
  });

  it("renders an id the directory cannot resolve as an unnamed viewer", async () => {
    view({ roster: roster([viewer(0), { ...viewer(1), userId: UNKNOWN_ID }]) });

    await waitFor(() => expect(mocks.fetchWorkspaceMemberDirectory).toHaveBeenCalled());
    await userEvent.click(await screen.findByTestId("note-presence-trigger"));

    const dialog = await screen.findByRole("dialog");
    const items = within(dialog).getAllByRole("listitem");
    expect(items[1]).toHaveTextContent("Workspace member");
    expect(items[1]).toHaveAttribute("data-presence-name-state", "unknown");
  });

  it("keeps working when the directory request fails", async () => {
    mocks.fetchWorkspaceMemberDirectory.mockRejectedValue(new Error("unavailable"));
    view({ roster: roster([viewer(0), viewer(1)]) });

    await waitFor(() => expect(mocks.fetchWorkspaceMemberDirectory).toHaveBeenCalled());
    // Presence is decoration: unnamed viewers, and the status line intact.
    expect(screen.getByTestId("note-presence-trigger")).toHaveAttribute(
      "aria-label",
      "Viewers: Workspace member, Workspace member (2 viewers)",
    );
    expect(statusElements()).toHaveLength(1);
  });

  it("reports a count instead of a roster when the server refused to list", () => {
    view({ roster: roster([viewer(0), viewer(1)], true) });

    expect(screen.getByTestId("note-presence-overflow")).toHaveTextContent(
      `${PRESENCE_ROSTER_MAX}+ viewers — too many to list`,
    );
    expect(screen.queryByTestId("note-presence-initials")).toBeNull();
    expect(statusElements()).toHaveLength(1);
  });
});
