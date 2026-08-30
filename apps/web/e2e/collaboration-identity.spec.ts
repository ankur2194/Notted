import { randomUUID } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";

import { latestActionLink } from "./mailpit";

/**
 * Part 75 residual — the `note-images.spec.ts` flake, made deterministic.
 *
 * SYMPTOM. A different member of `note-images.spec.ts` failed on every full
 * chromium run (`:264`, `:387`, `:507`, `:638`, `:731`), each having also passed
 * at least once. In every failure the upload itself answered `201` in ~46 ms,
 * the browser then never fetched `…/content`, and the editor was blank —
 * INCLUDING the paragraph the test had typed before picking any file. The lost
 * thing was therefore never the upload; it was the editor the upload was
 * inserting into.
 *
 * CAUSE. `NoteEditorSurface` resolves this writer's display name from the
 * workspace member directory and latches it into `collaborationUser`. That
 * object's `name` was a dependency of `useNoteCollaboration`'s effect, so the
 * latch destroyed the provider, pushed `mode` back to `"pending"` — which
 * renders a skeleton INSTEAD of the editor — and re-handshook onto a fresh
 * `Y.Doc`. Everything typed since mount that had not yet reached the server died
 * with the old document, and `useImageUploads`'s recorded caret and insertion
 * controller pointed at an editor that no longer existed.
 *
 * The comment that guarded this said the re-handshake "happens while the
 * directory request is still in flight — before anyone has typed". That is a
 * RACE, not an invariant: it holds only while the directory beats the socket
 * handshake. Under load on a memory-bound host it does not, which is exactly why
 * the failing member rotated between runs.
 *
 * THIS SPEC TAKES THE RACE OUT OF THE EXPERIMENT by holding the directory
 * response back until the editor is up, synced, and typed into. The losing
 * ordering then happens every run instead of some runs.
 */

const disposable = process.env.PLAYWRIGHT_DISPOSABLE_TEST_RUN === "true";
const apiUrl = process.env.PLAYWRIGHT_API_URL ?? "http://localhost:3001";
const appUrl = process.env.PLAYWRIGHT_APP_URL ?? "http://localhost:3000";
const password = "Fresh1!Password";

/** Generous enough for a cold Next dev-server route compile. */
const ROUTE_COMPILE_MS = 45_000;

/**
 * Ceiling on how long the member directory may be held.
 *
 * MUST stay under `DEFAULT_TIMEOUT_MS` (8 s) in
 * `apps/web/src/lib/api/request-json.ts`: every request runs under an
 * `AbortSignal.timeout`, so a longer hold does not delay the response, it
 * CANCELS it — `net::ERR_ABORTED`, no response event, and a directory that never
 * resolves at all. Overrunning is survivable rather than fatal, because the
 * query client retries once (`ReactQueryProvider`, `retry: 1`) and the retry
 * finds the gate already open.
 */
const DIRECTORY_HOLD_CAP_MS = 7_000;

const TYPED = "Typed before the directory resolved.";

