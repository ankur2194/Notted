import { randomUUID } from "node:crypto";

import {
  expect,
  test,
  type APIRequestContext,
  type BrowserContext,
  type Locator,
  type Page,
} from "@playwright/test";

import { latestActionLink } from "./mailpit";

const disposable = process.env.PLAYWRIGHT_DISPOSABLE_TEST_RUN === "true";
const apiUrl = process.env.PLAYWRIGHT_API_URL ?? "http://localhost:3001";
const appUrl = process.env.PLAYWRIGHT_APP_URL ?? "http://localhost:3000";
const password = "Fresh1!Password";

/** A cold Next.js dev route compiles on its first visit. */
const ROUTE_COMPILE_MS = 45_000;

/** UTC+14 all year, so the offset below is a constant rather than a season. */
const FAR_EAST_ZONE = "Pacific/Kiritimati";

interface NoteRow {
  readonly id: string;
}
interface StatusRow {
  readonly id: string;
  readonly name: string;
}

function identity(role: string) {
  const suffix = randomUUID();
  return { name: `Views ${role}`, email: `views.${role}.${suffix}@example.test`, password };
}

type Account = ReturnType<typeof identity>;

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
}

async function createTask(
  page: Page,
  workspaceId: string,
  noteId: string,
  seed: TaskSeed,
): Promise<void> {
  await apiPost(
    page.request,
    `/api/v1/workspaces/${workspaceId}/tasks`,
    { noteId, ...seed },
    randomUUID(),
  );
}

/**
 * A workspace-wide board column. `projectId: null` is what makes it usable by
 * every task, and the created name is returned so the board assertions below
 * read the label the *server* stored rather than the one they asked for.
 */
async function createTaskStatus(page: Page, workspaceId: string, name: string): Promise<string> {
  const result = await apiPost<{ status: StatusRow }>(
    page.request,
    `/api/v1/workspaces/${workspaceId}/task-statuses`,
    { projectId: null, name, color: "#4f46e5" },
    randomUUID(),
  );
  return result.status.name;
}

async function deleteWorkspace(page: Page, workspaceId: string, name: string): Promise<void> {
  if (workspaceId === "") return;
  await page.request
    .delete(`${apiUrl}/api/v1/workspaces/${workspaceId}`, {
      headers: { Origin: appUrl },
      data: { confirm: true, expectedName: name },
    })
    .catch(() => undefined);
}

