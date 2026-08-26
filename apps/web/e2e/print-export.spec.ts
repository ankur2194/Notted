import { randomUUID } from "node:crypto";
import { inflateSync } from "node:zlib";

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import { latestActionLink } from "./mailpit";
import { PRINT_HIDDEN_SELECTORS } from "./print-selectors";

/**
 * Part 38 browser verification.
 *
 * The stated criterion is "print/PDF snapshots for A4 and Letter contain only
 * note content with predictable pagination; focus mode works via mouse and
 * keyboard". jsdom cannot paginate — it has no layout engine and reports every
 * rect as zero — so the snapshots have to come from a real Chromium.
 *
 * "Only note content" is proved against the DOM under `media: print`, where the
 * hiding rules in `styles/print.css` are actually in effect. The PDFs then prove
 * the two things the DOM cannot show: that `@page` really drives the sheet size,
 * and that an explicit `pageBreak` really starts a new page.
 */

const disposable = process.env.PLAYWRIGHT_DISPOSABLE_TEST_RUN === "true";
const apiUrl = process.env.PLAYWRIGHT_API_URL ?? "http://localhost:3001";
const appUrl = process.env.PLAYWRIGHT_APP_URL ?? "http://localhost:3000";
const password = "Fresh1!Password";

/** Generous enough for a cold Next dev-server route compile. */
const ROUTE_COMPILE_MS = 45_000;

/** PDF user-space units are points: 1pt = 1/72in. */
const A4_WIDTH_PT = 595.28;
const A4_HEIGHT_PT = 841.89;
const LETTER_WIDTH_PT = 612;
const LETTER_HEIGHT_PT = 792;

