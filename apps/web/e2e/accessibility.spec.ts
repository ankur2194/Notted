import { randomUUID } from "node:crypto";

import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";

import {
  API_URL,
  APP_URL,
  createWorkspace,
  identity,
  inviteAndJoin,
  registerAndSignIn,
} from "./accounts";
import { scan } from "./axe";

/**
 * Part 76: the accessibility evidence that only a real browser can produce.
 *
 * The component suites already assert roles, labels and keyboard handlers on
 * rendered markup. What they cannot see is the *composed* page — the shell, the
 * route, the dialog and the editor stacked on top of each other, with real CSS
 * and a real focus ring — and that is exactly where AA conformance is won or
 * lost. So this spec scans assembled surfaces with axe, and then covers three
 * things axe structurally cannot check: whether the focus indicator survives
 * Windows High Contrast Mode, whether the tab order is the one a keyboard user
 * was promised, and whether the live regions on a page compete with each other.
 *
 * Provisioning is API-driven and happens once, in `beforeAll`, following
 * `collaboration.spec.ts` and `search.spec.ts`: an accessibility scan is about
 * the page, not about how the row underneath it was created, and re-registering
 * an account per surface would spend minutes proving `auth.spec.ts` again.
 */

const disposable = process.env.PLAYWRIGHT_DISPOSABLE_TEST_RUN === "true";

/** A cold Next.js dev route compiles on its first visit. */
const ROUTE_COMPILE_MS = 45_000;

/**
 * A genuine 64x32 PNG, committed as a constant.
 *
 * `note-images.spec.ts` builds its fixtures with a hand-written PNG encoder
 * because its assertions are about decoded pixels (`naturalWidth > 0`) across
 * several sizes. Nothing here needs that: the only question is whether an
 * `<img>` carrying real alt text reaches the DOM for axe's `image-alt` rule to
 * judge. It still has to be a *real* PNG — the Part 41 pipeline sniffs magic
 * bytes and re-encodes every variant, so a placeholder would be refused with
 * 415 before any of this ran.
 */
const FIGURE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAAAgCAIAAAAt/+nTAAAATklEQVR4nO3PUQkAIBTAwBfFXOY0oCH8OITBAtxm7fN1" +
    "wwUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjx2ASPXcIiRZ02JAAAAAElFTkSuQmCC",
  "base64",
);

const CELL_ATTRS = { colspan: 1, rowspan: 1, colwidth: null } as const;

const account = identity("A11y Owner");

/* -------------------------------------------------------------------------- */
/* Local helpers, per this repository's per-spec convention                     */
/* -------------------------------------------------------------------------- */

async function apiPost<T>(
  request: APIRequestContext,
  path: string,
  data: unknown,
  idempotencyKey: string,
): Promise<T> {
  const response = await request.post(`${API_URL}${path}`, {
    headers: { Origin: APP_URL, "Idempotency-Key": idempotencyKey },
    data,
  });
  expect(response.ok(), `POST ${path} → ${response.status()}`).toBe(true);
  return response.json() as Promise<T>;
}

async function apiGet<T>(request: APIRequestContext, path: string): Promise<T> {
  const response = await request.get(`${API_URL}${path}`, { headers: { Origin: APP_URL } });
  expect(response.ok(), `GET ${path} → ${response.status()}`).toBe(true);
  return response.json() as Promise<T>;
}

async function apiPatch(request: APIRequestContext, path: string, data: unknown): Promise<void> {
  const response = await request.patch(`${API_URL}${path}`, {
    headers: { Origin: APP_URL },
    data,
  });
  expect(response.ok(), `PATCH ${path} → ${response.status()}`).toBe(true);
}

/**
 * Signs the shared account in on a fresh `page`.
 *
 * Each `test` gets its own browser context, so the cookie `beforeAll` obtained
 * is not in this jar. Done through the API rather than the login form for the
 * same reason the provisioning is: `auth.spec.ts` owns the form.
 */
async function signIn(page: Page): Promise<void> {
  const response = await page.request.post(`${API_URL}/api/auth/sign-in/email`, {
    headers: { Origin: APP_URL },
    data: { email: account.email, password: account.password, rememberMe: false },
  });
  expect(response.ok(), `sign-in returned ${response.status()}`).toBe(true);
}

