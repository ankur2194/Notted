import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ErrorBoundary from "@/app/error";

describe("Error boundary", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders generic text, retry behavior, and a real home link", async () => {
    const user = userEvent.setup();
    const reset = vi.fn();
    render(<ErrorBoundary error={new Error("private note contents")} reset={reset} />);

    expect(screen.getByRole("alert")).toHaveTextContent("We encountered an unexpected error.");
    expect(screen.getByRole("link", { name: "Go to dashboard" })).toHaveAttribute("href", "/");
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(reset).toHaveBeenCalledOnce();
  });

  it("does not expose supplied error data in the DOM or console", () => {
    const sensitive = "private note contents";
    const error = new Error(sensitive) as Error & { digest?: string };
    error.cause = { token: "secret-token" };
    error.stack = `stack ${sensitive}`;
    error.digest = "next-digest";

    const { container } = render(<ErrorBoundary error={error} reset={vi.fn()} />);

    expect(container).not.toHaveTextContent(sensitive);
    expect(container).not.toHaveTextContent("secret-token");
    expect(console.error).toHaveBeenCalledWith("Application error boundary", "next-digest");
    const serializedArguments = JSON.stringify(vi.mocked(console.error).mock.calls);
    expect(serializedArguments).not.toContain(sensitive);
    expect(serializedArguments).not.toContain("secret-token");
    expect(serializedArguments).not.toContain("stack");
  });
});