function identity(role: string) {
  const suffix = randomUUID();
  return { name: `Print ${role}`, email: `print.${role}.${suffix}@example.test`, password };
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

async function apiGet(request: APIRequestContext, path: string) {
  const response = await request.get(`${apiUrl}${path}`, { headers: { Origin: appUrl } });
  expect(response.ok()).toBeTruthy();
  return response.json() as Promise<Record<string, unknown>>;
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

/**
 * Inflate every Flate-compressed stream so a PDF written with compressed object
 * streams is still readable. `node:zlib` is a builtin, so this keeps the check
 * dependency-free (ADR 0008 pins the package matrix).
 */
function inflatedStreams(pdf: Buffer): string {
  const parts: string[] = [];
  const begin = Buffer.from("stream");
  const end = Buffer.from("endstream");
  let index = pdf.indexOf(begin);
  while (index !== -1) {
    let start = index + begin.length;
    if (pdf[start] === 0x0d) start += 1;
    if (pdf[start] === 0x0a) start += 1;
    const stop = pdf.indexOf(end, start);
    if (stop === -1) break;
    try {
      parts.push(inflateSync(pdf.subarray(start, stop)).toString("latin1"));
    } catch {
      // Not a Flate stream (or not a stream at all); the raw source covers it.
    }
    index = pdf.indexOf(begin, stop + end.length);
  }
  return parts.join("\n");
}

function pdfSource(pdf: Buffer): string {
  return `${pdf.toString("latin1")}\n${inflatedStreams(pdf)}`;
}

function pdfPageBoxes(source: string): Array<{ width: number; height: number }> {
  const pattern = /\/MediaBox\s*\[\s*(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s*\]/gu;
  return [...source.matchAll(pattern)].map((match) => ({
    width: Number(match[3]) - Number(match[1]),
    height: Number(match[4]) - Number(match[2]),
  }));
}

function pdfPageCount(source: string): number {
  const pages = [...source.matchAll(/\/Type\s*\/Page(?![s])/gu)].length;
  if (pages > 0) return pages;
  const counted = /\/Type\s*\/Pages(?:[^>]|>(?!>))*?\/Count\s+(\d+)/u.exec(source);
  return counted === null ? 0 : Number(counted[1]);
}

test.describe.serial("Part 38 real-stack print and page breaks", () => {
  test.skip(
    !disposable,
    "print verification requires PLAYWRIGHT_DISPOSABLE_TEST_RUN=true and disposable PostgreSQL, Redis, and Mailpit",
  );

  test("snapshots A4 and Letter with only note content, honours explicit breaks, and toggles focus mode", async ({
    browser,
  }, testInfo) => {
    // The whole journey runs against a Next dev server that compiles routes on
    // demand and re-hydrates a heavy editor after every reload.
    test.slow();
    const ownerContext = await browser.newContext();
    const owner = await ownerContext.newPage();
    const workspaceName = `Print ${randomUUID().slice(0, 8)}`;
    let workspaceId: string | null = null;
    try {
      await register(owner, identity("owner"));
      workspaceId = await createWorkspace(owner, workspaceName);
      const noteResult = await apiPost(
        owner.request,
        `/api/v1/workspaces/${workspaceId}/notes`,
        { title: "Print snapshot", projectId: null, folderId: null, parentId: null },
        randomUUID(),
      );
      const note = noteResult.note as { id: string; version: number };
      const notePath = `/workspaces/${workspaceId}/notes/${note.id}`;

      await owner.goto(notePath);
      const body = owner.getByRole("textbox", { name: /Note content/u });
      await expect(body).toBeVisible();

      // ------------------------------------------------- author across a page break
      await body.click();
      await owner.keyboard.type("Content before the break.");
      await owner.keyboard.press("Control+Shift+Enter");
      await owner.keyboard.type("Content after the break.");
      await expect(owner.locator(".notted-editor-content .notted-page-break")).toHaveCount(1);
      // NOT the save indicator. `NoteEditorSurface` binds one writer at a time,
      // and a synced collaborative session is the writer here: the API's Yjs
      // projection owns `notes.content` and the Part 39 autosave machine is
      // deliberately left unbound, so the indicator stays "No unsaved changes."
      // forever. Poll the persisted row instead, which is the thing the save
      // status was only ever standing in for.
      await expect
        .poll(
          async () => {
            const detail = await apiGet(
              owner.request,
              `/api/v1/workspaces/${workspaceId}/notes/${note.id}`,
            );
            return JSON.stringify(detail.content ?? null);
          },
          // 60 s, matching `note-images.spec.ts`'s `UPLOAD_MS` for the same
          // condition against the same contended stack: the Yjs projection
          // landing in `notes.content`. A serial full run is the slow case and
          // 20 s was the tightest budget in the suite for that wait.
          { timeout: 60_000 },
        )
        .toContain('"pageBreak"');

      // -------------------------------------- the print DOM carries only note content
      await owner.emulateMedia({ media: "print" });
      for (const selector of PRINT_HIDDEN_SELECTORS) {
        const chrome = owner.locator(selector);
        if ((await chrome.count()) === 0) continue;
        await expect(chrome.first(), `${selector} was still painted in print`).toBeHidden();
      }
      // The strongest reading of "only note content": no interactive control of
      // any kind survives into the printed page. Links are deliberately not
      // included — a link inside the note is content and should print.
      expect(await owner.locator("button:visible").count()).toBe(0);
      expect(await owner.locator("nav:visible").count()).toBe(0);
      expect(await owner.locator("input:visible, select:visible").count()).toBe(0);

      await expect(owner.locator(".notted-editor-content")).toBeVisible();
      await expect(owner.locator(".notted-editor-content")).toContainText(
        "Content before the break.",
      );
      await expect(owner.locator(".notted-editor-content")).toContainText(
        "Content after the break.",
      );

      // In print the paper drops its own padding and scaling: `@page` owns the
      // margins, so the sheet must not also apply them.
      const printedPaper = await owner.evaluate(() => {
        const paper = document.querySelector<HTMLElement>('[data-testid="notted-page-paper"]');
        if (paper === null) throw new Error("the page paper was not rendered");
        const style = window.getComputedStyle(paper);
        return { transform: style.transform, position: style.position, padding: style.padding };
      });
      expect(printedPaper.transform).toBe("none");
      expect(printedPaper.position).toBe("static");
      expect(printedPaper.padding).toBe("0px");
      await owner.emulateMedia({ media: null });

      // ---------------------------------------------------------------- A4 snapshot
      // A `<style>` element renders nothing, so `toHaveText` sees an empty
      // string; its text has to be read directly.
      await expect
        .poll(async () => owner.getByTestId("notted-page-rule").textContent())
        .toBe("@page { size: 210mm 297mm; margin: 25mm 20mm; }");
      // Written to disk, not just held in memory: the criterion asks for
      // snapshots, and a snapshot nobody can open is not evidence.
      const a4Path = testInfo.outputPath("note-a4.pdf");
      const a4Pdf = await owner.pdf({ preferCSSPageSize: true, path: a4Path });
      const a4Source = pdfSource(a4Pdf);
      const a4Boxes = pdfPageBoxes(a4Source);
      expect(a4Boxes.length).toBeGreaterThan(0);
      for (const box of a4Boxes) {
        expect(box.width).toBeCloseTo(A4_WIDTH_PT, 0);
        expect(box.height).toBeCloseTo(A4_HEIGHT_PT, 0);
      }
      // Two short paragraphs separated by one explicit break: exactly two pages,
      // and the break is what produced the second one.
      expect(pdfPageCount(a4Source)).toBe(2);
      await testInfo.attach("note-a4.pdf", { path: a4Path, contentType: "application/pdf" });

      // ------------------------------------------------------------ Letter snapshot
      await owner
        .getByRole("group", { name: "Page size" })
        .getByRole("button", { name: "US Letter" })
        .click();
      await expect(owner.getByTestId("notted-page-paper")).toHaveAttribute(
        "data-page-size",
        "letter",
      );
      await expect
        .poll(async () => owner.getByTestId("notted-page-rule").textContent())
        .toBe("@page { size: 8.5in 11in; margin: 25mm 20mm; }");
      const letterPath = testInfo.outputPath("note-letter.pdf");
      const letterPdf = await owner.pdf({ preferCSSPageSize: true, path: letterPath });
      const letterSource = pdfSource(letterPdf);
      const letterBoxes = pdfPageBoxes(letterSource);
      expect(letterBoxes.length).toBeGreaterThan(0);
      for (const box of letterBoxes) {
        expect(box.width).toBeCloseTo(LETTER_WIDTH_PT, 0);
        expect(box.height).toBeCloseTo(LETTER_HEIGHT_PT, 0);
      }
      expect(pdfPageCount(letterSource)).toBe(2);
      await testInfo.attach("note-letter.pdf", {
        path: letterPath,
        contentType: "application/pdf",
      });

      // ------------------------------------------------- focus mode: mouse and keys
      const focusToggle = owner.getByRole("button", { name: "Focus mode" });
      await focusToggle.click();
      await expect(owner.locator("html")).toHaveAttribute("data-notted-focus", "true");
      await expect(focusToggle).toHaveAttribute("aria-pressed", "true");
      await expect(owner.getByRole("group", { name: "Zoom controls" })).toBeHidden();
      await expect(owner.locator(".notted-focus-toolbar")).toBeVisible();

      // Escape leaves the mode and hands focus back to the control that started it.
      await owner.keyboard.press("Escape");
      await expect(owner.locator("html")).not.toHaveAttribute("data-notted-focus", "true");
      await expect(focusToggle).toBeFocused();
      await expect(owner.getByRole("group", { name: "Zoom controls" })).toBeVisible();

      // The keyboard route is the editor's own binding, not the button.
      await body.click();
      await owner.keyboard.press("Control+Shift+F");
      await expect(owner.locator("html")).toHaveAttribute("data-notted-focus", "true");
      await owner.keyboard.press("Control+Shift+F");
      await expect(owner.locator("html")).not.toHaveAttribute("data-notted-focus", "true");
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
