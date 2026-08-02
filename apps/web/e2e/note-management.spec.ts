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
      await expect(owner.getByRole("heading", { name: "Notes" })).toBeVisible();
      const secondCard = owner
        .getByRole("link", { name: "Second standalone" })
        .locator("xpath=ancestor::article");
      await secondCard.getByRole("button", { name: "Drag Second standalone" }).focus();
      await owner.keyboard.press("Space");
      await owner.keyboard.press("ArrowUp");
      await owner.keyboard.press("Space");
      await expect(owner.getByText("Moved Second standalone.")).toBeVisible();
      await owner.reload();
      const ordered = owner.getByRole("list", { name: "Notes" }).getByRole("link");
      await expect(ordered.nth(0)).toHaveText("Second standalone");

      const firstCardForPointer = owner
        .getByRole("link", { name: "First standalone" })
        .locator("xpath=ancestor::article");
      await firstCardForPointer
        .getByRole("button", { name: "Drag First standalone" })
        .dragTo(secondCard);
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
      await expect(owner.getByText(/previous state was restored/u)).toBeVisible();
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
      const folderItem = owner.getByText("Journey folder").locator("xpath=ancestor::li");
      await folderItem.getByRole("button", { name: "Rename" }).click();
      await folderItem.getByLabel("New folder name").fill("Renamed journey folder");
      await folderItem.getByRole("button", { name: "Save" }).click();
      await expect(owner.getByText("Folder renamed.")).toBeVisible();
      const renamedFolderItem = owner
        .getByText("Renamed journey folder")
        .locator("xpath=ancestor::li");
      await renamedFolderItem.getByRole("button", { name: "Delete" }).click();
      await owner
        .getByRole("dialog", { name: /Delete Renamed journey folder/u })
        .getByRole("button", { name: "Delete folder" })
        .click();
      await expect(owner.getByText(/Folder deleted/u)).toBeVisible();

      await owner.goto(`/workspaces/${workspaceId}/projects/${project.id}`);
      await expect(owner.getByRole("link", { name: "Atlas project note" })).toBeVisible();
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
      await editorCard.getByRole("button", { name: "Rename" }).click();
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
      await editorCard.getByRole("button", { name: "Rename" }).click();
      await editorCard.getByLabel("New note title").fill("Editor shared rename");
      await editorCard.getByRole("button", { name: "Save" }).click();
      await expect(editor.getByRole("link", { name: "Editor shared rename" })).toBeVisible();

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
      await editorCard.getByRole("button", { name: "Rename" }).click();
      await editorCard.getByLabel("New note title").fill("Revoked edit");
      await editorCard.getByRole("button", { name: "Save" }).click();
      await expect(editor.getByText(/Rename was denied/u)).toBeVisible();

      await viewer.goto(`/workspaces/${workspaceId}/notes`);
      await expect(viewer.getByRole("button", { name: "Create note" })).toBeDisabled();
      await expect(viewer.getByRole("link", { name: "Editor shared rename" })).toBeVisible();

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
      for (const viewport of [
        { width: 390, height: 844 },
        { width: 768, height: 1024 },
        { width: 1440, height: 900 },
      ]) {
        await owner.setViewportSize(viewport);
        await owner.goto(`/workspaces/${workspaceId}/notes`);
        const reflow = await owner.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
        }));
        expect(reflow.scrollWidth).toBeLessThanOrEqual(reflow.clientWidth + 1);
      }
      await owner.setViewportSize({ width: 390, height: 844 });
      await owner.evaluate(() => {
        document.documentElement.style.zoom = "2";
      });
      const dimensions = await owner.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth + 1);

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