/**
 * Tabs until `target` holds focus, and returns how many presses that took.
 *
 * Real `Tab` presses rather than `locator.focus()`, because `:focus-visible` —
 * which is what paints every focus indicator in `styles/globals.css` — is a
 * heuristic about *how* focus arrived. Scripted focus on a button does not
 * reliably satisfy it, so a scripted-focus assertion about the ring would be
 * measuring the wrong state.
 *
 * Bounded, and throws rather than looping: the shell's sidebar contributes a
 * variable number of stops, so a fixed count would be brittle and an unbounded
 * walk would hang the run.
 */
async function tabUntilFocused(page: Page, target: Locator, limit = 150): Promise<number> {
  for (let presses = 1; presses <= limit; presses += 1) {
    await page.keyboard.press("Tab");
    if (await target.evaluate((element) => element === document.activeElement)) return presses;
  }
  throw new Error(`focus never reached the expected control within ${limit} Tab presses`);
}

/**
 * Asserts no polite live region contains another, on whatever page is loaded.
 *
 * NOT "exactly one region per page" — that premise is false here, and
 * deliberately so. `ToasterProvider` (sonner) mounts one in the root
 * layout for every page in the app, and `PageContainer` documents in its own
 * source why the note editor runs a second: layout announcements (zoom, margins,
 * focus mode) must not be able to overwrite "Couldn't save". `TaskListView` and
 * `MyTasksWidget` each say the same thing from the other direction — one region
 * per *concern*, so a reader hears one ordered narrative instead of competing
 * per-row chatter.
 *
 * Nesting is the defect that actually harms someone: a region inside a region
 * makes every announcement arrive twice, and no amount of careful per-component
 * design prevents it, because it only appears once the components are composed.
 */
async function expectIndependentLiveRegions(page: Page, surface: string): Promise<void> {
  const regions = page.locator('[aria-live="polite"]');
  // The root layout's Toaster guarantees at least one on every page, so a count
  // of zero means the page did not render, not that it is quiet.
  await expect(regions.first(), `${surface} rendered no polite live region at all`).toBeAttached();
  const nested = await regions.evaluateAll((elements) =>
    elements
      .filter((element) => elements.some((other) => other !== element && other.contains(element)))
      .map((element) => element.getAttribute("data-testid") ?? element.tagName.toLowerCase()),
  );
  expect(nested, `${surface} nests polite live regions, so announcements repeat`).toEqual([]);
}