/** The local `YYYY-MM-DD` of an instant in `zone`, derived, never hardcoded. */
function dayKeyInZone(at: Date, zone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

function zoneDayParts(at: Date, zone: string): { year: number; month: number; day: number } {
  const [year, month, day] = dayKeyInZone(at, zone).split("-").map(Number);
  return { year: year!, month: month!, day: day! };
}

/**
 * The day the calendar assertions target: the 15th of the month the grid opens
 * on, or the 16th when the 15th happens to be today.
 *
 * Both exclusions are about the cell's own text, which is how `dayCell` finds
 * it: today's cell appends "(Today)" and a cell belonging to a neighbouring
 * month appends an sr-only marker, so either one stops the day number from
 * being the paragraph's whole text. Mid-month is also always inside the grid.
 */
function midMonthDay(today: number): number {
  return today === 15 ? 16 : 15;
}

/**
 * One calendar day cell, addressed by the only text the grid gives a day.
 *
 * The outer `<li>` carries the day number in a paragraph of its own; the task
 * `<li>`s nested inside it never do, so an exact-text filter can only resolve
 * to the cell. Day numbers repeat across the 42-cell grid, but every repeat is
 * an out-of-month cell whose paragraph carries the extra marker above.
 */
function dayCell(page: Page, dayKey: string): Locator {
  const day = String(Number(dayKey.slice(8)));
  return page
    .getByRole("main")
    .getByRole("listitem")
    .filter({ has: page.getByText(day, { exact: true }) });
}

/** A task row in the list view, addressed by the control unique to it. */
function taskRow(page: Page, title: string): Locator {
  return page
    .getByRole("main")
    .getByRole("listitem")
    .filter({ has: page.getByRole("checkbox", { name: `Complete ${title}`, exact: true }) });
}

function viewButton(page: Page, label: string): Locator {
  return page.getByRole("group", { name: "Task view" }).getByRole("button", { name: label });
}

/**
 * Switch views and prove the switch happened.
 *
 * The click is retried as a unit with its own assertion because the switcher is
 * server-rendered: a click that lands before hydration attaches the handler is
 * silently dropped. Re-selecting the view already selected is a no-op, so the
 * retry cannot itself change anything.
 */
async function selectView(page: Page, label: string): Promise<void> {
  await expect(async () => {
    await viewButton(page, label).click();
    await expect(viewButton(page, label)).toHaveAttribute("aria-pressed", "true", {
      timeout: 2_000,
    });
  }).toPass({ timeout: ROUTE_COMPILE_MS });
}

test.describe.serial("Part 48 task views over one shared state", () => {
  test.skip(
    !disposable,
    "task views require PLAYWRIGHT_DISPOSABLE_TEST_RUN=true and disposable PostgreSQL, Redis, and Mailpit",
  );

  const suffix = randomUUID().slice(0, 8);
  const workspaceName = `Views Alpha ${suffix}`;
  const movingTask = `Views moving ${suffix}`;
  const undatedTask = `Views undated ${suffix}`;

  /*
   * UTC, pinned on the context rather than through `test.use`: that option
   * reaches the `page` fixture only, and these two tests share one signed-in
   * session, which a per-test fixture cannot give. Pinning it at all is what
   * lets this block compute an expected day key in Node and trust the browser
   * to agree.
   */
  const nowUtc = new Date();
  const utcDay = midMonthDay(nowUtc.getUTCDate());
  const dueAt = new Date(Date.UTC(nowUtc.getUTCFullYear(), nowUtc.getUTCMonth(), utcDay, 12));
  const dueIso = dueAt.toISOString();
  const dueDayKey = dayKeyInZone(dueAt, "UTC");

  let context: BrowserContext;
  let owner: Page;
  let workspaceId = "";
  let columnLabel = "";
  let tasksPath = "";

  test.beforeAll(async ({ browser }) => {
    // A verified account, a workspace, a note and three seeded rows are more
    // than one test budget covers, and both tests below share all of it.
    test.setTimeout(180_000);
    context = await browser.newContext({ timezoneId: "UTC" });
    owner = await context.newPage();
    await register(owner, identity("owner"));
    workspaceId = await createWorkspace(owner, workspaceName);
    tasksPath = `/workspaces/${workspaceId}/tasks`;
    const noteId = await createTaskListNote(owner, workspaceId, `Views note ${suffix}`);
    await createTask(owner, workspaceId, noteId, { title: movingTask, dueDate: dueIso });
    await createTask(owner, workspaceId, noteId, { title: undatedTask });
    columnLabel = await createTaskStatus(owner, workspaceId, `Review ${suffix}`);
  });

  test.afterAll(async () => {
    await deleteWorkspace(owner, workspaceId, workspaceName);
    await context.close();
  });

  test("moves a card to a custom column and shows the move in the list view", async () => {
    await owner.goto(tasksPath);
    await expect(owner.getByRole("list", { name: "All tasks (2)" })).toBeVisible({
      timeout: ROUTE_COMPILE_MS,
    });

    await selectView(owner, "Board");
    // The seeded column exists only once the board's own status query resolves,
    // so its empty heading is the signal that the selector can already offer it.
    const emptyColumn = owner.getByRole("heading", { level: 3, name: `${columnLabel} (0)` });
    await expect(emptyColumn).toBeVisible({ timeout: ROUTE_COMPILE_MS });
    // Two tasks are not a truncated page, so the notice that would say so is
    // absent. Proving the other half of that branch would need a hundred rows.
    await expect(owner.getByRole("note").filter({ hasText: "truncated" })).toHaveCount(0);

    /*
     * The keyboard route between columns, not a pointer drag: the select plus
     * button is the WCAG 2.5.7 alternative, and it is the one a card can be
     * moved with by keyboard, speech or mouse alike.
     */
    await owner.getByLabel(`Column for ${movingTask}`).selectOption({ label: columnLabel });
    await owner.getByRole("button", { name: `Move to column for ${movingTask}` }).click();
    await expect(owner.getByText(`Updated ${movingTask}.`)).toBeVisible({
      timeout: ROUTE_COMPILE_MS,
    });

    // Each column list is labelled by its own heading, so asserting membership
    // asserts both counts at the same time.
    await expect(
      owner.getByRole("list", { name: `${columnLabel} (1)` }).getByRole("checkbox", {
        name: `Complete ${movingTask}`,
        exact: true,
      }),
    ).toBeVisible();
    await expect(owner.getByRole("list", { name: "To do (1)" })).toBeVisible();

    // The same state, read through a different view: all three render one
    // shared page, so the board's mutation has to be visible here untouched.
    await selectView(owner, "List");
    await expect(taskRow(owner, movingTask)).toContainText(`Status: ${columnLabel}`);

    // And it was a real write, not a client-side repartition.
    await owner.reload();
    await expect(taskRow(owner, movingTask)).toContainText(`Status: ${columnLabel}`, {
      timeout: ROUTE_COMPILE_MS,
    });
  });

  test("puts the dated task in its day cell and the undated one under No due date", async () => {
    // Navigating again rather than inheriting the previous test's view keeps
    // this test independent of what the one above left on screen.
    await owner.goto(tasksPath);
    await expect(owner.getByRole("list", { name: "All tasks (2)" })).toBeVisible({
      timeout: ROUTE_COMPILE_MS,
    });
    await selectView(owner, "Calendar");

    const cell = dayCell(owner, dueDayKey);
    await expect(cell).toHaveCount(1);
    await expect(cell).toContainText(movingTask);

    await expect(owner.getByRole("list", { name: "No due date (1)" })).toContainText(undatedTask);
    /*
     * One list item in the whole view, which is the "rather than in a cell"
     * half of the claim: a grid cell would carry the title in its own card
     * item and in the enclosing day cell, taking this count to three.
     */
    await expect(
      owner.getByRole("main").getByRole("listitem").filter({ hasText: undatedTask }),
    ).toHaveCount(1);
  });
});

test.describe("Part 48 due dates in a UTC+14 viewer's zone", () => {
  test.skip(
    !disposable,
    "task views require PLAYWRIGHT_DISPOSABLE_TEST_RUN=true and disposable PostgreSQL, Redis, and Mailpit",
  );
  test.use({ timezoneId: FAR_EAST_ZONE });

  const suffix = randomUUID().slice(0, 8);
  const workspaceName = `Views Far East ${suffix}`;
  const taskTitle = `Views far east ${suffix}`;

  const localNow = zoneDayParts(new Date(), FAR_EAST_ZONE);
  const localDay = midMonthDay(localNow.day);
  /*
   * 22:00 UTC on the day *before* the target: at UTC+14 that instant is already
   * 12:00 on the target day for the viewer. One instant, two calendar days —
   * exactly the case a UTC-formatted calendar would place in the wrong cell.
   */
  const dueAt = new Date(Date.UTC(localNow.year, localNow.month - 1, localDay - 1, 22));
  const dueIso = dueAt.toISOString();
  const dueDayKey = dayKeyInZone(dueAt, FAR_EAST_ZONE);

  let workspaceId = "";

  test.afterEach(async ({ page }) => {
    await deleteWorkspace(page, workspaceId, workspaceName);
  });

  test("renders a late-UTC instant on the following local day", async ({ page }) => {
    test.setTimeout(180_000);
    // The premise, asserted rather than assumed: if these ever agreed, the
    // journey below would pass without testing anything about time zones.
    expect(dueDayKey).not.toBe(dayKeyInZone(dueAt, "UTC"));

    await register(page, identity("far-east"));
    workspaceId = await createWorkspace(page, workspaceName);
    const noteId = await createTaskListNote(page, workspaceId, `Far east note ${suffix}`);
    await createTask(page, workspaceId, noteId, { title: taskTitle, dueDate: dueIso });

    await page.goto(`/workspaces/${workspaceId}/tasks`);
    await expect(page.getByRole("list", { name: "All tasks (1)" })).toBeVisible({
      timeout: ROUTE_COMPILE_MS,
    });
    await selectView(page, "Calendar");

    const cell = dayCell(page, dueDayKey);
    await expect(cell).toHaveCount(1);
    await expect(cell).toContainText(taskTitle);
  });
});
