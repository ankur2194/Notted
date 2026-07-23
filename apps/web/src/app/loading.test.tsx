import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import Loading from "@/app/loading";

describe("Loading page", () => {
  it("renders a status region", () => {
    const { container } = render(<Loading />);
    const status = container.querySelector('[role="status"]');
    expect(status).toBeInTheDocument();
  });

  it("exposes a screen-reader-only Loading announcement", () => {
    render(<Loading />);
    expect(screen.getByText("Loading...")).toBeInTheDocument();
    expect(screen.getByText("Loading...")).toHaveClass("sr-only");
  });

  it("renders skeleton placeholders inside the status region", () => {
    const { container } = render(<Loading />);
    const status = container.querySelector('[role="status"]');
    const skeletons = status?.querySelectorAll(".animate-pulse");
    expect(skeletons?.length).toBeGreaterThan(0);
  });
});
