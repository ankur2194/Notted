import { randomUUID } from "node:crypto";

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import { latestActionLink } from "./mailpit";

const disposable = process.env.PLAYWRIGHT_DISPOSABLE_TEST_RUN === "true";
const apiUrl = process.env.PLAYWRIGHT_API_URL ?? "http://localhost:3001";
const appUrl = process.env.PLAYWRIGHT_APP_URL ?? "http://localhost:3000";
const password = "Fresh1!Password";

function identity(role: string) {
  const suffix = randomUUID();
  return { name: `Search ${role}`, email: `search.${role}.${suffix}@example.test`, password };
}

async function register(page: Page, account: ReturnType<typeof identity>): Promise<void> {
  await page.goto("/register");
  await page.getByLabel("Name").fill(account.name);
  await page.getByLabel("Email").fill(account.email);
  await page.getByLabel("Password", { exact: true }).fill(account.password);
  await page.getByLabel("Confirm password").fill(account.password);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.goto(await latestActionLink(page.request, account.email, "Verify your Notted email"));
  await expect(page.getByRole("heading", { name: "Email verified" })).toBeVisible();
  await page.goto("/login?redirect=%2Fworkspaces");
  await page.getByLabel("Email", { exact: true }).first().fill(account.email);
  await page.getByLabel("Password").fill(account.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/workspaces$/u);
}

