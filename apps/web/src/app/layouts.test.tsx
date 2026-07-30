import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import AuthLayout from "@/app/(auth)/layout";

describe("route layouts", () => {
  it("authentication layout provides exactly one main landmark and skip-link target", () => {
    const { container } = render(
      <AuthLayout>
        <h1>Route heading</h1>
      </AuthLayout>,
    );

    expect(screen.getByRole("heading", { level: 1, name: "Route heading" })).toBeInTheDocument();
    expect(screen.getAllByRole("main")).toHaveLength(1);
    expect(container.querySelector("main")).toHaveAttribute("id", "main-content");
  });

  it("keeps route scaffolds server-rendered and the toaster beside route children", () => {
    const sources = [
      "src/app/(auth)/layout.tsx",
      "src/app/(auth)/login/page.tsx",
      "src/app/(dashboard)/layout.tsx",
      "src/app/(dashboard)/page.tsx",
    ].map((path) => readFileSync(resolve(path), "utf8"));
    const rootLayout = readFileSync(resolve("src/app/layout.tsx"), "utf8");

    for (const source of sources) expect(source).not.toMatch(/["']use client["']/);
    expect(rootLayout).toContain('href="#main-content"');
    expect(rootLayout).toMatch(/\{children\}\s*<ToasterProvider \/>/);
  });
});
