import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Skeleton } from "@/components/ui/skeleton";

describe("Skeleton", () => {
  it("renders the animate-pulse base class", () => {
    const { container } = render(<Skeleton />);
    const skeleton = container.firstChild as HTMLElement;
    expect(skeleton).toHaveClass("animate-pulse");
    expect(skeleton).toHaveClass("bg-muted");
    expect(skeleton).toHaveClass("rounded-md");
  });

  it("applies a custom className alongside the base classes", () => {
    const { container } = render(<Skeleton className="h-8 w-3/4" />);
    const skeleton = container.firstChild as HTMLElement;
    expect(skeleton).toHaveClass("animate-pulse");
    expect(skeleton).toHaveClass("h-8");
    expect(skeleton).toHaveClass("w-3/4");
  });

  it("merges conflicting classes via tailwind-merge", () => {
    const { container } = render(<Skeleton className="rounded-full" />);
    const skeleton = container.firstChild as HTMLElement;
    // The base `rounded-md` is overridden by the consumer `rounded-full`.
    expect(skeleton).toHaveClass("rounded-full");
    expect(skeleton).not.toHaveClass("rounded-md");
  });
});
