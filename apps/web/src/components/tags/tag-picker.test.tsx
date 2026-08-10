import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { TagPicker } from "./TagPicker";

import type { TagSummary } from "@notted/shared-types";

const workspaceId = "40000000-0000-4000-8000-000000000001";
const tag = (id: string, name: string): TagSummary => ({
  id,
  workspaceId,
  name,
  color: "#112233",
  noteCount: 0,
  taskCount: 0,
  createdAt: "2026-08-01T00:00:00.000Z",
});
const design = tag("40000000-0000-4000-8000-000000000002", "Design");
const research = tag("40000000-0000-4000-8000-000000000003", "Research");
const support = tag("40000000-0000-4000-8000-000000000004", "Support");

describe("TagPicker", () => {
  it("names each checkbox after its tag and reports selection in tag order", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <TagPicker
        tags={[design, research, support]}
        value={[support.id]}
        onChange={onChange}
        idPrefix="note-1"
      />,
    );

    expect(screen.getByRole("checkbox", { name: "Support" })).toBeChecked();
    await user.click(screen.getByRole("checkbox", { name: "Design" }));
    // Ordered by `tags`, not by click order, so callers can compare arrays.
    expect(onChange).toHaveBeenCalledWith([design.id, support.id]);
  });

  it("deselects a checked tag", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <TagPicker tags={[design, research]} value={[design.id]} onChange={onChange} idPrefix="a" />,
    );

    await user.click(screen.getByRole("checkbox", { name: "Design" }));
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it("explains the empty state instead of rendering a bare fieldset", () => {
    render(<TagPicker tags={[]} value={[]} onChange={vi.fn()} idPrefix="a" legend="Task tags" />);

    expect(screen.getByText(/No tags yet/iu)).toBeVisible();
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    expect(screen.getByRole("group", { name: "Task tags" })).toBeVisible();
  });
});