test.describe.serial("Part 75 — display-name resolution never remounts a live editor", () => {
  test.skip(
    !disposable,
    "requires PLAYWRIGHT_DISPOSABLE_TEST_RUN=true and disposable PostgreSQL, Redis, and Mailpit",
  );

  test("keeps the live editor when the member directory resolves late", async ({ browser }) => {
    test.slow();
    const context = await browser.newContext();
    const page = await context.newPage();
    const workspaceName = `Identity ${randomUUID().slice(0, 8)}`;
    let workspaceId: string | null = null;

    try {
      const suffix = randomUUID();
      await register(page, {
        name: "Identity owner",
        email: `identity.owner.${suffix}@example.test`,
        password,
      });
      workspaceId = await createWorkspace(page, workspaceName);
      const noteId = await createNote(page, workspaceId, "Identity note");

      /*
       * The forcing function, gated on the test's own progress rather than on a
       * wall clock: a fixed delay would only reproduce the ordering that happens
       * to be slower than the socket handshake on the day. Every other request
       * is untouched, so the session connects at its normal speed.
       */
      let released = false;
      const directoryPattern = /\/api\/v1\/workspaces\/[^/]+\/members(\?|$)/u;
      await page.route(directoryPattern, async (route) => {
        const deadline = Date.now() + DIRECTORY_HOLD_CAP_MS;
        while (!released && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        // A request the page already abandoned cannot be continued, and that is
        // not a test failure: the query client's retry brings the next one.
        await route.continue().catch(() => undefined);
      });

      /*
       * Counts how many times a ProseMirror root is CREATED.
       * `.notted-editor-content` is `TiptapEditor`'s own root element, so a
       * second one is a second editor instance — the remount itself, not a proxy
       * for it. Installed as an init script because the mount it has to catch
       * happens during hydration, and recorded by a `MutationObserver` because a
       * polled `count()` cannot see a replacement that takes milliseconds.
       */
      await page.addInitScript(() => {
        const seen = new Set<Element>();
        (window as unknown as { __nottedMounts: () => number }).__nottedMounts = () => seen.size;
        const scan = (): void => {
          for (const element of document.querySelectorAll(".notted-editor-content")) {
            seen.add(element);
          }
        };
        // `document`, NOT `document.documentElement`: an init script runs before
        // the first byte of the document is parsed, so `documentElement` is null
        // and `observe` throws — leaving the counter installed, reporting 0, and
        // silently proving nothing.
        //
        // `attributes` as well as `childList`: TipTap appends the ProseMirror
        // node FIRST and applies `editorProps.attributes` afterwards, so a
        // childList-only observer sees the element before it carries the class.
        new MutationObserver(scan).observe(document, {
          attributes: true,
          childList: true,
          subtree: true,
        });
      });

      // Armed before the navigation: the directory request is issued during
      // hydration, so a waiter armed later can miss the only response there is.
      const directoryLanded = page.waitForResponse(
        (response) => directoryPattern.test(new URL(response.url()).pathname),
        { timeout: ROUTE_COMPILE_MS },
      );

      await page.goto(`/workspaces/${workspaceId}/notes/${noteId}`);

      const body = page.getByRole("textbox", { name: /Note content/u });
      await expect(body).toBeVisible({ timeout: ROUTE_COMPILE_MS });
      // A COLLABORATIVE session, not a solo fallback: a solo editor is never
      // remounted by a name change and the experiment would be vacuous.
      await expect(page.getByTestId("note-collab-status")).toHaveAttribute(
        "data-collab-status",
        "synced",
        { timeout: ROUTE_COMPILE_MS },
      );

      await body.click();
      await page.keyboard.type(TYPED);
      await expect(body).toContainText(TYPED);

      // Only now may the name resolve.
      released = true;
      await directoryLanded;

      /*
       * DURABILITY, and the settle point in one. The server-side Yjs projection
       * is the only writer of `notes.content` while a session is live, so a
       * document that reaches the row is a document the name resolution did not
       * eat. Waiting for it also guarantees React has processed the directory
       * response long before the counter below is read — no sleep, and no window
       * the assertion depends on.
       */
      await expect
        .poll(
          async () => {
            const response = await page.request.get(
              `${apiUrl}/api/v1/workspaces/${workspaceId!}/notes/${noteId}`,
              { headers: { Origin: appUrl } },
            );
            if (!response.ok()) return "";
            const detail = (await response.json()) as { content: unknown };
            return JSON.stringify(detail.content);
          },
          { timeout: 60_000 },
        )
        .toContain(TYPED);

      // THE MECHANISM. A display name is awareness metadata; resolving it must
      // change neither the shared document nor the mount.
      const editorMounts = await page.evaluate(
        () => (window as unknown as { __nottedMounts?: () => number }).__nottedMounts?.() ?? -1,
      );
      expect(editorMounts, "the editor was remounted when the display name resolved").toBe(1);
    } finally {
      if (workspaceId !== null) {
        await page.request
          .delete(`${apiUrl}/api/v1/workspaces/${workspaceId}`, {
            headers: { Origin: appUrl },
            data: { confirm: true, expectedName: workspaceName },
          })
          .catch(() => undefined);
      }
      await context.close();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Local helpers, per this repository's per-spec convention                     */
/* -------------------------------------------------------------------------- */

async function register(
  page: Page,
  account: { name: string; email: string; password: string },
): Promise<void> {
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

async function createNote(page: Page, workspaceId: string, title: string): Promise<string> {
  const response = await page.request.post(`${apiUrl}/api/v1/workspaces/${workspaceId}/notes`, {
    headers: { Origin: appUrl, "Idempotency-Key": randomUUID() },
    data: { title, projectId: null, folderId: null, parentId: null },
  });
  await expect(response).toBeOK();
  const result = (await response.json()) as { note: { id: string } };
  return result.note.id;
}
