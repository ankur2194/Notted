import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

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

  /*
   * A skip link that lands on an unfocusable element is a skip link that does
   * nothing: activating it scrolls, but in engines that do not move focus to a
   * non-focusable fragment target, focus stays on the link itself and the next
   * Tab returns the keyboard user to the navigation they were trying to skip.
   * `DashboardShell` had `tabIndex={-1}`; the auth, loading, error, not-found
   * and dashboard-fallback mains did not — six routes where the app's one skip
   * link (`app/layout.tsx`, which wraps every route) moved nothing.
   *
   * Asserted over the source of every file rather than per component, because
   * the defect is that a SEVENTH `<main id="main-content">` gets written the
   * same way. Six separate render tests would each have passed on the day this
   * shipped.
   */
  it("gives every skip-link target a focusable tabIndex", () => {
    const files = readdirSync(resolve("src"), { recursive: true, encoding: "utf8" })
      .filter((entry) => entry.endsWith(".tsx") && !entry.endsWith(".test.tsx"))
      .map((entry) => join(resolve("src"), entry));

    const targets = files
      .map((file) => ({ file, source: readFileSync(file, "utf8") }))
      .filter(({ source }) => source.includes('id="main-content"'));

    expect(targets.length).toBeGreaterThanOrEqual(7);
    for (const { file, source } of targets) {
      // The opening tag that carries the id must also carry the tabIndex.
      const tag = /<main\b[^>]*id="main-content"[^>]*>/su.exec(source)?.[0] ?? "";
      expect(tag, `${file} has no <main id="main-content"> tag`).not.toBe("");
      expect(tag, `${file} skip-link target is not focusable`).toContain("tabIndex={-1}");
    }
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
