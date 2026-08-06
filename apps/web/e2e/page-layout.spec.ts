import { randomUUID } from "node:crypto";

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import { latestActionLink } from "./mailpit";

/**
 * Part 37 browser verification.
 *
 * The stated criterion is "browser measurements match the specified sizes at
 * 100%, switching size persists, and responsive scrolling does not clip editor
 * controls". None of that is checkable in jsdom, where every rect is zero, so
 * this file is the only place the paper is actually measured.
 *
 * The expected pixel figures below are written out longhand on purpose. They are
 * derived from the CSS definition `1in = 96px` (hence `1mm = 96/25.4px`) applied
 * to the sizes `Notted.md` specifies, and are deliberately *not* imported from
 * `page-geometry.ts`: importing the module under test would only prove the
 * browser agrees with itself.
 */

const disposable = process.env.PLAYWRIGHT_DISPOSABLE_TEST_RUN === "true";
const apiUrl = process.env.PLAYWRIGHT_API_URL ?? "http://localhost:3001";
const appUrl = process.env.PLAYWRIGHT_APP_URL ?? "http://localhost:3000";
const password = "Fresh1!Password";

/** Generous enough for a cold Next dev-server route compile. */
const ROUTE_COMPILE_MS = 45_000;

/** 210mm and 297mm at 96/25.4 px per mm. */
const A4_WIDTH_PX = 793.7;
const A4_HEIGHT_PX = 1122.52;
/** 8.5in and 11in at 96px per inch — exact, which is why Letter is never restated in mm. */
const LETTER_WIDTH_PX = 816;
const LETTER_HEIGHT_PX = 1056;

/** Must equal `PAGE_VIEWPORT_PADDING_PX`; the fit modes subtract it from `clientWidth`. */
const VIEWPORT_PADDING_PX = 32;

/** WCAG 2.2 SC 2.5.8 minimum target size. */
const MINIMUM_TARGET_PX = 24;

function identity(role: string) {
  const suffix = randomUUID();
  return { name: `Layout ${role}`, email: `layout.${role}.${suffix}@example.test`, password };
}

