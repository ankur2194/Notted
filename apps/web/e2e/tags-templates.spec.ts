import { randomUUID } from "node:crypto";

import {
  expect,
  test,
  type APIRequestContext,
  type BrowserContext,
  type Page,
} from "@playwright/test";

import { latestActionLink } from "./mailpit";

const disposable = process.env.PLAYWRIGHT_DISPOSABLE_TEST_RUN === "true";
const apiUrl = process.env.PLAYWRIGHT_API_URL ?? "http://localhost:3001";
const appUrl = process.env.PLAYWRIGHT_APP_URL ?? "http://localhost:3000";
const password = "Fresh1!Password";

/** A cold Next.js dev route compiles on its first visit. */
const ROUTE_COMPILE_MS = 45_000;
/** Autosave debounce plus the round trip. */
const SAVE_MS = 30_000;

interface NoteRow {
  readonly id: string;
  readonly title: string;
  readonly version: number;
}
interface TagRow {
  readonly id: string;
  readonly name: string;
}
interface ListPage<TItem> {
  readonly items: readonly TItem[];
}

function identity(role: string) {
  const suffix = randomUUID();
  return { name: `Tags ${role}`, email: `tags.${role}.${suffix}@example.test`, password };
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

async function apiPost<T>(
  request: APIRequestContext,
  path: string,
  data: unknown,
  idempotencyKey?: string,
): Promise<T> {
  const response = await request.post(`${apiUrl}${path}`, {
    headers: {
      Origin: appUrl,
      ...(idempotencyKey === undefined ? {} : { "Idempotency-Key": idempotencyKey }),
    },
    data,
  });
  expect(response.ok()).toBeTruthy();
  return response.json() as Promise<T>;
}

async function apiGet<T>(request: APIRequestContext, path: string): Promise<T> {
  const response = await request.get(`${apiUrl}${path}`);
  expect(response.ok()).toBeTruthy();
  return response.json() as Promise<T>;
}

async function inviteAndJoin(
  owner: Page,
  member: Page,
  workspaceId: string,
  workspaceName: string,
  account: ReturnType<typeof identity>,
  role: "editor" | "viewer",
) {
  const invite = await owner.request.post(
    `${apiUrl}/api/v1/workspaces/${workspaceId}/invitations`,
    {
      headers: { Origin: appUrl },
      data: { email: account.email, role },
    },
  );
  expect(invite.ok()).toBeTruthy();
  await register(member, account);
  await member.goto(await latestActionLink(owner.request, account.email, `Join ${workspaceName}`));
  await member.getByRole("button", { name: "Accept workspace invitation" }).click();
  // The workspace route is compiled on demand by the dev server, so the
  // post-accept redirect gets the same budget every other navigation here does.
  // The default 5s expect timeout makes this the flakiest step in the setup.
  await expect(member).toHaveURL(`/workspaces/${workspaceId}`, { timeout: ROUTE_COMPILE_MS });
}

/** One standalone note, created through the API so each journey starts from data. */
async function createNote(page: Page, workspaceId: string, title: string): Promise<string> {
  const result = await apiPost<{ note: NoteRow }>(
    page.request,
    `/api/v1/workspaces/${workspaceId}/notes`,
    { title, projectId: null, folderId: null, parentId: null },
    randomUUID(),
  );
  return result.note.id;
}

async function assignTags(
  page: Page,
  workspaceId: string,
  noteId: string,
  tagIds: readonly string[],
): Promise<void> {
  const current = await apiGet<NoteRow>(
    page.request,
    `/api/v1/workspaces/${workspaceId}/notes/${noteId}`,
  );
  // Assignment is a full replace on the note itself: there are deliberately no
  // per-edge assign/remove routes that could drift out of step with the note's
  // optimistic-concurrency version.
  const response = await page.request.patch(
    `${apiUrl}/api/v1/workspaces/${workspaceId}/notes/${noteId}`,
    { headers: { Origin: appUrl }, data: { expectedVersion: current.version, tagIds } },
  );
  expect(response.ok()).toBeTruthy();
}

function noteTitles(page: Page) {
  return page.getByRole("main").getByRole("list", { name: "Notes" }).getByRole("link");
}

function editorBody(page: Page) {
  return page.getByRole("textbox", { name: /Note content/u });
}

async function waitForSaved(page: Page): Promise<void> {
  await expect(page.getByTestId("note-save-status")).toHaveText(/Saved\./u, { timeout: SAVE_MS });
}

test.describe.serial("Part 46 real-stack tags and templates", () => {
  test.skip(
    !disposable,
    "tags and templates require PLAYWRIGHT_DISPOSABLE_TEST_RUN=true and disposable PostgreSQL, Redis, and Mailpit",
  );

  const suffix = randomUUID().slice(0, 8);
  const workspaceName = `Tags Alpha ${suffix}`;
  const otherWorkspaceName = `Tags Beta ${suffix}`;
  const tagName = `Roadmap ${suffix}`;
  const sourceTitle = `Template source ${suffix}`;

  const contexts: BrowserContext[] = [];
  let owner: Page;
  let editor: Page;
  let viewer: Page;
  let other: Page;
  let workspaceId = "";
  let otherWorkspaceId = "";
  let tagId = "";

  test.beforeAll(async ({ browser }) => {
    // Four verified accounts and two workspaces is more setup than a single
    // test budget covers, and every test in this serial file shares them.
    test.setTimeout(300_000);
    async function open(): Promise<Page> {
      const context = await browser.newContext();
      contexts.push(context);
      return context.newPage();
    }
    owner = await open();
    editor = await open();
    viewer = await open();
    other = await open();

    await register(owner, identity("owner"));
    workspaceId = await createWorkspace(owner, workspaceName);
    await inviteAndJoin(owner, editor, workspaceId, workspaceName, identity("editor"), "editor");
    await inviteAndJoin(owner, viewer, workspaceId, workspaceName, identity("viewer"), "viewer");
    await register(other, identity("other-tenant"));
    otherWorkspaceId = await createWorkspace(other, otherWorkspaceName);
  });

  test.afterAll(async () => {
    if (workspaceId !== "")
      await owner.request
        .delete(`${apiUrl}/api/v1/workspaces/${workspaceId}`, {
          headers: { Origin: appUrl },
          data: { confirm: true, expectedName: workspaceName },
        })
        .catch(() => undefined);
    if (otherWorkspaceId !== "")
      await other.request
        .delete(`${apiUrl}/api/v1/workspaces/${otherWorkspaceId}`, {
          headers: { Origin: appUrl },
          data: { confirm: true, expectedName: otherWorkspaceName },
        })
        .catch(() => undefined);
    await Promise.all(contexts.map(async (context) => context.close()));
  });

  test("rejects a duplicate tag name and leaves exactly one tag behind", async () => {
    const created = await apiPost<{ tag: TagRow }>(
      owner.request,
      `/api/v1/workspaces/${workspaceId}/tags`,
      { name: tagName, color: "#2563eb" },
      randomUUID(),
    );
    tagId = created.tag.id;

    // A fresh idempotency key, so this is a second create attempt rather than a
    // replay of the first: the workspace-unique name is what has to reject it.
    const duplicate = await owner.request.post(`${apiUrl}/api/v1/workspaces/${workspaceId}/tags`, {
      headers: { Origin: appUrl, "Idempotency-Key": randomUUID() },
      data: { name: tagName, color: "#16a34a" },
    });
    expect(duplicate.status()).toBe(409);
    const body = (await duplicate.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("TAG_NAME_TAKEN");

    const listed = await apiGet<ListPage<TagRow>>(
      owner.request,
      `/api/v1/workspaces/${workspaceId}/tags?page=1&limit=100`,
    );
    expect(listed.items.filter((tag) => tag.name === tagName)).toHaveLength(1);
  });

  test("narrows the note list to a tag and clears the filter again", async () => {
    const taggedId = await createNote(owner, workspaceId, `Tagged note ${suffix}`);
    await createNote(owner, workspaceId, `Untagged note ${suffix}`);
    await assignTags(owner, workspaceId, taggedId, [tagId]);

    await owner.goto(`/workspaces/${workspaceId}/notes`);
    await expect(noteTitles(owner)).toHaveCount(2, { timeout: ROUTE_COMPILE_MS });
    // The chip names the tag; the colour is only a dot beside that name.
    // `exact` is required: getByRole matches the accessible name as a SUBSTRING
    // by default, so "Tagged note …" would also select the "Untagged note …"
    // card and the ancestor lookup would resolve to two articles.
    await expect(
      owner
        .getByRole("main")
        .getByRole("link", { name: `Tagged note ${suffix}`, exact: true })
        .locator("xpath=ancestor::article"),
    ).toContainText(tagName);

    /*
     * Addressed by href rather than by label. The sidebar tag link is the
     * `noteListHref(workspaceId, { tagId })` contract, and pinning the click to
     * that contract keeps this journey independent of how the sidebar happens
     * to word the link.
     */
    await owner.locator(`a[href*="tagId=${tagId}"]`).first().click();
    await expect(owner).toHaveURL(new RegExp(`tagId=${tagId}`, "u"));
    await expect(noteTitles(owner)).toHaveCount(1, { timeout: ROUTE_COMPILE_MS });
    await expect(noteTitles(owner)).toHaveText([`Tagged note ${suffix}`]);
    await expect(owner.getByText(`Filtered by tag: ${tagName}`)).toBeVisible();

    // Scoped to `main`: the sidebar's tag list renders its own "Clear tag
    // filter" link, and both are legitimate in their own landmark.
    await owner.getByRole("main").getByRole("link", { name: "Clear tag filter" }).click();
    await expect(noteTitles(owner)).toHaveCount(2, { timeout: ROUTE_COMPILE_MS });
    await expect(owner.getByText(`Filtered by tag: ${tagName}`)).toHaveCount(0);
  });

  test("copies templates by value in both directions with no live link back", async () => {
    // Two editor sessions with autosave, plus five page loads.
    test.slow();
    const sourceId = await createNote(owner, workspaceId, sourceTitle);
    await owner.goto(`/workspaces/${workspaceId}/notes/${sourceId}`);
    await expect(editorBody(owner)).toBeVisible({ timeout: ROUTE_COMPILE_MS });
    await editorBody(owner).click();
    await owner.keyboard.type("Original body.");
    await waitForSaved(owner);

    // ------------------------------------------------------ save as template
    await owner.goto(`/workspaces/${workspaceId}/notes`);
    const sourceCard = owner
      .getByRole("main")
      .getByRole("link", { name: sourceTitle })
      .locator("xpath=ancestor::article");
    await expect(sourceCard).toBeVisible({ timeout: ROUTE_COMPILE_MS });
    await sourceCard.getByRole("button", { name: "Save as template" }).click();
    await expect(owner.getByText(`Saved ${sourceTitle} as a template.`)).toBeVisible();

    /*
     * The original is still an ordinary note under All notes. Both rows carry
     * the same title — a copy inherits it — so the two are told apart by the
     * "Template" state chip that exactly one of them has.
     */
    await owner.goto(`/workspaces/${workspaceId}/notes`);
    await expect(owner.getByRole("main").getByRole("link", { name: sourceTitle })).toHaveCount(2, {
      timeout: ROUTE_COMPILE_MS,
    });
    // `exact` matters: the shared title starts with "Template", and the view nav
    // link is the lowercase "templates".
    await expect(owner.getByRole("main").getByText("Template", { exact: true })).toHaveCount(1);

    await owner.goto(`/workspaces/${workspaceId}/notes/templates`);
    await expect(noteTitles(owner)).toHaveText([sourceTitle], { timeout: ROUTE_COMPILE_MS });

    // -------------------------------------------------- create from template
    await owner.getByRole("button", { name: "Create from template" }).click();
    await expect(owner.getByText(`Created ${sourceTitle} from the template.`)).toBeVisible();

    const listPath = `/api/v1/workspaces/${workspaceId}/notes?page=1&limit=50&scope=workspace-root&sortBy=createdAt&sortDirection=desc`;
    const templates = await apiGet<ListPage<NoteRow>>(owner.request, `${listPath}&view=templates`);
    const templateId = templates.items.find((note) => note.title === sourceTitle)!.id;
    const plain = await apiGet<ListPage<NoteRow>>(
      owner.request,
      `${listPath}&view=normal&isTemplate=false`,
    );
    const copy = plain.items.find((note) => note.title === sourceTitle && note.id !== sourceId)!;

    // ------------------------------------------------------ content matches…
    await owner.goto(`/workspaces/${workspaceId}/notes/${copy.id}`);
    await expect(editorBody(owner)).toContainText("Original body.", { timeout: ROUTE_COMPILE_MS });

    // ------------------------ …and editing the copy never reaches the template
    await editorBody(owner).click();
    await owner.keyboard.press("End");
    await owner.keyboard.type(" Edited copy.");
    await waitForSaved(owner);

    await owner.goto(`/workspaces/${workspaceId}/notes/${templateId}`);
    await owner.reload();
    await expect(editorBody(owner)).toContainText("Original body.", { timeout: ROUTE_COMPILE_MS });
    await expect(editorBody(owner)).not.toContainText("Edited copy.");
  });

  test("keeps tags inside their workspace and answers a foreign tag id with 404", async () => {
    const listed = await apiGet<ListPage<TagRow>>(
      other.request,
      `/api/v1/workspaces/${otherWorkspaceId}/tags?page=1&limit=100`,
    );
    expect(listed.items.map((tag) => tag.id)).not.toContain(tagId);
    expect(listed.items.map((tag) => tag.name)).not.toContain(tagName);

    /*
     * 404 and not 403. A 403 would confirm that the tag exists somewhere, which
     * is exactly the cross-workspace existence leak the API contract forbids.
     */
    const patched = await other.request.patch(
      `${apiUrl}/api/v1/workspaces/${otherWorkspaceId}/tags/${tagId}`,
      { headers: { Origin: appUrl }, data: { name: `Stolen ${suffix}` } },
    );
    expect(patched.status()).toBe(404);
  });

  test("lets an editor create tags but not delete them, and blocks viewers entirely", async () => {
    const editorTag = await editor.request.post(`${apiUrl}/api/v1/workspaces/${workspaceId}/tags`, {
      headers: { Origin: appUrl, "Idempotency-Key": randomUUID() },
      data: { name: `Editor tag ${suffix}`, color: "#7c3aed" },
    });
    expect(editorTag.status()).toBe(201);
    const editorTagId = ((await editorTag.json()) as { tag: TagRow }).tag.id;

    const editorDelete = await editor.request.delete(
      `${apiUrl}/api/v1/workspaces/${workspaceId}/tags/${editorTagId}`,
      { headers: { Origin: appUrl } },
    );
    expect(editorDelete.status()).toBe(403);

    const viewerCreate = await viewer.request.post(
      `${apiUrl}/api/v1/workspaces/${workspaceId}/tags`,
      {
        headers: { Origin: appUrl, "Idempotency-Key": randomUUID() },
        data: { name: `Viewer tag ${suffix}`, color: "#7c3aed" },
      },
    );
    expect(viewerCreate.status()).toBe(403);

    // An editor may instantiate a template; a viewer is never offered the
    // control, and the backend denial behind it stays authoritative.
    await editor.goto(`/workspaces/${workspaceId}/notes/templates`);
    await expect(editor.getByRole("button", { name: "Create from template" })).toBeVisible({
      timeout: ROUTE_COMPILE_MS,
    });

    await viewer.goto(`/workspaces/${workspaceId}/notes/templates`);
    await expect(viewer.getByRole("main").getByRole("link", { name: sourceTitle })).toBeVisible({
      timeout: ROUTE_COMPILE_MS,
    });
    await expect(viewer.getByRole("button", { name: "Create from template" })).toHaveCount(0);
    await expect(viewer.getByRole("main").getByText("Read-only access").first()).toBeVisible();
  });
});
