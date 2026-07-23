import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import NotFound from "@/app/not-found";

describe("NotFound page", () => {
  it("renders a 404 heading", () => {
    render(<NotFound />);
    expect(screen.getByRole("heading", { level: 1, name: "404" })).toBeInTheDocument();
  });

  it("renders a human-readable Page not found subheading", () => {
    render(<NotFound />);
    expect(screen.getByRole("heading", { level: 2, name: /page not found/i })).toBeInTheDocument();
  });

  it("renders a link back to the home page", () => {
    render(<NotFound />);
    const home = screen.getByRole("link", { name: /go back home/i });
    expect(home).toHaveAttribute("href", "/");
  });
});
