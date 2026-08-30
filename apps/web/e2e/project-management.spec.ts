import { randomUUID } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";

import { latestActionLink } from "./mailpit";

const disposable = process.env.PLAYWRIGHT_DISPOSABLE_TEST_RUN === "true";
const apiUrl = process.env.PLAYWRIGHT_API_URL ?? "http://localhost:3001";
const appUrl = process.env.PLAYWRIGHT_APP_URL ?? "http://localhost:3000";
const password = "Fresh1!Password";

function identity(label: string) {
  const suffix = randomUUID();
  return { name: `Projects ${label}`, email: `projects.${label}.${suffix}@example.test`, password };
}

async function register(page: Page, account: ReturnType<typeof identity>): Promise<void> {
  await page.goto("/register");
  await page.getByLabel("Name").fill(account.name);
  await page.getByLabel("Email").fill(account.email);
  await page.getByLabel("Password", { exact: true }).fill(account.password);
  await page.getByLabel("Confirm password").fill(account.password);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.goto(await latestActionLink(page.request, account.email, "Verify your Notted email"));
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

async function invite(
  owner: Page,
  member: Page,
  workspaceId: string,
  workspaceName: string,
  account: ReturnType<typeof identity>,
  role: "editor" | "viewer",
): Promise<void> {
  const response = await owner.request.post(
    `${apiUrl}/api/v1/workspaces/${workspaceId}/invitations`,
    {
      headers: { Origin: appUrl },
      data: { email: account.email, role },
    },
  );
  await expect(response).toBeOK();
  await register(member, account);
  await member.goto(await latestActionLink(owner.request, account.email, `Join ${workspaceName}`));
  await member.getByRole("button", { name: "Accept workspace invitation" }).click();
  await expect(member).toHaveURL(`/workspaces/${workspaceId}`);
}

test.describe.serial("Part 30 real-stack project management", () => {
  test.skip(
    !disposable,
    "project management requires the disposable compiled API/Next/PostgreSQL/Redis/Mailpit stack",
  );

  test("creates, filters, persists views, edits lifecycle, reflows, denies roles, and deletes", async ({
    browser,
  }) => {
    const ownerContext = await browser.newContext();
    const editorContext = await browser.newContext();
    const viewerContext = await browser.newContext();
    const owner = await ownerContext.newPage();
    const editor = await editorContext.newPage();
    const viewer = await viewerContext.newPage();
    const workspaceName = `Project workspace ${randomUUID().slice(0, 8)}`;
    const projectName = `Keyboard project ${randomUUID().slice(0, 8)}`;
    let workspaceId: string | null = null;
    try {
      await register(owner, identity("owner"));
      workspaceId = await createWorkspace(owner, workspaceName);
      await invite(owner, editor, workspaceId, workspaceName, identity("editor"), "editor");
      await invite(owner, viewer, workspaceId, workspaceName, identity("viewer"), "viewer");

      await owner.goto(`/workspaces/${workspaceId}/projects`);
      const createTrigger = owner.getByRole("button", { name: "Create project" });
      await createTrigger.focus();
      await owner.keyboard.press("Enter");
      const createDialog = owner.getByRole("dialog", { name: "Create a project" });
      await createDialog.getByLabel("Name").fill(projectName);
      await createDialog.getByLabel("Description").fill("Created from the real Chromium journey");
      await createDialog.getByRole("button", { name: "Create project", exact: true }).click();
      await expect(owner.getByRole("link", { name: projectName })).toBeVisible();

      await owner.getByLabel("Name", { exact: true }).fill("Keyboard");
      await owner.getByRole("button", { name: "Apply filters" }).click();
      await expect(owner).toHaveURL(/name=Keyboard/u);
      await expect(owner.getByRole("link", { name: projectName })).toBeVisible();
      await owner.getByRole("button", { name: "List" }).click();
      await expect(owner.getByRole("button", { name: "List" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await owner.reload();
      await expect(owner.getByRole("button", { name: "List" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await owner.getByRole("button", { name: "Grid" }).click();

      await owner.getByRole("link", { name: projectName }).click();
      await owner.getByRole("button", { name: "Edit project" }).click();
      const editDialog = owner.getByRole("dialog", { name: "Edit project" });
      await editDialog.getByLabel("Description").fill("Edited project details");
      await editDialog.getByRole("button", { name: "Save changes" }).click();
      await expect(owner.getByText("Edited project details")).toBeVisible();
      await owner.getByRole("button", { name: "Complete" }).click();
      await expect(owner.getByRole("button", { name: "Restore" })).toBeVisible();
      await owner.getByRole("button", { name: "Restore" }).click();
      await owner.getByRole("button", { name: "Archive" }).click();
      await expect(owner.getByRole("button", { name: "Restore" })).toBeVisible();
      await owner.getByRole("button", { name: "Restore" }).click();

      const projectPath = new URL(owner.url()).pathname;
      for (const viewport of [
        { width: 390, height: 844 },
        { width: 768, height: 1024 },
        { width: 1440, height: 900 },
      ]) {
        await owner.setViewportSize(viewport);
        await owner.goto(projectPath);
        const dimensions = await owner.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
        }));
        expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth + 1);
      }
      await owner.evaluate(() => {
        document.documentElement.style.zoom = "2";
      });
      const zoomed = await owner.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      expect(zoomed.scrollWidth).toBeLessThanOrEqual(zoomed.clientWidth + 1);

      for (const deniedPage of [editor, viewer]) {
        await deniedPage.goto(`/workspaces/${workspaceId}/projects`);
        await expect(deniedPage.getByRole("button", { name: "Create project" })).toHaveCount(0);
        await expect(
          deniedPage.getByText(/Creating projects requires owner or admin access/u),
        ).toBeVisible();
        await deniedPage.goto(projectPath);
        await expect(deniedPage.getByText(/Project controls are not shown/u)).toBeVisible();
      }

      await owner.goto(projectPath);
      await owner.getByRole("button", { name: "Delete project" }).click();
      const deleteDialog = owner.getByRole("dialog", { name: "Delete project?" });
      await deleteDialog.getByLabel(`Type ${projectName} to confirm`).fill(projectName);
      await deleteDialog.getByRole("button", { name: "Permanently delete" }).click();
      await expect(owner).toHaveURL(`/workspaces/${workspaceId}/projects`);
      await expect(owner.getByRole("link", { name: projectName })).toHaveCount(0);
    } finally {
      if (workspaceId !== null) {
        await owner.request
          .delete(`${apiUrl}/api/v1/workspaces/${workspaceId}`, {
            headers: { Origin: appUrl },
            data: { confirm: true, expectedName: workspaceName },
            timeout: 10_000,
          })
          .catch(() => undefined);
      }
      await ownerContext.close();
      await editorContext.close();
      await viewerContext.close();
    }
  });
});
