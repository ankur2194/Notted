import { randomUUID } from "node:crypto";

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import { latestActionLink } from "./mailpit";

const disposable = process.env.PLAYWRIGHT_DISPOSABLE_TEST_RUN === "true";
const apiUrl = process.env.PLAYWRIGHT_API_URL ?? "http://localhost:3001";
const appUrl = process.env.PLAYWRIGHT_APP_URL ?? "http://localhost:3000";
const password = "Fresh1!Password";

function identity(role: string) {
  const suffix = randomUUID();
  return { name: `Notes ${role}`, email: `notes.${role}.${suffix}@example.test`, password };
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
  await expect(page).toHaveURL(/\/workspaces\/[0-9a-f-]+$/u);
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
    { headers: { Origin: appUrl }, data: { email: account.email, role } },
  );
  expect(invite.ok()).toBeTruthy();
  await register(member, account);
  await member.goto(await latestActionLink(owner.request, account.email, `Join ${workspaceName}`));
  await member.getByRole("button", { name: "Accept workspace invitation" }).click();
  await expect(member).toHaveURL(`/workspaces/${workspaceId}`);
}

test.describe.serial("Part 32 real-stack note management", () => {
  test.skip(
    !disposable,
    "note management requires PLAYWRIGHT_DISPOSABLE_TEST_RUN=true and disposable PostgreSQL, Redis, and Mailpit",
  );

  test("covers hierarchy, keyboard moves, sharing changes, trash, project links, responsive reflow, and tenant concealment", async ({
    browser,
  }) => {
    const ownerContext = await browser.newContext();
    const editorContext = await browser.newContext();
    const viewerContext = await browser.newContext();
    const otherContext = await browser.newContext();
    const owner = await ownerContext.newPage();
    const editor = await editorContext.newPage();
    const viewer = await viewerContext.newPage();
    const other = await otherContext.newPage();
    const editorIdentity = identity("editor");
    const viewerIdentity = identity("viewer");
    const workspaceName = `Notes Alpha ${randomUUID().slice(0, 8)}`;
    let workspaceId: string | null = null;
    let otherWorkspaceId: string | null = null;
    let otherWorkspaceName: string | null = null;
    try {
      await register(owner, identity("owner"));
      workspaceId = await createWorkspace(owner, workspaceName);
      await inviteAndJoin(owner, editor, workspaceId, workspaceName, editorIdentity, "editor");
      await inviteAndJoin(owner, viewer, workspaceId, workspaceName, viewerIdentity, "viewer");

      const projectResult = await apiPost(
        owner.request,
        `/api/v1/workspaces/${workspaceId}/projects`,
        { name: "Project Atlas", color: "#3b82f6", status: "active" },
        randomUUID(),
      );
      const project = projectResult.project as { id: string };
      const firstResult = await apiPost(
        owner.request,
        `/api/v1/workspaces/${workspaceId}/notes`,
        { title: "First standalone", projectId: null, folderId: null, parentId: null },
        randomUUID(),
      );
      const secondResult = await apiPost(
        owner.request,
        `/api/v1/workspaces/${workspaceId}/notes`,
        { title: "Second standalone", projectId: null, folderId: null, parentId: null },
        randomUUID(),
      );
      const projectNoteResult = await apiPost(
        owner.request,
        `/api/v1/workspaces/${workspaceId}/notes`,
        { title: "Atlas project note", projectId: project.id, folderId: null, parentId: null },
        randomUUID(),
      );
      const firstNote = firstResult.note as { id: string; version: number };
      const secondNote = secondResult.note as { id: string; version: number };
      const projectNote = projectNoteResult.note as { id: string };

      await owner.goto(`/workspaces/${workspaceId}/notes`);
      await expect(owner.getByRole("heading", { level: 1, name: "Notes" })).toBeVisible();
      const secondCard = owner
        .getByRole("link", { name: "Second standalone" })
        .locator("xpath=ancestor::article");
      const secondDragHandle = secondCard.getByRole("button", { name: "Drag Second standalone" });
      /*
       * The live region the drag-and-drop layer announces through. Filtering on
       * its own wording keeps it distinct from any toast that also exposes the
       * `status` role.
       */
      const dragAnnouncements = owner.getByRole("status").filter({ hasText: /draggable item/iu });
      await secondDragHandle.focus();
      await owner.keyboard.press("Space");
      /*
       * Picking an item up and measuring the drop targets are separate render
       * passes, and an arrow key that lands in between is silently discarded
       * because no measured target lies in that direction. The first "moved
       * over" announcement — the item resting over itself — is the point at
       * which those measurements exist, so wait for it before steering.
       */
      await expect(dragAnnouncements).toContainText(
        `was moved over droppable area ${secondNote.id}`,
      );
      /*
       * The note list is a two-column grid at this project's 1280px viewport, so
       * the preceding sibling sits to the left rather than above. Keyboard
       * coordinates are computed from real rects, so ArrowLeft — not ArrowUp —
       * is what a keyboard user presses here to move ahead of it.
       */
      await owner.keyboard.press("ArrowLeft");
      await expect(dragAnnouncements).toContainText(
        `was moved over droppable area ${firstNote.id}`,
      );
      await owner.keyboard.press("Space");
      await expect(owner.getByText("Moved Second standalone.")).toBeVisible();
      await owner.reload();
      const ordered = owner.getByRole("list", { name: "Notes" }).getByRole("link");
      await expect(ordered.nth(0)).toHaveText("Second standalone");

      const firstCardForPointer = owner
        .getByRole("link", { name: "First standalone" })
        .locator("xpath=ancestor::article");
      const firstDragHandle = firstCardForPointer.getByRole("button", {
        name: "Drag First standalone",
      });
      /*
       * `dragTo` presses, moves once and releases. The pointer sensor spends
       * that single move satisfying its 8px activation distance, so the drag
       * starts with a zero translation and drops onto itself. A real pointer
       * drag keeps moving after activation, so drive the mouse directly:
       * one move to pick the card up, then a stepped move onto the target.
       * Droppable rects are measured when the drag starts, so the target is
       * measured beforehand rather than mid-drag while transforms are applied.
       */
      const handleBox = (await firstDragHandle.boundingBox())!;
      const targetBox = (await secondCard.boundingBox())!;
      await firstDragHandle.hover();
      await owner.mouse.down();
      await owner.mouse.move(handleBox.x + handleBox.width / 2 + 24, handleBox.y, { steps: 8 });
      await expect(firstDragHandle).toHaveAttribute("aria-pressed", "true");
      await owner.mouse.move(
        targetBox.x + targetBox.width / 2,
        targetBox.y + targetBox.height / 2,
        { steps: 12 },
      );
      await expect(dragAnnouncements).toContainText(
        `was moved over droppable area ${secondNote.id}`,
      );
      await owner.mouse.up();
      await expect(owner.getByText("Moved First standalone.")).toBeVisible();

      const movePath = `${apiUrl}/api/v1/workspaces/${workspaceId}/notes/${firstNote.id}/move`;
      await owner.route(movePath, async (route) =>
        route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({ code: "VERSION_CONFLICT", message: "Injected conflict" }),
        }),
      );
      const beforeConflict = await owner
        .getByRole("list", { name: "Notes" })
        .getByRole("link")
        .allTextContents();
      await owner
        .getByRole("link", { name: "First standalone" })
        .locator("xpath=ancestor::article")
        .getByRole("button", { name: "Move to destination" })
        .click();
      await expect(
        owner.getByText(/exact previous title, version, location, and order were restored/u),
      ).toBeVisible();
      expect(
        await owner.getByRole("list", { name: "Notes" }).getByRole("link").allTextContents(),
      ).toEqual(beforeConflict);
      await owner.unroute(movePath);
      await owner.route(movePath, async (route) => route.abort("failed"));
      await owner
        .getByRole("link", { name: "First standalone" })
        .locator("xpath=ancestor::article")
        .getByRole("button", { name: "Move to destination" })
        .click();
      await expect(owner.getByText(/could not reach Notted/u)).toBeVisible();
      await owner.unroute(movePath);

      await owner.getByRole("button", { name: "Create folder" }).click();
      const createFolderDialog = owner.getByRole("dialog", { name: "Create folder" });
      await createFolderDialog.getByLabel("Name").fill("Journey folder");
      await createFolderDialog.getByRole("button", { name: "Create", exact: true }).click();
      await expect(owner.getByText("Folder created.")).toBeVisible();
      /*
       * Every note card offers the new folder as a move destination, so a bare
       * text lookup for the folder name also lands inside the note list, and the
       * folder's own list item replaces that name with a form while it is being
       * renamed. Address the folder region's single list item instead, and assert
       * the name it carries as its own step.
       */
      const folderItem = owner
        .getByRole("region", { name: "Standalone folders" })
        .getByRole("listitem");
      await expect(folderItem).toHaveText(/Journey folder/u);
      await folderItem.getByRole("button", { name: "Rename" }).click();
      await folderItem.getByLabel("New folder name").fill("Renamed journey folder");
      await folderItem.getByRole("button", { name: "Save" }).click();
      await expect(owner.getByText("Folder renamed.")).toBeVisible();
      await expect(folderItem).toHaveText(/Renamed journey folder/u);
      await folderItem.getByRole("button", { name: "Delete" }).click();
      await owner
        .getByRole("dialog", { name: /Delete Renamed journey folder/u })
        .getByRole("button", { name: "Delete folder" })
        .click();
      await expect(owner.getByText(/Folder deleted/u)).toBeVisible();

      await owner.goto(`/workspaces/${workspaceId}/projects/${project.id}`);
      /*
       * Every note title appears twice on a dashboard page: once in the note
       * tree of the persistent sidebar and once in the page's own list. Scope
       * these assertions to the `main` landmark so they check the thing the
       * page is actually responsible for rendering. `.first()` would hide which
       * of the two matched and would keep passing if the main region broke —
       * which is precisely how the project-detail 500 went unnoticed here.
       */
      await expect(
        owner.getByRole("main").getByRole("link", { name: "Atlas project note" }),
      ).toBeVisible();
      await owner.goto(`/workspaces/${workspaceId}/projects/${project.id}/notes/${projectNote.id}`);
      await expect(owner.getByRole("navigation", { name: "Note breadcrumbs" })).toContainText(
        "Project Atlas",
      );

      await owner.goto(`/workspaces/${workspaceId}/notes/${firstNote.id}`);
      await owner.getByRole("button", { name: "Share" }).click();
      const shareDialog = owner.getByRole("dialog", { name: "Share note" });
      await expect(shareDialog.getByText(/Requires Notted access/u)).toBeVisible();
      await shareDialog
        .getByLabel("Workspace member")
        .selectOption({ label: `${editorIdentity.name} · editor` });
      await shareDialog.getByLabel("Permission").selectOption("view");
      await shareDialog.getByRole("button", { name: "Grant access" }).click();
      await expect(shareDialog.getByText("Authenticated note access updated.")).toBeVisible();

      await editor.goto(`/workspaces/${workspaceId}/notes`);
      let editorCard = editor
        .getByRole("link", { name: "First standalone" })
        .locator("xpath=ancestor::article");
      /*
       * `exact` matters here. A note card also carries a drag handle named
       * "Drag <note title>", and `getByRole` name matching is substring based,
       * so once a note is titled "Editor shared rename" the handle answers to
       * "Rename" as well. Ask for the button whose whole name is "Rename".
       */
      await editorCard.getByRole("button", { name: "Rename", exact: true }).click();
      await editorCard.getByLabel("New note title").fill("View grant cannot edit");
      await editorCard.getByRole("button", { name: "Save" }).click();
      await expect(editor.getByText(/Rename was denied/u)).toBeVisible();

      await owner.goto(`/workspaces/${workspaceId}/notes/${firstNote.id}`);
      await owner.getByRole("button", { name: "Share" }).click();
      await owner
        .getByRole("dialog", { name: "Share note" })
        .getByLabel(new RegExp(`Permission for ${editorIdentity.name}`))
        .selectOption("edit");
      await editor.reload();
      editorCard = editor
        .getByRole("link", { name: "First standalone" })
        .locator("xpath=ancestor::article");
      await editorCard.getByRole("button", { name: "Rename", exact: true }).click();
      await editorCard.getByLabel("New note title").fill("Editor shared rename");
      await editorCard.getByRole("button", { name: "Save" }).click();
      await expect(
        editor.getByRole("main").getByRole("link", { name: "Editor shared rename" }),
      ).toBeVisible();

      await owner.reload();
      await owner.getByRole("button", { name: "Share" }).click();
      await owner
        .getByRole("dialog", { name: "Share note" })
        .getByRole("button", { name: "Revoke" })
        .click();
      await expect(owner.getByText(/applies to the next note request immediately/u)).toBeVisible();
      await editor.goto(`/workspaces/${workspaceId}/notes`);
      editorCard = editor
        .getByRole("link", { name: "Editor shared rename" })
        .locator("xpath=ancestor::article");
      await editorCard.getByRole("button", { name: "Rename", exact: true }).click();
      await editorCard.getByLabel("New note title").fill("Revoked edit");
      await editorCard.getByRole("button", { name: "Save" }).click();
      await expect(editor.getByText(/Rename was denied/u)).toBeVisible();

      await viewer.goto(`/workspaces/${workspaceId}/notes`);
      await expect(viewer.getByRole("button", { name: "Create note" })).toBeDisabled();
      await expect(
        viewer.getByRole("main").getByRole("link", { name: "Editor shared rename" }),
      ).toBeVisible();

      await owner.goto(`/workspaces/${workspaceId}/notes`);
      const trashCard = owner
        .getByRole("link", { name: "Editor shared rename" })
        .locator("xpath=ancestor::article");
      const trashTrigger = trashCard.getByRole("button", { name: "Move to trash" });
      await trashTrigger.click();
      await owner.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
      await expect(trashTrigger).toBeFocused();
      await trashTrigger.click();
      await owner.getByRole("dialog").getByRole("button", { name: "Move to trash" }).click();
      await owner.goto(`/workspaces/${workspaceId}/notes/trash`);
      await owner.getByRole("button", { name: "Restore" }).click();
      await expect(owner.getByText(/restored/u)).toBeVisible();
      const latest = await owner.request.get(
        `${apiUrl}/api/v1/workspaces/${workspaceId}/notes/${firstNote.id}`,
      );
      const latestNote = (await latest.json()) as { version: number };
      await owner.request.delete(
        `${apiUrl}/api/v1/workspaces/${workspaceId}/notes/${firstNote.id}`,
        { headers: { Origin: appUrl }, data: { expectedVersion: latestNote.version } },
      );
      await owner.goto(`/workspaces/${workspaceId}/notes/trash`);
      await owner.getByRole("button", { name: "Delete permanently" }).click();
      await owner.getByRole("dialog").getByLabel("Note title").fill("Editor shared rename");
      await owner.getByRole("dialog").getByRole("button", { name: "Delete permanently" }).click();
      await expect(owner.getByText(/permanently deleted/u)).toBeVisible();

      await owner.emulateMedia({ reducedMotion: "reduce" });
      /*
       * WCAG 2.2 AA 1.4.10 Reflow is specified as no two-dimensional scrolling
       * at a viewport width of 320 CSS pixels — the equivalent of 400% zoom on
       * a 1280px desktop viewport — and `globals.css` implements that floor
       * with `body { min-width: 320px }`. Resizing the viewport is the faithful
       * way to exercise it.
       *
       * This block used to set `document.documentElement.style.zoom = "2"` at a
       * 390px viewport instead, which was wrong twice over and had never
       * actually run, because the project-detail 500 ended the test earlier.
       * The CSS `zoom` property does not re-evaluate media queries, so at
       * 640px/200% the page kept its `sm:` layout inside 320 CSS pixels and
       * reported an overflow the product does not have; and it compared a
       * zoom-scaled `scrollWidth` against an unzoomed `clientWidth`, which is
       * not a like-for-like measurement. Real browser zoom re-evaluates media
       * queries; `style.zoom` does not. Measured on this page, a genuine 320px
       * viewport reflows exactly to the floor with no horizontal scrolling.
       */
      for (const viewport of [
        { width: 320, height: 844 },
        { width: 390, height: 844 },
        { width: 768, height: 1024 },
        { width: 1440, height: 900 },
      ]) {
        await owner.setViewportSize(viewport);
        await owner.goto(`/workspaces/${workspaceId}/notes`);
        const reflow = await owner.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
          contentWidth: document.body.scrollWidth,
        }));
        expect(reflow.scrollWidth).toBeLessThanOrEqual(reflow.clientWidth + 1);
        expect(reflow.contentWidth).toBeLessThanOrEqual(Math.max(viewport.width, 320));
      }

      await register(other, identity("other-tenant"));
      otherWorkspaceName = `Notes Beta ${randomUUID().slice(0, 8)}`;
      otherWorkspaceId = await createWorkspace(other, otherWorkspaceName);
      const otherNoteResult = await apiPost(
        other.request,
        `/api/v1/workspaces/${otherWorkspaceId}/notes`,
        { title: "Other tenant note", projectId: null, folderId: null, parentId: null },
        randomUUID(),
      );
      const otherNote = otherNoteResult.note as { id: string };
      const otherProjectResult = await apiPost(
        other.request,
        `/api/v1/workspaces/${otherWorkspaceId}/projects`,
        { name: "Other tenant project", color: "#3b82f6", status: "active" },
        randomUUID(),
      );
      const otherProject = otherProjectResult.project as { id: string };
      const otherProjectNoteResult = await apiPost(
        other.request,
        `/api/v1/workspaces/${otherWorkspaceId}/notes`,
        {
          title: "Other tenant project note",
          projectId: otherProject.id,
          folderId: null,
          parentId: null,
        },
        randomUUID(),
      );
      const otherProjectNote = otherProjectNoteResult.note as { id: string };
      await other.goto(`/workspaces/${workspaceId}/notes/${secondNote.id}`);
      await expect(
        other.getByRole("heading", { name: /Note or note collection not found/u }),
      ).toBeVisible();
      await owner.goto(`/workspaces/${workspaceId}/notes/${otherNote.id}`);
      await expect(
        owner.getByRole("heading", { name: /Note or note collection not found/u }),
      ).toBeVisible();
      await owner.goto(
        `/workspaces/${otherWorkspaceId}/projects/${otherProject.id}/notes/${otherProjectNote.id}`,
      );
      await expect(owner.getByRole("heading", { name: /Project note not found/u })).toBeVisible();
    } finally {
      if (workspaceId !== null)
        await owner.request
          .delete(`${apiUrl}/api/v1/workspaces/${workspaceId}`, {
            headers: { Origin: appUrl },
            data: { confirm: true, expectedName: workspaceName },
          })
          .catch(() => undefined);
      if (otherWorkspaceId !== null && otherWorkspaceName !== null)
        await other.request
          .delete(`${apiUrl}/api/v1/workspaces/${otherWorkspaceId}`, {
            headers: { Origin: appUrl },
            data: { confirm: true, expectedName: otherWorkspaceName },
          })
          .catch(() => undefined);
      await ownerContext.close();
      await editorContext.close();
      await viewerContext.close();
      await otherContext.close();
    }
  });
});