async function register(page: Page, account: ReturnType<typeof identity>): Promise<void> {
  await page.goto("/register");
  await page.getByLabel("Name").fill(account.name);
  await page.getByLabel("Email").fill(account.email);
  await page.getByLabel("Password", { exact: true }).fill(account.password);
  await page.getByLabel("Confirm password").fill(account.password);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.goto(await latestActionLink(page.request, account.email, "Verify your Notted email"));
  await expect(page.getByRole("heading", { name: "Email verified" })).toBeVisible({
    timeout: ROUTE_COMPILE_MS,
  });
  await page.goto("/login?redirect=%2Fworkspaces");
  await page.getByLabel("Email", { exact: true }).first().fill(account.email);
  await page.getByLabel("Password").fill(account.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  // The Next dev server compiles each route on first request, which can take
  // well over the 5s default on a loaded machine.
  await expect(page).toHaveURL(/\/workspaces$/u, { timeout: ROUTE_COMPILE_MS });
}

async function createWorkspace(page: Page, name: string): Promise<string> {
  await page.getByRole("button", { name: "Create workspace", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Create a workspace" });
  await dialog.getByLabel("Workspace name").fill(name);
  await dialog.getByRole("button", { name: "Create workspace", exact: true }).click();
  await expect(page).toHaveURL(/\/workspaces\/[0-9a-f-]+$/u, { timeout: ROUTE_COMPILE_MS });
  return new URL(page.url()).pathname.split("/").at(-1)!;
}

async function apiPost(
  request: APIRequestContext,
  path: string,
  data: unknown,
  idempotencyKey?: string,
) {
  const response = await request.post(`${apiUrl}${path}`, {
    headers: {
      Origin: appUrl,
      ...(idempotencyKey === undefined ? {} : { "Idempotency-Key": idempotencyKey }),
    },
    data,
  });
  expect(response.ok()).toBeTruthy();
  return response.json() as Promise<Record<string, unknown>>;
}

type PaperMeasurement = {
  /** Layout width in CSS pixels, taken before the zoom transform. */
  width: number;
  height: number;
  /** Painted width, i.e. after `scale()`. */
  paintedWidth: number;
  scale: number;
  pageSize: string;
};

/**
 * Choose a zoom option and wait until the sheet actually reflects it.
 *
 * The interaction itself is retried, not just the assertion. A selection made
 * before React hydrates is silently dropped — the controlled `<select>`
 * re-renders back to its server value — and after a `reload()` under load that
 * window is wide enough to matter. Retrying the assertion alone would wait
 * forever on a change that was never registered.
 */
async function selectZoom(page: Page, option: string): Promise<void> {
  // The settled signal is the sheet's own attribute for a fixed level, and the
  // announcement for a fit mode, whose resolved scale depends on the viewport.
  const settled = async (): Promise<string | null> =>
    Number.isNaN(Number(option))
      ? page.getByTestId("note-layout-status").textContent()
      : page.getByTestId("notted-page-paper").getAttribute("data-zoom-scale");
  const expected = Number.isNaN(Number(option))
    ? /^Zoom set to Fit to (?:width|page), \d+%\.$/u
    : String(Number(option));

  await expect
    .poll(
      async () => {
        await page.getByLabel("Zoom", { exact: true }).selectOption(option);
        return settled();
      },
      { timeout: ROUTE_COMPILE_MS },
    )
    .toEqual(expected instanceof RegExp ? expect.stringMatching(expected) : expected);
}

/**
 * `.notted-page-paper` always carries `translateX(-50%) scale(n)`. A transform
 * never changes layout, so `getBoundingClientRect` reports the *painted* box
 * while the element's own layout box is what the millimetre declaration
 * produced. Both are returned: the first is what the reader sees, the second is
 * what the criterion is about.
 */
async function measurePaper(page: Page): Promise<PaperMeasurement> {
  return page.evaluate(() => {
    const paper = document.querySelector<HTMLElement>('[data-testid="notted-page-paper"]');
    if (paper === null) throw new Error("the page paper was not rendered");
    const scale = Number(paper.dataset.zoomScale);
    const rect = paper.getBoundingClientRect();
    return {
      width: rect.width / scale,
      height: rect.height / scale,
      paintedWidth: rect.width,
      scale,
      pageSize: paper.dataset.pageSize ?? "",
    };
  });
}

test.describe.serial("Part 37 real-stack page container", () => {
  test.skip(
    !disposable,
    "page layout requires PLAYWRIGHT_DISPOSABLE_TEST_RUN=true and disposable PostgreSQL, Redis, and Mailpit",
  );

  test("measures A4 and Letter at 100%, persists the size, zooms, and keeps editor controls reachable", async ({
    browser,
  }) => {
    // The whole journey runs against a Next dev server that compiles routes on
    // demand and re-hydrates a heavy editor after every reload.
    test.slow();
    const ownerContext = await browser.newContext();
    const owner = await ownerContext.newPage();
    const workspaceName = `Layout ${randomUUID().slice(0, 8)}`;
    let workspaceId: string | null = null;
    try {
      await register(owner, identity("owner"));
      workspaceId = await createWorkspace(owner, workspaceName);
      const noteResult = await apiPost(
        owner.request,
        `/api/v1/workspaces/${workspaceId}/notes`,
        { title: "Paper measurement", projectId: null, folderId: null, parentId: null },
        randomUUID(),
      );
      const note = noteResult.note as { id: string; version: number };
      const notePath = `/workspaces/${workspaceId}/notes/${note.id}`;

      await owner.goto(notePath);
      const paper = owner.getByTestId("notted-page-paper");
      await expect(paper).toBeVisible();
      await expect(owner.getByRole("toolbar", { name: "Note formatting" })).toBeVisible();

      // ---------------------------------------------------------------- A4 at 100%
      await expect(owner.getByLabel("Zoom", { exact: true })).toHaveValue("1");
      const a4 = await measurePaper(owner);
      expect(a4.pageSize).toBe("a4");
      expect(a4.scale).toBe(1);
      expect(a4.width).toBeCloseTo(A4_WIDTH_PX, 0);
      expect(a4.height).toBeCloseTo(A4_HEIGHT_PX, 0);
      // The rounded figures quoted in `Notted.md`.
      expect(Math.round(a4.width)).toBe(794);
      expect(Math.round(a4.height)).toBe(1123);

      // ------------------------------------------------------------ Letter at 100%
      const letterButton = owner
        .getByRole("group", { name: "Page size" })
        .getByRole("button", { name: "US Letter" });
      await letterButton.click();
      await expect(letterButton).toHaveAttribute("aria-pressed", "true");
      await expect(paper).toHaveAttribute("data-page-size", "letter");

      const letter = await measurePaper(owner);
      expect(letter.width).toBeCloseTo(LETTER_WIDTH_PX, 0);
      expect(letter.height).toBeCloseTo(LETTER_HEIGHT_PX, 0);
      // Letter is wider and shorter than A4 — the two sizes are genuinely
      // different geometry, not one sheet with a relabelled control.
      expect(letter.width).toBeGreaterThan(a4.width);
      expect(letter.height).toBeLessThan(a4.height);

      // ------------------------------------------------ the switch survives a reload
      await expect(owner.getByTestId("note-save-status")).toHaveText(/Saved\./u);
      await owner.reload();
      await expect(owner.getByTestId("notted-page-paper")).toHaveAttribute(
        "data-page-size",
        "letter",
      );
      await expect(
        owner.getByRole("group", { name: "Page size" }).getByRole("button", { name: "US Letter" }),
      ).toHaveAttribute("aria-pressed", "true");
      const reloaded = await measurePaper(owner);
      expect(reloaded.width).toBeCloseTo(LETTER_WIDTH_PX, 0);
      expect(reloaded.height).toBeCloseTo(LETTER_HEIGHT_PX, 0);

      // --------------------------------------------------------------------- zoom
      const status = owner.getByTestId("note-layout-status");
      await selectZoom(owner, "1.25");
      await expect(owner.getByTestId("notted-page-paper")).toHaveAttribute(
        "data-zoom-scale",
        "1.25",
      );
      await expect(status).toHaveText("Zoom set to 125%.");

      const zoomed = await measurePaper(owner);
      // Layout size is unchanged by zoom; only the painted size moves.
      expect(zoomed.width).toBeCloseTo(LETTER_WIDTH_PX, 0);
      expect(zoomed.paintedWidth).toBeCloseTo(LETTER_WIDTH_PX * 1.25, 0);

      // The wrapper must reserve the painted box, or the zoomed sheet either
      // overflows the scroll extents or leaves dead space beneath itself.
      const reserved = await owner.evaluate(() => {
        const scale = document.querySelector<HTMLElement>(".notted-page-scale");
        const viewport = document.querySelector<HTMLElement>(".notted-page-viewport");
        if (scale === null || viewport === null) throw new Error("page viewport was not rendered");
        return {
          scaleWidth: scale.getBoundingClientRect().width,
          scaleHeight: scale.getBoundingClientRect().height,
          scrollWidth: viewport.scrollWidth,
          clientWidth: viewport.clientWidth,
        };
      });
      expect(reserved.scaleWidth).toBeCloseTo(LETTER_WIDTH_PX * 1.25, 0);
      expect(reserved.scrollWidth).toBeGreaterThanOrEqual(Math.floor(reserved.scaleWidth));

      // Fit-to-width has to land inside the padded viewport, never beyond it.
      await selectZoom(owner, "fit-width");
      await expect(status).toHaveText(/^Zoom set to Fit to width, \d+%\.$/u);
      const fitted = await measurePaper(owner);
      const available = reserved.clientWidth - VIEWPORT_PADDING_PX * 2;
      expect(fitted.paintedWidth).toBeLessThanOrEqual(available + 1);
      expect(fitted.paintedWidth).toBeGreaterThan(available * 0.9);

      await selectZoom(owner, "1");

      // ------------------------------------------------- margins persist locally
      const sideMargin = owner.getByLabel("Side margin (mm)");
      await sideMargin.fill("30");
      await sideMargin.blur();
      await expect
        .poll(async () =>
          owner.evaluate(() => window.localStorage.getItem("notted.notes.page-view")),
        )
        .toContain("30");
      await owner.reload();
      await expect(owner.getByLabel("Side margin (mm)")).toHaveValue("30");
      await owner.getByLabel("Side margin (mm)").fill("20");
      await owner.getByLabel("Side margin (mm)").blur();

      // ------------------------------- responsive scrolling does not clip controls
      await owner.emulateMedia({ reducedMotion: "reduce" });
      for (const viewport of [
        { width: 390, height: 844 },
        { width: 768, height: 1024 },
        { width: 1440, height: 900 },
      ]) {
        await owner.setViewportSize(viewport);
        await owner.goto(notePath);
        await expect(owner.getByTestId("notted-page-paper")).toBeVisible();

        // The document itself must never scroll sideways: the paper's own
        // overflow belongs to `.notted-page-viewport`, not to the page.
        const reflow = await owner.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
        }));
        expect(reflow.scrollWidth).toBeLessThanOrEqual(reflow.clientWidth + 1);

        // Every formatting control must be reachable and fully painted once
        // scrolled to — that is what "does not clip" means for a control that
        // legitimately lives inside a scrollable region.
        const buttons = owner.getByRole("toolbar", { name: "Note formatting" }).getByRole("button");
        const total = await buttons.count();
        expect(total).toBeGreaterThan(0);
        for (let index = 0; index < total; index += 1) {
          const button = buttons.nth(index);
          await button.scrollIntoViewIfNeeded();
          const box = await button.boundingBox();
          expect(box, `toolbar button ${index} had no box at ${viewport.width}px`).not.toBeNull();
          if (box === null) continue;
          expect(box.width).toBeGreaterThanOrEqual(MINIMUM_TARGET_PX);
          expect(box.height).toBeGreaterThanOrEqual(MINIMUM_TARGET_PX);
          const visible = await owner.evaluate(
            (element: SVGElement | HTMLElement) => {
              const container = element.closest<HTMLElement>(".notted-page-viewport");
              if (container === null) return true;
              const own = element.getBoundingClientRect();
              const bounds = container.getBoundingClientRect();
              return (
                own.right > bounds.left &&
                own.left < bounds.right &&
                own.bottom > bounds.top &&
                own.top < bounds.bottom
              );
            },
            await button.elementHandle(),
          );
          expect(visible, `toolbar button ${index} stayed clipped at ${viewport.width}px`).toBe(
            true,
          );
        }
      }
    } finally {
      if (workspaceId !== null)
        await owner.request
          .delete(`${apiUrl}/api/v1/workspaces/${workspaceId}`, {
            headers: { Origin: appUrl },
            data: { confirm: true, expectedName: workspaceName },
          })
          .catch(() => undefined);
      await ownerContext.close();
    }
  });
});