test.describe.serial("Part 76 accessibility", () => {
  test.skip(
    !disposable,
    "accessibility scans require PLAYWRIGHT_DISPOSABLE_TEST_RUN=true and disposable PostgreSQL, Redis, Meilisearch and Mailpit",
  );

  // Distinctive enough that the search surface has exactly one real result and
  // cannot match a note left behind by another spec.
  const searchToken = `A11y${randomUUID().slice(0, 8)}`;
  const noteTitle = `${searchToken} conformance fixture`;
  // Deliberately shares no token with `searchToken`: the search test asserts a
  // SINGLE matching link inside `main`, and a mention fixture that also matched
  // the query would break it on strict mode rather than on a real defect.
  const workspaceName = `A11y ${randomUUID().slice(0, 8)}`;

  let workspaceId = "";
  let noteId = "";

  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext();
    const owner = await context.newPage();
    try {
      await registerAndSignIn(owner, account);
      workspaceId = await createWorkspace(owner, workspaceName);

      const created = await apiPost<{ note: { id: string; version: number } }>(
        owner.request,
        `/api/v1/workspaces/${workspaceId}/notes`,
        { title: noteTitle, projectId: null, folderId: null, parentId: null },
        randomUUID(),
      );
      noteId = created.note.id;

      // One endpoint serves images and generic files; it routes on sniffed
      // bytes, so the PNG lands in the image pipeline and the node below gets a
      // reference that really resolves to an `<img>`.
      const upload = await owner.request.post(
        `${API_URL}/api/v1/workspaces/${workspaceId}/notes/${noteId}/attachments`,
        {
          headers: { Origin: APP_URL, "Idempotency-Key": randomUUID() },
          multipart: {
            file: { name: "figure.png", mimeType: "image/png", buffer: FIGURE_PNG },
          },
        },
      );
      expect(upload.ok(), `image upload returned ${upload.status()}`).toBe(true);
      const attachmentId = ((await upload.json()) as { attachment: { id: string } }).attachment.id;

      /*
       * The three node families axe has real rules for and the shell has none
       * of: a table (header-cell association), an image (alt text), and a task
       * list (each checkbox needs its own accessible name). Every attribute the
       * shared document contract *requires* is spelled out — `colspan`,
       * `rowspan` and `colwidth` on each cell, `checked` on each task item,
       * `attachmentId`/`alt`/`width`/`height` on the image — because a document
       * the contract rejects fails the PATCH outright, and one it merely
       * migrates would quietly arrive as something other than what is written
       * here.
       */
      await apiPatch(owner.request, `/api/v1/workspaces/${workspaceId}/notes/${noteId}`, {
        expectedVersion: created.note.version,
        content: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: `${searchToken} accessibility fixture body.` }],
            },
            {
              type: "table",
              content: [
                {
                  type: "tableRow",
                  content: [
                    {
                      type: "tableHeader",
                      attrs: CELL_ATTRS,
                      content: [
                        { type: "paragraph", content: [{ type: "text", text: "Surface" }] },
                      ],
                    },
                    {
                      type: "tableHeader",
                      attrs: CELL_ATTRS,
                      content: [{ type: "paragraph", content: [{ type: "text", text: "Owner" }] }],
                    },
                  ],
                },
                {
                  type: "tableRow",
                  content: [
                    {
                      type: "tableCell",
                      attrs: CELL_ATTRS,
                      content: [{ type: "paragraph", content: [{ type: "text", text: "Editor" }] }],
                    },
                    {
                      type: "tableCell",
                      attrs: CELL_ATTRS,
                      content: [{ type: "paragraph", content: [{ type: "text", text: "Notted" }] }],
                    },
                  ],
                },
              ],
            },
            {
              type: "image",
              attrs: {
                attachmentId,
                alt: "A solid blue rectangle standing in for a figure",
                width: 64,
                height: 32,
              },
            },
            {
              type: "taskList",
              content: [
                {
                  type: "taskItem",
                  attrs: { checked: false },
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "Confirm the table header association" }],
                    },
                  ],
                },
                {
                  type: "taskItem",
                  attrs: { checked: true },
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "Confirm the figure carries alt text" }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      });
    } finally {
      await context.close();
    }
  });

  /* ---------------------------------------------------------------- surfaces */

  test("scans the unauthenticated sign-in route", async ({ page }) => {
    // Deliberately signed out: this is the only page most people will ever see
    // before they have an account, and it is the one surface where an
    // authenticated shell cannot mask a defect.
    await page.goto("/login");
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible({
      timeout: ROUTE_COMPILE_MS,
    });
    await scan(page, { surface: "/login" });
  });

  test("scans the dashboard shell", async ({ page }) => {
    await signIn(page);
    await page.goto(`/workspaces/${workspaceId}`);
    await expect(page.getByRole("main")).toBeVisible({ timeout: ROUTE_COMPILE_MS });
    await scan(page, { surface: "dashboard shell" });
  });

  test("scans the note editor with a table, a figure and a task list", async ({ page }) => {
    await signIn(page);
    await page.goto(`/workspaces/${workspaceId}/notes/${noteId}`);
    // The editable ProseMirror surface, not the save indicator: the content was
    // seeded through the API, so nothing here is waiting on a save at all.
    await expect(page.getByRole("textbox", { name: /Note content/u })).toBeVisible({
      timeout: ROUTE_COMPILE_MS,
    });
    await scan(page, { surface: "note editor" });
  });

  test("scans the task board", async ({ page }) => {
    await signIn(page);
    await page.goto(`/workspaces/${workspaceId}/tasks`);
    await expect(page.getByRole("heading", { level: 1, name: "Tasks" })).toBeVisible({
      timeout: ROUTE_COMPILE_MS,
    });
    // The board rather than the list: the list is rows, while the board is the
    // drag surface, and a drag interaction is the one that has to justify a
    // keyboard route (WCAG 2.2 SC 2.5.7) to be usable at all.
    // `exact`: the board's own "Manage board columns" trigger also contains the
    // word "board", and Playwright's accessible-name match is a case-insensitive
    // SUBSTRING, so the loose locator resolves to two elements once the board is
    // on screen and fails strict mode after the click has already worked.
    const board = page.getByRole("button", { name: "Board", exact: true });
    await board.click();
    await expect(board).toHaveAttribute("aria-pressed", "true");
    // The four built-in columns always render, empty or not, so their headings
    // are a reliable signal that the board itself is on screen.
    await expect(page.getByRole("heading", { level: 3, name: /^To do \(\d+\)$/u })).toBeVisible();
    await scan(page, { surface: "task board" });
  });

  test("scans the search results route", async ({ page }) => {
    await signIn(page);
    /*
     * The Meilisearch index (Part 51) is populated asynchronously through
     * BullMQ, so the note is not searchable the instant its PATCH returns.
     * Poll the suggestions endpoint on a bounded timeout — never an unbounded
     * wait, and never a silent skip — exactly as `search.spec.ts` does.
     */
    const suggestions = `${API_URL}/api/v1/workspaces/${workspaceId}/search/suggestions?query=${encodeURIComponent(searchToken)}&limit=8`;
    await expect
      .poll(
        async () => {
          const response = await page.request.get(suggestions, { headers: { Origin: APP_URL } });
          if (!response.ok()) return false;
          const body = (await response.json()) as readonly { readonly title: string }[];
          return body.some((item) => item.title === noteTitle);
        },
        { timeout: 30_000, intervals: [500, 1_000, 2_000] },
      )
      .toBe(true);

    await page.goto(`/workspaces/${workspaceId}/search?query=${encodeURIComponent(searchToken)}`);
    // Scoped to main: the sidebar note tree carries a link with the same title,
    // and the result list is the thing being scanned.
    await expect(
      page.getByRole("main").getByRole("link", { name: new RegExp(searchToken, "u") }),
    ).toBeVisible({ timeout: ROUTE_COMPILE_MS });
    await scan(page, { surface: "search results" });
  });

  test("scans an open dialog", async ({ page }) => {
    await signIn(page);
    await page.goto(`/workspaces/${workspaceId}/notes`);
    const trigger = page.getByRole("button", { name: "Create note" });
    await expect(trigger).toBeVisible({ timeout: ROUTE_COMPILE_MS });
    await trigger.click();
    await expect(page.getByRole("dialog", { name: "Create note" })).toBeVisible();
    // Scoped to the dialog: the page behind it is inert while a modal is open,
    // and it already has its own scan above. A finding here is a finding about
    // the thing the user can actually reach.
    await scan(page, { surface: "create-note dialog", include: '[role="dialog"]' });
  });

  /* ----------------------------------------------- what axe structurally cannot do */

  test("paints a real focus outline under forced colours", async ({ page }, testInfo) => {
    test.skip(
      testInfo.project.name !== "chromium",
      "forced-colors emulation is only exercised on the Chromium project this suite runs",
    );
    await signIn(page);
    await page.emulateMedia({ forcedColors: "active" });
    try {
      await page.goto(`/workspaces/${workspaceId}`);
      await expect(page.getByRole("main")).toBeVisible({ timeout: ROUTE_COMPILE_MS });

      const trigger = page.getByRole("button", { name: "Open command menu and search" });
      await expect(trigger).toBeVisible();
      await tabUntilFocused(page, trigger);

      /*
       * `outline`, not "some visible ring".
       *
       * Tailwind's `ring-*` compiles to a `box-shadow`, and Windows High
       * Contrast Mode discards `box-shadow` outright — while `outline-none`
       * has already removed the UA default that would otherwise have covered
       * for it. The result is a keyboard user with no visible focus anywhere:
       * WCAG 2.2 SC 2.4.7 (Focus Visible). `styles/globals.css` closes that
       * with a `@media (forced-colors: active)` rule painting a real
       * `outline: 2px solid Highlight`, and this assertion is what proves the
       * rule actually wins the cascade on a real control — which is why it
       * reads the computed outline rather than comparing pixels.
       */
      const focused = await page.evaluate(() => {
        const element = document.activeElement;
        if (element === null) return null;
        const style = getComputedStyle(element);
        return {
          description: `${element.tagName.toLowerCase()}.${element.getAttribute("class") ?? ""}`,
          outlineStyle: style.outlineStyle,
          outlineWidth: style.outlineWidth,
        };
      });
      expect(focused, "nothing held focus after tabbing to the search trigger").not.toBeNull();
      expect(
        focused?.outlineStyle,
        `forced colours left ${focused?.description} with no outline style, so its focus ring is invisible`,
      ).not.toBe("none");
      expect(
        Number.parseFloat(focused?.outlineWidth ?? "0"),
        `forced colours left ${focused?.description} with a sub-pixel outline`,
      ).toBeGreaterThanOrEqual(1);
    } finally {
      await page.emulateMedia({ forcedColors: null });
    }
  });

  test("orders focus predictably and returns it when a dialog closes", async ({ page }) => {
    await signIn(page);
    await page.goto(`/workspaces/${workspaceId}`);
    await expect(page.getByRole("main")).toBeVisible({ timeout: ROUTE_COMPILE_MS });

    /*
     * Two skip links, in this order, because two layouts each own one: the root
     * layout jumps to `#main-content` for every page in the app, and
     * `DashboardShell` adds a jump to `#workspace-navigation` for the shell's
     * sidebar. Both have to be reachable before anything else, or the sidebar's
     * long link list stands between a keyboard user and the page they asked for.
     */
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Skip to main content" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Skip to workspace navigation" })).toBeFocused();

    /*
     * Deliberately not an exhaustive tab list. The sidebar's note tree, folder
     * list and tag list each contribute a variable number of stops, so an
     * enumerated sequence would fail on content rather than on a regression.
     * What matters is that focus reaches the top bar's controls at all, and
     * reaches them in reading order.
     */
    const search = page.getByRole("button", { name: "Open command menu and search" });
    const userMenu = page.getByRole("button", { name: "Open user menu" });
    await tabUntilFocused(page, search);
    const toUserMenu = await tabUntilFocused(page, userMenu);
    // Continuing from the search trigger, so a small number proves the user menu
    // follows it. A wrap all the way around the document would be far larger.
    expect(
      toUserMenu,
      "the user menu is not a few stops after the search trigger in the top bar",
    ).toBeLessThanOrEqual(5);

    // Opened from its trigger, because the assertion is about what focus goes
    // back to — which a scripted `open` would never exercise.
    await page.goto(`/workspaces/${workspaceId}/notes`);
    const trigger = page.getByRole("button", { name: "Create note" });
    await expect(trigger).toBeVisible({ timeout: ROUTE_COMPILE_MS });
    await trigger.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Create note" });
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(trigger, "closing the dialog stranded focus away from its trigger").toBeFocused();
  });

  test("keeps polite live regions from competing on each shell surface", async ({ page }) => {
    await signIn(page);

    await page.goto(`/workspaces/${workspaceId}`);
    await expect(page.getByRole("main")).toBeVisible({ timeout: ROUTE_COMPILE_MS });
    await expectIndependentLiveRegions(page, "dashboard shell");

    await page.goto(`/workspaces/${workspaceId}/notes/${noteId}`);
    await expect(page.getByRole("textbox", { name: /Note content/u })).toBeVisible({
      timeout: ROUTE_COMPILE_MS,
    });
    await expectIndependentLiveRegions(page, "note editor");

    await page.goto(`/workspaces/${workspaceId}/tasks`);
    await expect(page.getByRole("heading", { level: 1, name: "Tasks" })).toBeVisible({
      timeout: ROUTE_COMPILE_MS,
    });
    await expectIndependentLiveRegions(page, "tasks");
    /*
     * `toHaveCount(1)`, not "at most one", and only inside `main`.
     *
     * `TaskListView` is the sole content of this route and its source states the
     * guarantee outright: one region for the whole list, so every optimistic
     * result, failure and rollback arrives as one ordered narrative. That is a
     * promise worth pinning — a second region added inside `main` would split
     * the narrative and this fails. It is scoped to `main` because the root
     * layout's Toaster sits outside it and belongs to every page, not this one.
     */
    await expect(page.getByRole("main").locator('[aria-live="polite"]')).toHaveCount(1);
  });

  /* ------------------------------------------------------------------------ */
  /* Ported from `dashboard-shell.spec.ts`, which has never executed once       */
  /*                                                                            */
  /* That file gates on `PLAYWRIGHT_SHELL_EMAIL` / `PLAYWRIGHT_SHELL_PASSWORD`, */
  /* which nothing in the repository sets, and the seed writes no Better Auth   */
  /* credential account, so the gate cannot be satisfied even by supplying the  */
  /* variables. Six of its assertions had no equivalent anywhere in the suite;  */
  /* they live here now because this spec provisions itself and therefore runs. */
  /* The original file is deliberately left in place — see the Part 76 record.  */
  /* ------------------------------------------------------------------------ */

  for (const viewport of [
    { name: "phone", width: 390, height: 844 },
    { name: "tablet", width: 820, height: 1180 },
    { name: "desktop", width: 1440, height: 900 },
  ]) {
    test(`reflows at ${viewport.name} with a breadcrumb landmark and reachable navigation`, async ({
      page,
    }) => {
      await signIn(page);
      await page.setViewportSize(viewport);
      await page.goto(`/workspaces/${workspaceId}`);
      await expect(page.getByRole("main")).toBeVisible({ timeout: ROUTE_COMPILE_MS });
      /*
       * The breadcrumb is the shell's only "where am I" affordance for a screen
       * reader, and it is a landmark rather than a list precisely so it can be
       * jumped to. It renders at every width — nothing may reflow it away.
       *
       * `exact`, and measured: the workspace overview route contributes its own
       * `<nav aria-label="Workspace breadcrumb">` inside `main`, and Playwright's
       * accessible-name match is a case-insensitive SUBSTRING, so the loose
       * locator resolves to two landmarks and fails strict mode. The shell's is
       * the one this assertion is about.
       */
      await expect(page.getByRole("navigation", { name: "Breadcrumb", exact: true })).toBeVisible();
      await page.keyboard.press("Tab");
      await expect(page.getByRole("link", { name: "Skip to main content" })).toBeFocused();

      if (viewport.width < 768) {
        /*
         * Below the `md` breakpoint the sidebar is `hidden` and the only route
         * to workspace navigation is this dialog. The assertion that matters is
         * the LAST one: `DashboardShell` overrides `onCloseAutoFocus` to put
         * focus back on the trigger, and without it a keyboard user who opens
         * and dismisses the panel is returned to `<body>` — WCAG 2.2 SC 2.4.3.
         */
        const trigger = page.getByRole("button", { name: "Open navigation" });
        await trigger.focus();
        await page.keyboard.press("Enter");
        await expect(page.getByRole("dialog", { name: "Workspace navigation" })).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(
          trigger,
          "dismissing the mobile navigation dialog stranded focus away from its trigger",
        ).toBeFocused();
      }

      // SC 1.4.10 Reflow: the page itself must never become a horizontal
      // scroller. Individual wide regions may scroll — that is what the task
      // board's labelled `role="region"` strip is for — but `body` may not.
      await expect(page.locator("body")).not.toHaveCSS("overflow-x", "scroll");
    });
  }

  test("exposes the user menu as a real menu with menu items", async ({ page }) => {
    await signIn(page);
    await page.goto(`/workspaces/${workspaceId}`);
    const trigger = page.getByRole("button", { name: "Open user menu" });
    await expect(trigger).toBeVisible({ timeout: ROUTE_COMPILE_MS });
    await expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    await trigger.click();
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    // The repository's only `menuitem` assertion. `TopBar` builds this popup by
    // hand rather than from a Shadcn primitive, so nothing else proves the
    // promise its `aria-haspopup="menu"` makes is kept by what opens.
    await expect(page.getByRole("menu")).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Security settings" })).toBeVisible();
  });

  test("surfaces a notification failure as an alert with a retry and no payload leak", async ({
    page,
  }) => {
    await signIn(page);
    await page.goto(`/workspaces/${workspaceId}`);
    await expect(page.getByRole("main")).toBeVisible({ timeout: ROUTE_COMPILE_MS });

    // Routed AFTER the page is loaded so only the panel's own read fails; the
    // shell bootstrap that renders the badge is a server-side read anyway.
    await page.route("**/api/v1/workspaces/*/notifications?*", (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: { message: "upstream-detail-that-must-not-render" } }),
      }),
    );

    await page.getByRole("button", { name: /^Notifications/u }).click();
    const dialog = page.getByRole("dialog", { name: "Notifications" });
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByRole("alert").filter({ hasText: "could not be loaded" }),
    ).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Retry" })).toBeVisible();
    // The failure envelope is a server string; it must never reach the reader.
    await expect(dialog).not.toContainText("upstream-detail-that-must-not-render");
  });

  test("persists notification read state across a reload and clears the badge on mark-all", async ({
    page,
    browser,
  }) => {
    /*
     * The heaviest test in this spec, and last on purpose: it provisions a
     * second identity, joins it to the workspace, and waits on the BullMQ
     * mention pipeline. `describe.serial` skips what follows a failure, so this
     * sits behind the nine scans rather than in front of them.
     */
    test.setTimeout(240_000);

    // TWO mentions, not one. With a single notification, marking it read
    // already empties the badge, and the "Mark all read" assertion below would
    // pass against a control that did nothing.
    const mentioner = identity("A11y Mentioner");
    const mentionContext = await browser.newContext();
    const mentionPage = await mentionContext.newPage();
    try {
      await signIn(page);
      await registerAndSignIn(mentionPage, mentioner);
      await inviteAndJoin(page, mentionPage, workspaceId, workspaceName, mentioner, "editor");

      const members = await apiGet<{
        readonly items: readonly { readonly userId: string; readonly email: string }[];
      }>(page.request, `/api/v1/workspaces/${workspaceId}/members?page=1&limit=50`);
      const ownerId = members.items.find((row) => row.email === account.email)?.userId;
      expect(ownerId, "the owner is not listed among its own workspace members").toBeDefined();

      /*
       * A mention in a NEW note each time, never in the scanned fixture note.
       * The producer's idempotency key is `sha256(workspace, note, recipient)`,
       * so two mentions in one note collapse to a single notification; and
       * rewriting the fixture note would destroy the table, figure and task
       * list the axe scans above depend on.
       */
      for (const suffix of ["one", "two"]) {
        const created = await apiPost<{ note: { id: string; version: number } }>(
          mentionPage.request,
          `/api/v1/workspaces/${workspaceId}/notes`,
          {
            title: `Mention fixture ${suffix} ${randomUUID().slice(0, 8)}`,
            projectId: null,
            folderId: null,
            parentId: null,
          },
          randomUUID(),
        );
        await apiPatch(
          mentionPage.request,
          `/api/v1/workspaces/${workspaceId}/notes/${created.note.id}`,
          {
            expectedVersion: created.note.version,
            content: {
              type: "doc",
              content: [
                {
                  type: "paragraph",
                  content: [
                    { type: "text", text: "Please review " },
                    { type: "mention", attrs: { id: ownerId, label: account.name } },
                  ],
                },
              ],
            },
          },
        );
      }
    } finally {
      await mentionContext.close();
    }

    // Delivery is asynchronous through BullMQ, so this is a bounded poll — not
    // an unbounded wait and not a silent skip.
    await expect
      .poll(
        async () => {
          const response = await page.request.get(
            `${API_URL}/api/v1/workspaces/${workspaceId}/notifications?page=1&limit=20`,
            { headers: { Origin: APP_URL } },
          );
          if (!response.ok()) return -1;
          const body = (await response.json()) as { readonly unreadCount: number };
          return body.unreadCount;
        },
        { timeout: 90_000, intervals: [1_000, 2_000, 3_000] },
      )
      .toBe(2);

    await page.goto(`/workspaces/${workspaceId}`);
    // The unread count is server-rendered, so the badge proves both arrived
    // unread rather than merely being listed.
    await expect(page.getByRole("button", { name: "Notifications, 2 unread" })).toBeVisible({
      timeout: ROUTE_COMPILE_MS,
    });
    await page.getByRole("button", { name: "Notifications, 2 unread" }).click();

    const dialog = page.getByRole("dialog", { name: "Notifications" });
    await expect(dialog).toBeVisible();
    const firstUnread = dialog.getByRole("button", { name: /^Mark read:/u }).first();
    await expect(firstUnread).toBeVisible();
    const firstNotified = (await firstUnread.getAttribute("aria-label")) ?? "";
    expect(firstNotified, "a notification row carried no accessible label").not.toBe("");
    await firstUnread.click();
    await page.keyboard.press("Escape");

    /*
     * Away, back, and a full reload. Read state is a server fact — the panel
     * re-reads page 1 on every open — so anything that survives this round trip
     * was persisted rather than remembered in React state.
     */
    await page.goto("/settings/security");
    await page.goto(`/workspaces/${workspaceId}`);
    await page.reload();
    await page.getByRole("button", { name: "Notifications, 1 unread" }).click();
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByRole("button", {
        name: firstNotified.replace("Mark read:", "Mark unread:"),
        exact: true,
      }),
      "the row marked read came back unread after a reload",
    ).toBeVisible();

    await dialog.getByRole("button", { name: "Mark all read" }).click();
    await page.keyboard.press("Escape");
    // `exact`, because the loose name is a SUBSTRING match that "Notifications,
    // 1 unread" would satisfy — which is how this assertion passes vacuously.
    await expect(page.getByRole("button", { name: "Notifications", exact: true })).toBeVisible();
  });
});
