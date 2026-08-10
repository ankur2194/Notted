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
const DAY_MS = 24 * 60 * 60 * 1_000;

interface NoteRow {
  readonly id: string;
  readonly title: string;
}
interface TaskRow {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly dueDate: string | null;
  readonly completedAt: string | null;
  readonly assigneeId: string | null;
}
interface MemberRow {
  readonly userId: string;
  readonly name: string;
}
interface ListPage<TItem> {
  readonly items: readonly TItem[];
}

function identity(role: string) {
  const suffix = randomUUID();
  return { name: `Tasks ${role}`, email: `tasks.${role}.${suffix}@example.test`, password };
}

type Account = ReturnType<typeof identity>;

/**
 * Signing in is separate from registering because Part 47 needs two independent
 * browser contexts holding the SAME account: an editor may only update tasks it
 * created, so the concurrent-reorder journey cannot use a second person.
 */
async function signIn(page: Page, account: Account): Promise<void> {
  await page.goto("/login?redirect=%2Fworkspaces");
  await page.getByLabel("Email", { exact: true }).first().fill(account.email);
  await page.getByLabel("Password").fill(account.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/workspaces$/u, { timeout: ROUTE_COMPILE_MS });
}

async function register(page: Page, account: Account): Promise<void> {
  await page.goto("/register");
  await page.getByLabel("Name").fill(account.name);
  await page.getByLabel("Email").fill(account.email);
  await page.getByLabel("Password", { exact: true }).fill(account.password);
  await page.getByLabel("Confirm password").fill(account.password);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.goto(await latestActionLink(page.request, account.email, "Verify your Notted email"));
  await expect(page.getByRole("heading", { name: "Email verified" })).toBeVisible();
  await signIn(page, account);
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
  account: Account,
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

/**
 * A note whose `type` is `task-list`. The editor stays mounted for this type —
 * the task list is rendered below the paper, not instead of it — so every
 * journey below can assume both halves are present.
 */
async function createTaskListNote(page: Page, workspaceId: string, title: string): Promise<string> {
  const result = await apiPost<{ note: NoteRow }>(
    page.request,
    `/api/v1/workspaces/${workspaceId}/notes`,
    { title, type: "task-list", projectId: null, folderId: null, parentId: null },
    randomUUID(),
  );
  return result.note.id;
}

interface TaskSeed {
  readonly title: string;
  /** One canonical UTC instant: the contract has no separate time field. */
  readonly dueDate?: string;
  readonly recurrence?: "weekly";
}

async function createTask(
  page: Page,
  workspaceId: string,
  noteId: string,
  seed: TaskSeed,
): Promise<TaskRow> {
  const result = await apiPost<{ task: TaskRow }>(
    page.request,
    `/api/v1/workspaces/${workspaceId}/tasks`,
    { noteId, ...seed },
    randomUUID(),
  );
  return result.task;
}

function listTasks(page: Page, workspaceId: string, noteId: string): Promise<ListPage<TaskRow>> {
  const search = new URLSearchParams({
    page: "1",
    limit: "100",
    noteId,
    grouping: "none",
    sortBy: "sortOrder",
    sortDirection: "asc",
  });
  return apiGet<ListPage<TaskRow>>(
    page.request,
    `/api/v1/workspaces/${workspaceId}/tasks?${search.toString()}`,
  );
}

function notePath(workspaceId: string, noteId: string): string {
  return `/workspaces/${workspaceId}/notes/${noteId}`;
}

/**
 * One rendered task row, addressed by the only control whose accessible name is
 * unique to it. A title appears in several sr-only labels on the same row, so
 * matching text would match the row several times over.
 */
function taskRow(page: Page, title: string) {
  return page
    .getByRole("main")
    .getByRole("listitem")
    .filter({ has: page.getByRole("checkbox", { name: `Complete ${title}`, exact: true }) });
}

function completeCheckbox(page: Page, title: string) {
  return page.getByRole("checkbox", { name: `Complete ${title}`, exact: true });
}

function selectCheckbox(page: Page, title: string) {
  return page.getByRole("checkbox", { name: `Select ${title}`, exact: true });
}

/**
 * The rendered order, read from each row's title field.
 *
 * The persisted title is the input's *value*, not its text, so this is the only
 * honest way to read the order back without reaching for an id or a test id.
 */
async function taskTitles(page: Page): Promise<string[]> {
  const fields = await page.getByRole("textbox", { name: /^Title for /u }).all();
  return Promise.all(fields.map(async (field) => field.inputValue()));
}

test.describe.serial("Part 47 real-stack task lists", () => {
  test.skip(
    !disposable,
    "task lists require PLAYWRIGHT_DISPOSABLE_TEST_RUN=true and disposable PostgreSQL, Redis, and Mailpit",
  );

  const suffix = randomUUID().slice(0, 8);
  const workspaceName = `Tasks Alpha ${suffix}`;
  const otherWorkspaceName = `Tasks Beta ${suffix}`;
  const editorIdentity = identity("editor");
  const ownerIdentity = identity("owner");

  const contexts: BrowserContext[] = [];
  let owner: Page;
  /** A second session of the SAME owner account, for the concurrency journey. */
  let ownerSecond: Page;
  let editor: Page;
  let other: Page;
  let workspaceId = "";
  let otherWorkspaceId = "";
  let otherUserId = "";

  test.beforeAll(async ({ browser }) => {
    // Three verified accounts, two workspaces and a second owner session is far
    // more setup than one test budget covers, and every test here shares it.
    test.setTimeout(300_000);
    async function open(): Promise<Page> {
      const context = await browser.newContext();
      contexts.push(context);
      return context.newPage();
    }
    owner = await open();
    ownerSecond = await open();
    editor = await open();
    other = await open();

    await register(owner, ownerIdentity);
    workspaceId = await createWorkspace(owner, workspaceName);
    await inviteAndJoin(owner, editor, workspaceId, workspaceName, editorIdentity, "editor");
    await signIn(ownerSecond, ownerIdentity);

    await register(other, identity("other-tenant"));
    otherWorkspaceId = await createWorkspace(other, otherWorkspaceName);
    const members = await apiGet<ListPage<MemberRow>>(
      other.request,
      `/api/v1/workspaces/${otherWorkspaceId}/members?page=1&limit=50`,
    );
    otherUserId = members.items[0]!.userId;
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

  test("renders the task list below a still-mounted page editor", async () => {
    const noteTitle = `Coexistence note ${suffix}`;
    const seeds = [`Coexist one ${suffix}`, `Coexist two ${suffix}`, `Coexist three ${suffix}`];
    const noteId = await createTaskListNote(owner, workspaceId, noteTitle);

    await owner.goto(notePath(workspaceId, noteId));
    await expect(owner.getByRole("heading", { level: 2, name: "Tasks" })).toBeVisible({
      timeout: ROUTE_COMPILE_MS,
    });

    const addForm = owner.locator("form").filter({ has: owner.getByLabel("New task") });
    for (const title of seeds) {
      await owner.getByLabel("New task").fill(title);
      await owner.getByRole("button", { name: "Add task" }).click();
      /*
       * `aria-busy` on the add form, NOT the live-region text. `create()` sets
       * "Added …" before it awaits `reconcile()`, and the `router.refresh()`
       * inside reconcile can land during the next add and replace the message,
       * so the status is not a reliable "the previous add finished" signal.
       * The form stays busy until the whole create-and-reconcile cycle
       * resolves, which is exactly the condition that makes the next add safe.
       */
      await expect(addForm).toHaveAttribute("aria-busy", "false", {
        timeout: ROUTE_COMPILE_MS,
      });
      await expect(taskRow(owner, title)).toBeVisible();
    }

    /*
     * Both halves, and their order. The two level-2 headings inside `main` are
     * the sr-only "Note content" that labels the paper and the visible "Tasks"
     * that labels the list, so reading them in document order is exactly the
     * assertion "the task list is BELOW the editor, and the editor is still
     * there" — a check that a regression hiding either one would fail.
     */
    await expect(owner.getByRole("main").getByRole("heading", { level: 2 })).toHaveText([
      "Note content",
      "Tasks",
    ]);
    await expect(owner.getByRole("textbox", { name: `Note content: ${noteTitle}` })).toBeVisible();
    await expect(owner.getByRole("list", { name: "All tasks (3)" })).toBeVisible();
    await expect.poll(async () => taskTitles(owner)).toEqual(seeds);
  });

  test("moves a completed task into the Done group while grouped by status", async () => {
    const noteId = await createTaskListNote(owner, workspaceId, `Grouping note ${suffix}`);
    const staying = `Group staying ${suffix}`;
    const finishing = `Group finishing ${suffix}`;
    await createTask(owner, workspaceId, noteId, { title: staying });
    await createTask(owner, workspaceId, noteId, { title: finishing });

    await owner.goto(notePath(workspaceId, noteId));
    await expect(owner.getByRole("list", { name: "All tasks (2)" })).toBeVisible({
      timeout: ROUTE_COMPILE_MS,
    });

    await owner.getByLabel("Group tasks by").selectOption("status");
    await expect(owner.getByRole("list", { name: "To do (2)" })).toBeVisible();
    /*
     * Grouping is a client-side repartition, so it must not refetch and must
     * not silently re-enable reordering against a partial view of the order.
     */
    await expect(owner.getByRole("button", { name: `Move down ${staying}` })).toBeDisabled();
    await expect(owner.getByRole("note").filter({ hasText: /grouped/u })).toBeVisible();

    await completeCheckbox(owner, finishing).click();
    await expect(owner.getByText(`Updated ${finishing}.`)).toBeVisible();

    await expect(
      owner.getByRole("list", { name: "Done (1)" }).getByRole("checkbox", {
        name: `Complete ${finishing}`,
        exact: true,
      }),
    ).toBeVisible();
    await expect(owner.getByRole("list", { name: "To do (1)" })).toBeVisible();
    await expect(owner.getByRole("list", { name: "To do (1)" })).toContainText(staying);
  });

  test("marks a task due yesterday as overdue and leaves a future one alone", async () => {
    const noteId = await createTaskListNote(owner, workspaceId, `Overdue note ${suffix}`);
    // Neither title may contain the word "Overdue": the row's text content
    // includes its own title, so a title carrying the word would make the
    // negative assertion below impossible to satisfy no matter what the badge
    // does — and the badge is the only thing this test is about.
    const late = `Past due ${suffix}`;
    const soon = `Future due ${suffix}`;
    await createTask(owner, workspaceId, noteId, {
      title: late,
      dueDate: new Date(Date.now() - DAY_MS).toISOString(),
    });
    await createTask(owner, workspaceId, noteId, {
      title: soon,
      dueDate: new Date(Date.now() + 3 * DAY_MS).toISOString(),
    });

    await owner.goto(notePath(workspaceId, noteId));
    // Stated as a word, never as colour alone: that is the whole point of the
    // badge, so the word is what this asserts.
    await expect(taskRow(owner, late)).toContainText("Overdue", { timeout: ROUTE_COMPILE_MS });
    await expect(taskRow(owner, soon)).not.toContainText("Overdue");
  });

  test("offers workspace members as assignees and conceals a foreign user as 404", async () => {
    const noteId = await createTaskListNote(owner, workspaceId, `Assignment note ${suffix}`);
    const title = `Assignment target ${suffix}`;
    await createTask(owner, workspaceId, noteId, { title });

    await owner.goto(notePath(workspaceId, noteId));
    const assignee = owner.getByLabel(`Assignee for ${title}`);
    await expect(assignee).toContainText(editorIdentity.name, { timeout: ROUTE_COMPILE_MS });
    await assignee.selectOption({ label: editorIdentity.name });
    await expect(owner.getByText(`Updated ${title}.`)).toBeVisible();

    const alphaMembers = await apiGet<ListPage<MemberRow>>(
      owner.request,
      `/api/v1/workspaces/${workspaceId}/members?page=1&limit=50`,
    );
    const editorUserId = alphaMembers.items.find(
      (member) => member.name === editorIdentity.name,
    )!.userId;
    const assigned = await listTasks(owner, workspaceId, noteId);
    expect(assigned.items.find((task) => task.title === title)?.assigneeId).toBe(editorUserId);

    /*
     * 404 and not 403. A 403 would confirm that the identifier belongs to a
     * real user somewhere, which is the cross-tenant existence leak the API
     * contract forbids — the same reason a foreign task answers 404 below.
     */
    const foreign = await owner.request.post(`${apiUrl}/api/v1/workspaces/${workspaceId}/tasks`, {
      headers: { Origin: appUrl, "Idempotency-Key": randomUUID() },
      data: { noteId, title: `Foreign assignee ${suffix}`, assigneeId: otherUserId },
    });
    expect(foreign.status()).toBe(404);
  });

  test("applies a bulk completion to the selection and persists it across a reload", async () => {
    const noteId = await createTaskListNote(owner, workspaceId, `Bulk note ${suffix}`);
    const first = `Bulk first ${suffix}`;
    const second = `Bulk second ${suffix}`;
    const untouched = `Bulk untouched ${suffix}`;
    for (const title of [first, second, untouched]) {
      await createTask(owner, workspaceId, noteId, { title });
    }

    await owner.goto(notePath(workspaceId, noteId));
    await expect(owner.getByRole("list", { name: "All tasks (3)" })).toBeVisible({
      timeout: ROUTE_COMPILE_MS,
    });

    await selectCheckbox(owner, first).click();
    await selectCheckbox(owner, second).click();
    await expect(owner.getByText("2 of 3 tasks selected")).toBeVisible();

    await owner
      .getByRole("toolbar", { name: "Bulk task actions" })
      .getByRole("button", { name: "Mark complete" })
      .click();
    // `updated` is what the batch actually changed; a task the caller may not
    // touch is reported as skipped rather than failing the whole request.
    await expect(owner.getByText("Mark complete: 2 of 2 tasks changed.")).toBeVisible();

    await owner.reload();
    await expect(completeCheckbox(owner, first)).toBeChecked({ timeout: ROUTE_COMPILE_MS });
    await expect(completeCheckbox(owner, second)).toBeChecked();
    await expect(completeCheckbox(owner, untouched)).not.toBeChecked();
  });

  test("spawns the next weekly occurrence when a recurring task is completed", async () => {
    const noteId = await createTaskListNote(owner, workspaceId, `Recurring note ${suffix}`);
    const title = `Recurring weekly ${suffix}`;
    const dueDate = new Date(Date.now() + 2 * DAY_MS).toISOString();
    const original = await createTask(owner, workspaceId, noteId, {
      title,
      dueDate,
      recurrence: "weekly",
    });

    await owner.goto(notePath(workspaceId, noteId));
    await expect(completeCheckbox(owner, title)).toBeVisible({ timeout: ROUTE_COMPILE_MS });
    await completeCheckbox(owner, title).click();

    // The occurrence is spawned synchronously inside the completing
    // transaction and returned as `spawned`, so the row appears without a
    // refetch and the live region says so.
    await expect(
      owner.getByText(`Completed ${title}. The next occurrence was added.`),
    ).toBeVisible();
    await expect(completeCheckbox(owner, title)).toHaveCount(2);
    await expect(owner.getByRole("list", { name: "All tasks (2)" })).toBeVisible();

    const listed = await listTasks(owner, workspaceId, noteId);
    expect(listed.items).toHaveLength(2);
    const kept = listed.items.find((task) => task.id === original.id)!;
    const spawned = listed.items.find((task) => task.id !== original.id)!;
    expect(kept.status).toBe("done");
    expect(kept.completedAt).not.toBeNull();
    expect(kept.dueDate).not.toBeNull();
    expect(spawned.title).toBe(title);
    expect(spawned.status).toBe("todo");
    expect(spawned.completedAt).toBeNull();
    expect(Date.parse(spawned.dueDate!) - Date.parse(kept.dueDate!)).toBe(7 * DAY_MS);
  });

  test("reports a stale reorder anchor as a conflict and reconciles to the winning order", async () => {
    // Two sessions, five mutations and a reload across two contexts.
    test.slow();
    const noteId = await createTaskListNote(owner, workspaceId, `Reorder note ${suffix}`);
    const alpha = `Reorder alpha ${suffix}`;
    const beta = `Reorder beta ${suffix}`;
    const gamma = `Reorder gamma ${suffix}`;
    for (const title of [alpha, beta, gamma]) {
      await createTask(owner, workspaceId, noteId, { title });
    }

    /*
     * The stale session loads FIRST and is then left untouched. The client
     * cache holds its page for 30s and never refetches on focus, so its
     * `beforeTaskId` anchors keep pointing at the order it was served — which
     * is precisely the concurrent-edit condition under test.
     */
    await ownerSecond.goto(notePath(workspaceId, noteId));
    await expect
      .poll(async () => taskTitles(ownerSecond), { timeout: ROUTE_COMPILE_MS })
      .toEqual([alpha, beta, gamma]);

    await owner.goto(notePath(workspaceId, noteId));
    await expect
      .poll(async () => taskTitles(owner), { timeout: ROUTE_COMPILE_MS })
      .toEqual([alpha, beta, gamma]);

    await owner.getByLabel(`Position for ${gamma}`).selectOption("1");
    await owner.getByRole("button", { name: `Move to position ${gamma}` }).click();
    await expect(owner.getByText(`Moved ${gamma} to position 1 of 3.`)).toBeVisible();
    // The status text is set BEFORE `reconcile()`, so the settled order arrives
    // only after a refetch — which on a cold worker waits behind route
    // compilation. `expect.poll`'s 5s default is shorter than that, so these
    // three polls get the same compile budget every other wait in this spec has.
    await expect
      .poll(async () => taskTitles(owner), { timeout: ROUTE_COMPILE_MS })
      .toEqual([gamma, alpha, beta]);

    await owner.getByRole("button", { name: `Delete ${beta}` }).click();
    await expect(owner.getByText(`Deleted ${beta}.`)).toBeVisible();
    await expect
      .poll(async () => taskTitles(owner), { timeout: ROUTE_COMPILE_MS })
      .toEqual([gamma, alpha]);

    /*
     * The stale session still shows [alpha, beta, gamma], so moving gamma to
     * position 2 resolves its anchor to beta — a row that no longer exists in
     * the group. The server answers 409 ORDER_CONFLICT rather than guessing a
     * placement, and the client rolls the order back untouched.
     */
    await ownerSecond.getByLabel(`Position for ${gamma}`).selectOption("2");
    await ownerSecond.getByRole("button", { name: `Move to position ${gamma}` }).click();
    await expect(
      ownerSecond.getByText(/The move conflicted with a recent change by someone else/u),
    ).toBeVisible();
    await expect
      .poll(async () => taskTitles(ownerSecond), { timeout: ROUTE_COMPILE_MS })
      .toEqual([alpha, beta, gamma]);

    // The message tells the reader to reload, and reloading is what reconciles:
    // the losing session then renders exactly the winning session's order.
    await ownerSecond.reload();
    await expect
      .poll(async () => taskTitles(ownerSecond), { timeout: ROUTE_COMPILE_MS })
      .toEqual([gamma, alpha]);
  });

  test("answers a task read addressed through another workspace with 404", async () => {
    const noteId = await createTaskListNote(owner, workspaceId, `Isolation note ${suffix}`);
    const task = await createTask(owner, workspaceId, noteId, { title: `Isolated ${suffix}` });

    /*
     * The caller is a full member of the workspace named in the path, so the
     * membership gate passes and only the tenant scope stands between them and
     * another workspace's task. 404 — never 403, which would confirm the task
     * exists somewhere.
     */
    const foreign = await other.request.get(
      `${apiUrl}/api/v1/workspaces/${otherWorkspaceId}/tasks/${task.id}`,
    );
    expect(foreign.status()).toBe(404);

    /*
     * The same concealment on the collection: scoping a list to a foreign note
     * is a `note.read` on a note this workspace does not contain, and it must
     * answer 404 rather than an empty page, which would still confirm that the
     * workspace was allowed to ask.
     */
    const search = new URLSearchParams({
      page: "1",
      limit: "100",
      noteId,
      grouping: "none",
      sortBy: "sortOrder",
      sortDirection: "asc",
    });
    const foreignList = await other.request.get(
      `${apiUrl}/api/v1/workspaces/${otherWorkspaceId}/tasks?${search.toString()}`,
    );
    expect(foreignList.status()).toBe(404);
  });
});
