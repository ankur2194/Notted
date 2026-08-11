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

interface ProjectRow {
  readonly id: string;
}
interface StatusRow {
  readonly id: string;
  readonly name: string;
}

function identity(role: string) {
  const suffix = randomUUID();
  return { name: `Board ${role}`, email: `board.${role}.${suffix}@example.test`, password };
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

async function createProject(page: Page, workspaceId: string, name: string): Promise<string> {
  const result = await apiPost<{ project: ProjectRow }>(
    page.request,
    `/api/v1/workspaces/${workspaceId}/projects`,
    { name, color: "#3b82f6", status: "active" },
    randomUUID(),
  );
  return result.project.id;
}

async function createProjectNote(
  page: Page,
  workspaceId: string,
  projectId: string,
  title: string,
): Promise<void> {
  await apiPost(
    page.request,
    `/api/v1/workspaces/${workspaceId}/notes`,
    { title, projectId, folderId: null, parentId: null },
    randomUUID(),
  );
}

/**
 * A task with no `dueDate` and no `completedAt`, so the timeline has no end to
 * draw to and must render it as a **marker** at its creation instant.
 *
 * It is deliberately NOT a "Not scheduled" record. Every record the timeline
 * receives — project, note and task alike — carries a `createdAt`, so with sound
 * data the unscheduled bucket is always empty; it exists to catch a date the
 * server could not produce, not an absent due date. The invariant worth proving
 * in a browser is therefore the pair below: the undated record is still drawn,
 * and no end was invented for it.
 */
async function createUndatedProjectTask(
  page: Page,
  workspaceId: string,
  projectId: string,
  title: string,
): Promise<void> {
  await apiPost(
    page.request,
    `/api/v1/workspaces/${workspaceId}/tasks`,
    { projectId, title },
    randomUUID(),
  );
}

/**
 * A board column, scoped to one project.
 *
 * `projectId` is a body field, not a query parameter — only the `GET` takes
 * `?projectId=`. The created name is returned so the assertions below read the
 * label the *server* stored rather than the one they asked for. Requires
 * `settings.update`, which the workspace creator holds as owner.
 */
async function createProjectColumn(
  page: Page,
  workspaceId: string,
  projectId: string,
  name: string,
): Promise<string> {
  const result = await apiPost<{ status: StatusRow }>(
    page.request,
    `/api/v1/workspaces/${workspaceId}/task-statuses`,
    { projectId, name, color: "#4f46e5" },
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

/**
 * A column heading, tolerant of the live card count it carries.
 *
 * Every label here is literal text — words, spaces and lowercase hex — so it
 * needs no escaping before it becomes a pattern.
 */
function columnName(label: string): RegExp {
  return new RegExp(`^${label}(?: \\(\\d+\\))?$`, "u");
}

/**
 * One board column's card list, addressed through the heading that labels it:
 * the `<ul>` is `aria-labelledby` its own `<h3>`, so membership and the column
 * it belongs to are one assertion.
 */
function columnList(page: Page, label: string) {
  return page.getByRole("main").getByRole("list", { name: columnName(label) });
}

function viewButton(page: Page, label: string) {
  return page.getByRole("group", { name: "Note view" }).getByRole("button", { name: label });
}

/**
 * Switch views and prove the switch happened.
 *
 * The click is retried as a unit with its own assertion because the switcher is
 * server-rendered: a click that lands before hydration attaches the handler is
 * silently dropped. Re-selecting the view already selected is a no-op, so the
 * retry cannot itself change anything — and neither can calling this after a
 * reload that restored the same view from the stored preference.
 */
async function selectView(page: Page, label: string): Promise<void> {
  await expect(async () => {
    await viewButton(page, label).click();
    await expect(viewButton(page, label)).toHaveAttribute("aria-pressed", "true", {
      timeout: 2_000,
    });
  }).toPass({ timeout: ROUTE_COMPILE_MS });
}

test.describe.serial("Part 49 project board and timeline", () => {
  test.skip(
    !disposable,
    "project board views require PLAYWRIGHT_DISPOSABLE_TEST_RUN=true and disposable PostgreSQL, Redis, and Mailpit",
  );

  const suffix = randomUUID().slice(0, 8);
  const workspaceName = `Board Alpha ${suffix}`;
  const projectName = `Board project ${suffix}`;
  const movingNote = `Board moving ${suffix}`;
  const stayingNote = `Board staying ${suffix}`;
  const thirdNote = `Board third ${suffix}`;
  const undatedTask = `Board undated ${suffix}`;

  let context: BrowserContext;
  let owner: Page;
  let workspaceId = "";
  let projectPath = "";
  let firstColumn = "";
  let secondColumn = "";

  test.beforeAll(async ({ browser }) => {
    // A verified account, a workspace, a project, two columns, three notes and a
    // task are more than one test budget covers, and both tests share all of it.
    test.setTimeout(180_000);
    context = await browser.newContext();
    owner = await context.newPage();
    await register(owner, identity("owner"));
    workspaceId = await createWorkspace(owner, workspaceName);
    const projectId = await createProject(owner, workspaceId, projectName);
    projectPath = `/workspaces/${workspaceId}/projects/${projectId}`;
    firstColumn = await createProjectColumn(owner, workspaceId, projectId, `Backlog ${suffix}`);
    secondColumn = await createProjectColumn(owner, workspaceId, projectId, `Shipping ${suffix}`);
    for (const title of [movingNote, stayingNote, thirdNote]) {
      await createProjectNote(owner, workspaceId, projectId, title);
    }
    await createUndatedProjectTask(owner, workspaceId, projectId, undatedTask);
  });

  test.afterAll(async () => {
    await deleteWorkspace(owner, workspaceId, workspaceName);
    await context.close();
  });

  test("moves a note to a project column by keyboard and persists it across a reload", async () => {
    await owner.goto(projectPath);
    await expect(owner.getByRole("heading", { level: 1, name: projectName })).toBeVisible({
      timeout: ROUTE_COMPILE_MS,
    });

    await selectView(owner, "Board");

    // The seeded columns exist only once the board's own status query resolves,
    // so their headings are the signal that the card selects can already offer
    // them. Every note starts with a null `board_column_id`, which is what the
    // leading "No column" bucket is for.
    for (const label of ["No column", firstColumn, secondColumn]) {
      await expect(owner.getByRole("heading", { level: 3, name: columnName(label) })).toBeVisible({
        timeout: ROUTE_COMPILE_MS,
      });
    }
    await expect(columnList(owner, "No column")).toContainText(movingNote);

    /*
     * The keyboard route between columns, not a pointer drag: the select plus
     * button is the WCAG 2.5.7 alternative, and it is the one a card can be
     * moved with by keyboard, speech or mouse alike. Real pointer drag stays
     * out of the browser suite by the precedent Part 48 set.
     */
    await owner.getByLabel(`Column for ${movingNote}`).selectOption({ label: secondColumn });
    await owner.getByRole("button", { name: `Move to column for ${movingNote}` }).click();

    // Membership is the settled signal, not a live-region message: the status
    // text is written before the move reconciles, so it can be replaced by the
    // refetch that follows it.
    await expect(columnList(owner, secondColumn)).toContainText(movingNote, {
      timeout: ROUTE_COMPILE_MS,
    });
    await expect(columnList(owner, "No column")).not.toContainText(movingNote);
    // The untouched notes stayed put, so the move was one card and not a
    // repartition of the whole board.
    await expect(columnList(owner, "No column")).toContainText(stayingNote);
    await expect(columnList(owner, "No column")).toContainText(thirdNote);

    /*
     * The load-bearing assertion. Everything above is satisfied by an optimistic
     * cache update alone; only a reload proves `board_column_id` round-tripped
     * through the server and came back on a fresh read.
     */
    await owner.reload();
    await expect(owner.getByRole("heading", { level: 1, name: projectName })).toBeVisible({
      timeout: ROUTE_COMPILE_MS,
    });
    await selectView(owner, "Board");
    await expect(columnList(owner, secondColumn)).toContainText(movingNote, {
      timeout: ROUTE_COMPILE_MS,
    });
    await expect(columnList(owner, "No column")).not.toContainText(movingNote);
  });

  test("draws an undated task as a marker and reports an empty Not scheduled bucket", async () => {
    // Navigating again rather than inheriting the previous test's view keeps
    // this test independent of what the one above left on screen.
    await owner.goto(projectPath);
    await expect(owner.getByRole("heading", { level: 1, name: projectName })).toBeVisible({
      timeout: ROUTE_COMPILE_MS,
    });
    await selectView(owner, "Timeline");

    // Nothing is dropped: the task with no due date and no completion still has
    // a row of its own on the chart.
    const markerRow = owner
      .getByRole("main")
      .getByRole("listitem")
      .filter({ hasText: `Task: ${undatedTask}` });
    await expect(markerRow).toHaveCount(1, { timeout: ROUTE_COMPILE_MS });
    // No end is invented: a marker states one instant, so the row carries no
    // " to " range. The seeded titles never contain that substring.
    await expect(markerRow).not.toContainText(" to ");

    // A note has both `createdAt` and `updatedAt`, so it is a real range.
    await expect(
      owner
        .getByRole("main")
        .getByRole("listitem")
        .filter({ hasText: `Note: ${movingNote}` }),
    ).toHaveCount(1);

    // The bucket still reports its size rather than disappearing, and with sound
    // server data that size is zero — see `createUndatedProjectTask`.
    await expect(owner.getByRole("heading", { name: "Not scheduled (0)" })).toBeVisible();
  });
});
