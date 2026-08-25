import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { WorkspaceAvatar } from "./WorkspaceAvatar";

const LOGO_PATH = "/api/v1/workspaces/20000000-0000-4000-8000-000000000001/logo/" + "a".repeat(32);

describe("WorkspaceAvatar", () => {
  it("renders initials when the workspace has no logo", () => {
    render(<WorkspaceAvatar name="Acme Corporation" logoUrl={null} />);
    expect(
      screen.getByRole("img", { name: "Acme Corporation logo placeholder" }),
    ).toHaveTextContent("AC");
  });

  it("resolves the app-relative logo path against the API origin", () => {
    render(<WorkspaceAvatar name="Acme" logoUrl={LOGO_PATH} />);
    expect(screen.getByRole("img", { name: "Acme logo" }).getAttribute("src")).toContain(LOGO_PATH);
  });

  // The Plan.md verification for Part 72: a broken asset falls back to Notted
  // branding rather than leaving a broken-image glyph in the shell.
  it("falls back to initials when the image fails to load", () => {
    render(<WorkspaceAvatar name="Acme" logoUrl={LOGO_PATH} />);
    fireEvent.error(screen.getByRole("img", { name: "Acme logo" }));
    expect(screen.getByRole("img", { name: "Acme logo placeholder" })).toHaveTextContent("A");
  });

  it("renders a caller-supplied fallback instead of initials when one is given", () => {
    render(
      <WorkspaceAvatar name="Acme" logoUrl={null} fallback={<span data-testid="mark">N</span>} />,
    );
    expect(screen.getByTestId("mark")).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: /placeholder/ })).toBeNull();
  });

  it.each([
    ["a protocol-relative host", "//evil.example/logo.png"],
    ["an absolute URL", "https://evil.example/logo.png"],
    ["a javascript scheme", "javascript:alert(1)"],
  ])("refuses %s and renders the placeholder", (_label, logoUrl) => {
    render(<WorkspaceAvatar name="Acme" logoUrl={logoUrl} />);
    expect(screen.getByRole("img", { name: "Acme logo placeholder" })).toBeInTheDocument();
  });
});
