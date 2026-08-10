import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TagFilterList } from "./TagFilterList";

import type { TagSummary } from "@notted/shared-types";

const mocks = vi.hoisted(() => ({ searchParams: new URLSearchParams() }));

vi.mock("next/navigation", () => ({ useSearchParams: () => mocks.searchParams }));

const workspaceId = "40000000-0000-4000-8000-000000000001";
const design: TagSummary = {
  id: "40000000-0000-4000-8000-000000000002",
  workspaceId,
  name: "Design",
  color: "#112233",
  noteCount: 12,
  taskCount: 3,
  createdAt: "2026-08-01T00:00:00.000Z",
};
const research: TagSummary = {
  ...design,
  id: "40000000-0000-4000-8000-000000000003",
  name: "Research",
  noteCount: 0,
  taskCount: 1,
};

describe("TagFilterList", () => {
  beforeEach(() => {
    mocks.searchParams = new URLSearchParams();
  });

  it("links each tag to the filtered note list", () => {
    render(
      <TagFilterList
        workspaceId={workspaceId}
        state={{ status: "ready", tags: [design, research], truncated: false }}
      />,
    );
    expect(screen.getByRole("link", { name: /^Design/u })).toHaveAttribute(
      "href",
      `/workspaces/${workspaceId}/notes?tagId=${design.id}`,
    );
    expect(screen.queryByRole("link", { name: "Clear tag filter" })).not.toBeInTheDocument();
  });

  it("marks the filtered tag as the current page and offers a clear link", () => {
    mocks.searchParams = new URLSearchParams({ tagId: design.id });
    render(
      <TagFilterList
        workspaceId={workspaceId}
        state={{ status: "ready", tags: [design, research], truncated: false }}
      />,
    );
    expect(screen.getByRole("link", { name: /^Design/u })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: /^Research/u })).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("link", { name: "Clear tag filter" })).toHaveAttribute(
      "href",
      `/workspaces/${workspaceId}/notes`,
    );
  });

  it("keeps both usage counts in the accessible name", () => {
    render(
      <TagFilterList
        workspaceId={workspaceId}
        state={{ status: "ready", tags: [design], truncated: false }}
      />,
    );
    expect(screen.getByRole("link", { name: /12 notes/u })).toBeVisible();
    expect(screen.getByRole("link", { name: /3 tasks/u })).toBeVisible();
  });

  it("explains the empty, unavailable, and no-workspace states", () => {
    const empty = render(
      <TagFilterList
        workspaceId={workspaceId}
        state={{ status: "ready", tags: [], truncated: false }}
      />,
    );
    expect(screen.getByText(/No tags yet/iu)).toBeVisible();
    empty.unmount();

    const unavailable = render(
      <TagFilterList workspaceId={workspaceId} state={{ status: "unavailable" }} />,
    );
    expect(screen.getByRole("note")).toHaveTextContent(/temporarily unavailable/iu);
    unavailable.unmount();

    render(<TagFilterList workspaceId={null} state={{ status: "no-workspace" }} />);
    expect(screen.getByText(/Choose or create a workspace/iu)).toBeVisible();
  });
});
