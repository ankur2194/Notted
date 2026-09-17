import { render, screen } from "@testing-library/react";
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

  it("renders the unavailable message without calling notFound", async () => {
    vi.mocked(getPublicNote).mockResolvedValue({ status: "unavailable" });
    const element = await PublicNotePage({ params: Promise.resolve({ token: "a".repeat(32) }) });
    render(element);
    expect(screen.getByRole("alert")).toHaveTextContent("This note is unavailable");
  });
});
