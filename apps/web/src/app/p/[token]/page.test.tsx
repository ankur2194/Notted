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

  it("shows a token-scoped, keyboard-reachable generic file download without editor actions", async () => {
    const token = "a".repeat(32);
    const attachmentId = "30000000-0000-4000-8000-000000000002";
    vi.mocked(getPublicNote).mockResolvedValue({
      status: "ready",
      data: {
        title: "Files",
        content: {
          type: "doc",
          content: [
            {
              type: "image",
              attrs: { attachmentId: "30000000-0000-4000-8000-000000000003", alt: "Diagram" },
            },
            {
              type: "attachment",
              attrs: {
                attachmentId,
                name: "report.txt",
                mimeType: "text/plain",
                sizeBytes: 12,
              },
            },
          ],
        },
        pageSize: "letter",
        updatedAt: "2026-09-17T00:00:00.000Z",
      },
    });
    render(await PublicNotePage({ params: Promise.resolve({ token }) }));
    const link = screen.getByRole("link", { name: "Download report.txt" });
    expect(link).toHaveAttribute(
      "href",
      expect.stringContaining(`/api/v1/public/notes/${token}/attachments/${attachmentId}/content`),
    );
    expect(link).toHaveAttribute("rel", "noreferrer");
    expect(link).toHaveAttribute("referrerpolicy", "no-referrer");
    expect(link).toHaveAttribute("data-notted-print-hide");
    expect(screen.getByRole("img", { name: "Diagram" })).toHaveAttribute(
      "src",
      expect.stringContaining(
        `/api/v1/public/notes/${token}/attachments/30000000-0000-4000-8000-000000000003/content`,
      ),
    );
    await userEvent.tab(); // Page width
    await userEvent.tab(); // Full width
    await userEvent.tab(); // Download
    expect(link).toHaveFocus();
    expect(document.querySelector('meta[name="referrer"]')).toHaveAttribute(
      "content",
      "no-referrer",
    );
    expect(screen.queryByRole("button", { name: /delete|preview|edit/i })).not.toBeInTheDocument();
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
