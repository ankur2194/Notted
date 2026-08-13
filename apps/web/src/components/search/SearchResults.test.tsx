import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SearchResults } from "./SearchResults";

describe("SearchResults hybrid fallback", () => {
  it("announces a non-alarming text-only fallback while preserving results", () => {
    render(
      <SearchResults
        query="roadmap"
        status={{
          kind: "ready",
          page: {
            total: 1,
            hasMore: false,
            availability: { textSearchAvailable: true, mode: "full-text", fallback: "text-only" },
            items: [
              {
                noteId: "00000000-0000-4000-8000-000000000001",
                workspaceId: "10000000-0000-4000-8000-000000000001",
                projectId: null,
                authorId: "20000000-0000-4000-8000-000000000001",
                authorName: "Author",
                projectTitle: null,
                title: "Roadmap",
                updatedAt: "2026-01-01T00:00:00.000Z",
                createdAt: "2026-01-01T00:00:00.000Z",
                isArchived: false,
                isTemplate: false,
                hasAttachments: false,
                highlights: [],
                snippet: "",
              },
            ],
          },
        }}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Showing full-text results instead");
    expect(screen.getByRole("heading", { name: "Roadmap" })).toBeInTheDocument();
  });
});
