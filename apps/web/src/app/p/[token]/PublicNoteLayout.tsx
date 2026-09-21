"use client";

import { DEFAULT_PAGE_MARGINS, pageCustomProperties, pageSizeLabel } from "@notted/shared-types";
import { useState, type CSSProperties, type ReactNode } from "react";

import type { PageSize } from "@notted/shared-types";

const BUTTON_CLASSES =
  "inline-flex min-h-11 items-center rounded-md border border-input bg-background px-3 text-sm text-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none aria-pressed:bg-accent aria-pressed:text-accent-foreground";

/**
 * The `/p/:token` reading column with a page-width / full-width toggle.
 *
 * "Page width" reproduces the sheet the author wrote on: the note's own
 * `pageSize` (A4 or US Letter) and the default margins, published through the
 * same custom properties `PageContainer` uses so the column matches the editor
 * and the printed page. "Full width" drops the cap and lets the column fill
 * the viewport. The toggle is screen-only chrome (`data-notted-print-hide`);
 * print keeps taking its size from `print.css`'s `@page`.
 */
export function PublicNoteLayout({
  pageSize,
  children,
}: {
  readonly pageSize: PageSize;
  readonly children: ReactNode;
}) {
  const [layout, setLayout] = useState<"page" | "full">("page");
  const style: CSSProperties =
    layout === "page"
      ? {
          ...(pageCustomProperties(pageSize, DEFAULT_PAGE_MARGINS) as CSSProperties),
          maxWidth: "var(--notted-page-width)",
          padding: "var(--notted-page-margin-y) var(--notted-page-margin-x)",
        }
      : { maxWidth: "none", padding: "2rem" };
  return (
    <main id="main-content" tabIndex={-1} className="mx-auto" style={style}>
      <div
        role="group"
        aria-label="Preview width"
        className="mb-6 flex justify-end gap-2"
        data-notted-print-hide
      >
        <button
          type="button"
          className={BUTTON_CLASSES}
          aria-pressed={layout === "page"}
          onClick={() => setLayout("page")}
        >
          Page width ({pageSizeLabel(pageSize)})
        </button>
        <button
          type="button"
          className={BUTTON_CLASSES}
          aria-pressed={layout === "full"}
          onClick={() => setLayout("full")}
        >
          Full width
        </button>
      </div>
      {children}
    </main>
  );
}
