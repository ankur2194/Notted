import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TagManager } from "./TagManager";

import type { TagPage, TagSummary } from "@notted/shared-types";

const mocks = vi.hoisted(() => ({
  createTag: vi.fn(),
  updateTag: vi.fn(),
  deleteTag: vi.fn(),
  requestTagPage: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock("@/lib/tags/requests", () => ({ ...mocks }));

const workspaceId = "40000000-0000-4000-8000-000000000001";
const tag = (id: string, name: string, noteCount: number, taskCount: number): TagSummary => ({
  id,
  workspaceId,
  name,
  color: "#6b7280",
  noteCount,
  taskCount,
  createdAt: "2026-08-01T00:00:00.000Z",
});
const design = tag("40000000-0000-4000-8000-000000000002", "Design", 12, 30);
const research = tag("40000000-0000-4000-8000-000000000003", "Research", 1, 0);
const page: TagPage = { items: [design, research], page: 1, limit: 100, hasMore: false };
const created = tag("40000000-0000-4000-8000-000000000004", "Launch", 4, 2);

function view(canDelete = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <TagManager workspaceId={workspaceId} initialTags={page} canManage canDelete={canDelete} />
    </QueryClientProvider>,
  );
}

describe("TagManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requestTagPage.mockResolvedValue({ ok: true, data: page });
  });

  it("shows an optimistic row before the request resolves and the server row after", async () => {
    let resolve!: (value: unknown) => void;
    mocks.createTag.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    mocks.requestTagPage.mockResolvedValue({
      ok: true,
      data: { ...page, items: [created, ...page.items] },
    });
    const user = userEvent.setup();
    view();

    await user.type(screen.getByLabelText("Tag name"), "Launch");
    await user.click(screen.getByRole("button", { name: "Create tag" }));
    expect(screen.getByRole("listitem", { name: "Launch, 0 notes, 0 tasks" })).toBeVisible();

    resolve({ ok: true, data: { tag: created } });
    expect(await screen.findByRole("listitem", { name: "Launch, 4 notes, 2 tasks" })).toBeVisible();
    expect(
      screen.queryByRole("listitem", { name: "Launch, 0 notes, 0 tasks" }),
    ).not.toBeInTheDocument();
  });

  it("rolls the list back and announces a duplicate name when creation conflicts", async () => {
    mocks.createTag.mockResolvedValue({ ok: false, kind: "conflict" });
    const user = userEvent.setup();
    view();

    await user.type(screen.getByLabelText("Tag name"), "Design");
    await user.click(screen.getByRole("button", { name: "Create tag" }));

    expect(await screen.findByText(/already exists/iu)).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent(/already exists/iu);
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByRole("listitem", { name: "Design, 12 notes, 30 tasks" })).toBeVisible();
  });

  it("tells a workspace at its tag limit to delete rather than rename", async () => {
    // Both conflicts are 409, so `kind` alone cannot separate them. Advising a
    // rename here would be advice that can never succeed.
    mocks.createTag.mockResolvedValue({
      ok: false,
      kind: "conflict",
      code: "TAG_LIMIT_REACHED",
    });
    const user = userEvent.setup();
    view();

    await user.type(screen.getByLabelText("Tag name"), "Overflow");
    await user.click(screen.getByRole("button", { name: "Create tag" }));

    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent(/reached its tag limit/iu);
    expect(status).not.toHaveTextContent(/already exists/iu);
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });

  it("states both note and task usage in the delete confirmation", async () => {
    const user = userEvent.setup();
    view();

    const row = screen.getByRole("listitem", { name: "Design, 12 notes, 30 tasks" });
    await user.click(within(row).getByRole("button", { name: "Delete" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Used on 12 notes and 30 tasks/iu)).toBeVisible();
    expect(mocks.deleteTag).not.toHaveBeenCalled();
  });

  it("rejects an invalid hex colour before sending any request", async () => {
    const user = userEvent.setup();
    view();

    await user.type(screen.getByLabelText("Tag name"), "Ops");
    const hex = screen.getByLabelText("Tag colour hex");
    await user.clear(hex);
    await user.type(hex, "nope");
    await user.click(screen.getByRole("button", { name: "Create tag" }));

    expect(mocks.createTag).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent(/six-digit hex/iu);
  });

  it("hides delete controls when the role may not delete tags", () => {
    view(false);
    expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
    expect(screen.getByText(/Deleting a tag requires an owner or admin/iu)).toBeVisible();
  });
});
