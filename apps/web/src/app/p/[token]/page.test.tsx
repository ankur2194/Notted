import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/notes/server-public-note", () => ({ getPublicNote: vi.fn() }));

import PublicNotePage from "./page";

import { getPublicNote } from "@/lib/notes/server-public-note";

describe("PublicNotePage", () => {
  it("renders the note title and content for a valid token", async () => {
    vi.mocked(getPublicNote).mockResolvedValue({
      status: "ready",
      data: {
        title: "Shared note",
        content: {
          type: "doc",
          content: [{ type: "paragraph", content: [{ type: "text", text: "Hello" }] }],
        },
        pageSize: "letter",
        updatedAt: "2026-09-17T00:00:00.000Z",
      },
    });
    const element = await PublicNotePage({ params: Promise.resolve({ token: "a".repeat(32) }) });
    render(element);
    expect(screen.getByRole("heading", { name: "Shared note" })).toBeInTheDocument();
    expect(screen.getByText("Hello")).toBeInTheDocument();
  });

  it("defaults to the note's page width and toggles to full width", async () => {
    vi.mocked(getPublicNote).mockResolvedValue({
      status: "ready",
      data: { title: "T", content: { type: "doc" }, pageSize: "letter", updatedAt: "now" },
    });
    render(await PublicNotePage({ params: Promise.resolve({ token: "a".repeat(32) }) }));
    const main = screen.getByRole("main");
    const pageButton = screen.getByRole("button", { name: "Page width (US Letter)" });
    const fullButton = screen.getByRole("button", { name: "Full width" });
    expect(pageButton).toHaveAttribute("aria-pressed", "true");
    expect(main.style.getPropertyValue("--notted-page-width")).toBe("8.5in");
    await userEvent.click(fullButton);
    expect(fullButton).toHaveAttribute("aria-pressed", "true");
    expect(pageButton).toHaveAttribute("aria-pressed", "false");
    expect(main.style.maxWidth).toBe("none");
  });

  it("renders the unavailable message without calling notFound", async () => {
    vi.mocked(getPublicNote).mockResolvedValue({ status: "unavailable" });
    const element = await PublicNotePage({ params: Promise.resolve({ token: "a".repeat(32) }) });
    render(element);
    expect(screen.getByRole("alert")).toHaveTextContent("This note is unavailable");
  });
});
