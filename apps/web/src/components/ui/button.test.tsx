import { render, screen } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it } from "vitest";

import { Button } from "@/components/ui/button";

describe("Button", () => {
  it("renders its children", () => {
    render(<Button>Click me</Button>);
    expect(screen.getByRole("button", { name: "Click me" })).toBeInTheDocument();
  });

  it("applies the default variant and size classes", () => {
    render(<Button>Default</Button>);
    const button = screen.getByRole("button", { name: "Default" });
    // Default variant + default size tokens from buttonVariants.
    expect(button).toHaveClass("bg-primary");
    expect(button).toHaveClass("h-10");
    expect(button).toHaveClass("px-4");
  });

  it("applies a non-default variant class", () => {
    render(<Button variant="outline">Outline</Button>);
    const button = screen.getByRole("button", { name: "Outline" });
    expect(button).toHaveClass("border");
    expect(button).toHaveClass("bg-background");
  });

  it("applies a custom size class", () => {
    render(<Button size="lg">Large</Button>);
    expect(screen.getByRole("button", { name: "Large" })).toHaveClass("h-11");
  });

  it("merges a consumer className without dropping variant classes", () => {
    render(<Button className="mt-4">Custom</Button>);
    const button = screen.getByRole("button", { name: "Custom" });
    expect(button).toHaveClass("mt-4");
    expect(button).toHaveClass("bg-primary");
  });

  it("forwards the ref to the underlying button element", () => {
    const ref = createRef<HTMLButtonElement>();
    render(<Button ref={ref}>Ref</Button>);
    expect(ref.current).toBeInstanceOf(HTMLButtonElement);
    expect(ref.current?.textContent).toBe("Ref");
  });

  it("renders the child element directly when asChild is true", () => {
    render(
      <Button asChild>
        <a href="/somewhere">Anchor</a>
      </Button>,
    );
    const link = screen.getByRole("link", { name: "Anchor" });
    expect(link).toBeInTheDocument();
    // Slot passes the variant/size classes through to the child element.
    expect(link).toHaveClass("bg-primary");
    expect(link).toHaveClass("h-10");
  });

  it("forwards native button attributes", () => {
    render(
      <Button type="submit" disabled>
        Submit
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Submit" });
    expect(button).toHaveAttribute("type", "submit");
    expect(button).toBeDisabled();
  });
});