async function createWorkspace(page: Page, name: string): Promise<string> {
  await page.getByRole("button", { name: "Create workspace", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Create a workspace" });
  await dialog.getByLabel("Workspace name").fill(name);
  await dialog.getByRole("button", { name: "Create workspace", exact: true }).click();
  // The first workspace route may compile lazily in the disposable Next.js
  // server. The dialog has already confirmed the committed create, so allow a
  // bounded route-compilation window rather than racing the default 5 seconds.
  await expect(page).toHaveURL(/\/workspaces\/[0-9a-f-]+$/u, { timeout: 30_000 });
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

async function apiPatch(request: APIRequestContext, path: string, data: unknown): Promise<void> {
  const response = await request.patch(`${apiUrl}${path}`, {
    headers: { Origin: appUrl, "Content-Type": "application/json" },
    data,
  });
  expect(response.ok()).toBeTruthy();
}

/**
 * The Meilisearch index (Part 51) is populated asynchronously through BullMQ,
 * so a freshly created note is not searchable the instant its POST returns.
 * Poll the suggestions endpoint until the note is present, with a bounded
 * timeout — never an unbounded wait, and never a silent skip.
 */
async function waitForIndexed(
  page: Page,
  workspaceId: string,
  needle: string,
  expectedTitle: string,
): Promise<void> {
  const path = `/api/v1/workspaces/${workspaceId}/search/suggestions?query=${encodeURIComponent(needle)}&limit=8`;
  await expect
    .poll(
      async () => {
        const response = await page.request.get(`${apiUrl}${path}`, {
          headers: { Origin: appUrl },
        });
        if (!response.ok()) return false;
        const body = (await response.json()) as Array<{ title: string }>;
        return body.some((item) => item.title === expectedTitle);
      },
      { timeout: 30_000, intervals: [500, 1_000, 2_000] },
    )
    .toBeTruthy();
}

async function signIn(page: Page, account: ReturnType<typeof identity>): Promise<void> {
  await page.goto("/login?redirect=%2Fworkspaces");
  await page.getByLabel("Email", { exact: true }).first().fill(account.email);
  await page.getByLabel("Password").fill(account.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/workspaces/u);
}

test.describe.serial("Part 52 full-text search UI", () => {
  test.skip(
    !disposable,
    "search UI requires PLAYWRIGHT_DISPOSABLE_TEST_RUN=true and disposable PostgreSQL, Redis, and Mailpit",
  );

  // A single distinctive token appears in BOTH the title and the body so the
  // suggestion (title prefix) and the full-text (title + content) paths can
  // both match it without colliding with other seeded notes.
  const token = `Beeblebrox${randomUUID().slice(0, 8)}`;
  const title = `${token} release notes`;
  const account = identity("owner");
  const workspaceName = `Search Alpha ${randomUUID().slice(0, 8)}`;

  let workspaceId = "";
  let noteId = "";

  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext();
    const owner = await context.newPage();
    await register(owner, account);
    workspaceId = await createWorkspace(owner, workspaceName);

    const created = await apiPost(
      owner.request,
      `/api/v1/workspaces/${workspaceId}/notes`,
      { title, projectId: null, folderId: null, parentId: null },
      randomUUID(),
    );
    const note = created.note as { id: string; version: number };
    noteId = note.id;
    // Seed searchable body content so the full-text path matches too.
    await apiPatch(owner.request, `/api/v1/workspaces/${workspaceId}/notes/${note.id}`, {
      expectedVersion: note.version,
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: `The ${token} roadmap ships the next quarter of work.` },
            ],
          },
        ],
      },
    });

    await waitForIndexed(owner, workspaceId, token, title);
    await context.close();
  });

  test("opens the palette with Ctrl+K, surfaces a seeded note, and navigates on select", async ({
    page,
  }) => {
    await signIn(page, account);
    await page.goto(`/workspaces/${workspaceId}`);
    // The disposable Next.js dev server can finish navigation before the
    // client TopBar has hydrated and installed its document keydown listener.
    await expect(page.getByRole("button", { name: "Open command menu and search" })).toBeVisible();

    // Ctrl+K (Control on CI Linux). Meta+K is exercised on macOS runners.
    //
    // Pressed on a poll rather than once. The trigger being VISIBLE only proves
    // the server-rendered markup arrived; the document keydown listener is
    // installed by `TopBar`'s effect, which under load can still be pending, and
    // a chord pressed before then is simply lost — no later timeout recovers it.
    // Repeating is safe because the handler returns early while the palette is
    // open (`if (commandOpen) return`), so it can never toggle back closed.
    const palette = page.getByRole("dialog", { name: "Search notes" });
    await expect
      .poll(
        async () => {
          await page.keyboard.press("Control+K");
          return palette.isVisible();
        },
        { timeout: 15_000 },
      )
      .toBe(true);
    const combobox = palette.getByRole("combobox", { name: "Search notes" });
    await expect(combobox).toBeFocused();

    await combobox.fill(token);
    const option = palette.getByRole("option", { name: new RegExp(token, "u") });
    await expect(option).toBeVisible();
    await page.keyboard.press("Enter");

    await expect(page).toHaveURL(new RegExp(`/notes/${noteId}$`, "u"));
  });

  test("keyboard selection lands on the highlighted option", async ({ page }) => {
    await signIn(page, account);
    await page.goto(`/workspaces/${workspaceId}`);
    await expect(page.getByRole("button", { name: "Open command menu and search" })).toBeVisible();

    await page.keyboard.press("Control+K");
    const palette = page.getByRole("dialog", { name: "Search notes" });
    const combobox = palette.getByRole("combobox", { name: "Search notes" });
    await combobox.fill(token);
    const option = palette.getByRole("option", { name: new RegExp(token, "u") });
    await expect(option).toBeVisible();
    // ArrowDown moves the active option; Enter opens it without a click.
    await page.keyboard.press("ArrowDown");
    await expect(option).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`/notes/${noteId}$`, "u"));
  });

  test("renders the full search route with results and filters", async ({ page }) => {
    await signIn(page, account);
    await page.goto(`/workspaces/${workspaceId}/search?query=${encodeURIComponent(token)}`);
    await expect(page.getByRole("heading", { level: 1, name: "Search" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Search filters" })).toBeVisible();
    // The sidebar note tree contains a second link with the same title; scope
    // to main content so the assertion and click exercise the search result.
    const result = page.getByRole("main").getByRole("link", { name: new RegExp(token, "u") });
    await expect(result).toBeVisible();
    // Pagination stays absent for a single result.
    await expect(page.getByRole("navigation", { name: "Search results pagination" })).toBeHidden();
    await result.click();
    await expect(page).toHaveURL(new RegExp(`/notes/${noteId}$`, "u"));
  });

  test("shows a no-results state for an unknown query", async ({ page }) => {
    await signIn(page, account);
    const unknown = `nomatch-${randomUUID()}`;
    await page.goto(`/workspaces/${workspaceId}/search?query=${encodeURIComponent(unknown)}`);
    await expect(page.getByText(/No notes match/u)).toBeVisible();
    await expect(
      page.getByRole("main").getByRole("link", { name: new RegExp(token, "u") }),
    ).toBeHidden();
  });
});
