import { randomUUID } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";

import { latestActionLink } from "./mailpit";

const strongPassword = "Fresh1!Password";
const disposableTestRun = process.env.PLAYWRIGHT_DISPOSABLE_TEST_RUN === "true";
const appUrl = process.env.PLAYWRIGHT_APP_URL ?? "http://localhost:3000";
const apiUrl = process.env.PLAYWRIGHT_API_URL ?? "http://localhost:3001";

function freshIdentity(prefix: string) {
  const suffix = randomUUID();
  return {
    name: `Workspace ${prefix} User`,
    email: `workspace.${prefix}.${suffix}@example.test`,
    password: strongPassword,
  };
}

type FreshIdentity = ReturnType<typeof freshIdentity>;

async function registerAndSignIn(
  page: Page,
  prefix: string,
  suppliedIdentity?: FreshIdentity,
): Promise<FreshIdentity> {
  const identity = suppliedIdentity ?? freshIdentity(prefix);
  await page.goto("/register");
  await page.getByLabel("Name").fill(identity.name);
  await page.getByLabel("Email").fill(identity.email);
  await page.getByLabel("Password", { exact: true }).fill(identity.password);
  await page.getByLabel("Confirm password").fill(identity.password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();

  await page.goto(await latestActionLink(page.request, identity.email, "Verify your Notted email"));
  await expect(page.getByRole("heading", { name: "Email verified" })).toBeVisible();
  await page.goto("/login?redirect=%2Fworkspaces");
  await page.getByLabel("Email", { exact: true }).first().fill(identity.email);
  await page.getByLabel("Password").fill(identity.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/workspaces$/u);
  return identity;
}

async function createWorkspace(
  page: Page,
  name: string,
  defaultPageSize: "a4" | "letter",
  exerciseFailure = false,
): Promise<string> {
  const trigger = page.getByRole("button", { name: "Create workspace", exact: true });
  await trigger.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Create a workspace" });
  await expect(dialog).toBeVisible();
  const nameField = dialog.getByLabel("Workspace name");
  await expect(nameField).toBeFocused();
  if (exerciseFailure) {
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel("Workspace name")).toBeFocused();
  }
  await nameField.fill(name);
  await dialog.getByLabel("Default page size").selectOption(defaultPageSize);

  const submit = dialog.getByRole("button", { name: "Create workspace", exact: true });
  if (exerciseFailure) {
    await page.route("**/api/v1/workspaces", (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: { message: "safe" } }),
      }),
    );
    await submit.click();
    await expect(dialog.getByRole("alert")).toContainText("could not be created");
    await page.unroute("**/api/v1/workspaces");
  }

  await submit.click();
  await expect(page).toHaveURL(/\/workspaces\/[0-9a-f-]+$/u);
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
  return new URL(page.url()).pathname.split("/").at(-1)!;
}

async function deleteWorkspace(page: Page, workspaceId: string, name: string): Promise<void> {
  await page.goto(`/workspaces/${workspaceId}/settings`);
  const trigger = page.getByRole("button", { name: "Delete workspace" });
  await trigger.click();
  const confirmation = page.getByLabel(`Type the workspace name (${name}) to confirm`);
  await expect(confirmation).toBeFocused();
  await confirmation.fill(name);
  await page.getByRole("button", { name: "Permanently delete" }).click();
  await expect(page).toHaveURL(/\/workspaces$/u);
}

test.describe("Part 27 workspace management", () => {
  test.skip(
    !disposableTestRun,
    "workspace management requires PLAYWRIGHT_DISPOSABLE_TEST_RUN=true with disposable PostgreSQL, Redis, and Mailpit",
  );

  test("creates, lists, switches, updates, refreshes and safely deletes isolated workspaces", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await registerAndSignIn(page, "lifecycle");
    await expect(page.getByRole("heading", { name: "No workspaces yet" })).toBeVisible();

    const guessedWorkspaceId = randomUUID();
    await page.goto(`/workspaces/${guessedWorkspaceId}`);
    await expect(page.getByRole("heading", { name: "Workspace not found" })).toBeVisible();
    await page.goto("/workspaces");

    const suffix = randomUUID().slice(0, 8);
    const firstName = `Tenant A ${suffix}`;
    const secondName = `Tenant B ${suffix}`;
    const renamedFirst = `Tenant A Renamed ${suffix}`;

    const firstId = await createWorkspace(page, firstName, "a4", true);
    await expect(page.getByText("Plan-managed limit")).toBeVisible();
    await page.goto("/workspaces");
    await expect(page.getByRole("link", { name: `Open ${firstName} workspace` })).toBeVisible();
    const selector = page.getByRole("combobox", { name: "Current workspace" });
    await expect(selector.locator(`option[value="${firstId}"]`)).toHaveCount(1);

    for (const viewport of [
      { width: 390, height: 844 },
      { width: 1440, height: 900 },
    ]) {
      await page.setViewportSize(viewport);
      await page.reload();
      await expect(page.getByRole("main")).toBeVisible();
      await expect(page.getByRole("heading", { level: 1, name: "Workspaces" })).toBeVisible();
      const dimensions = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth + 1);
    }

    const secondId = await createWorkspace(page, secondName, "letter");
    await page.goto("/workspaces");
    await page.getByRole("link", { name: `Open ${firstName} workspace` }).click();
    await expect(page).toHaveURL(`/workspaces/${firstId}`);
    await expect(page.getByRole("combobox", { name: "Current workspace" })).toHaveValue(firstId);
    await page.reload();
    await expect(page.getByRole("combobox", { name: "Current workspace" })).toHaveValue(firstId);

    await page.goto(`/workspaces/${firstId}/settings`);
    const nameField = page.getByLabel("Workspace name");
    await nameField.fill(renamedFirst);
    await page.getByLabel("Default page size").selectOption("letter");
    const updateResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "PATCH" &&
        response.url().endsWith(`/api/v1/workspaces/${firstId}`),
    );
    await page.getByRole("button", { name: "Save changes" }).click();
    // A page `Response`, not an `APIResponse`, so `toBeOK()` does not apply.
    // The message argument carries the same diagnostic that matcher would
    // print: without it a 403 here reads only "expected false to be truthy".
    const update = await updateResponse;
    expect(
      update.ok(),
      `PATCH ${update.url()} -> ${update.status()}: ${await update.text()}`,
    ).toBeTruthy();
    await expect(nameField).toHaveValue(renamedFirst);
    await expect(page.getByLabel("Default page size")).toHaveValue("letter");

    await page.goto(`/workspaces/${firstId}`);
    await expect(page.getByRole("heading", { level: 1, name: renamedFirst })).toBeVisible();
    await expect(page.getByText("Letter", { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("heading", { level: 1, name: renamedFirst })).toBeVisible();
    await expect(page.getByText("Letter", { exact: true })).toBeVisible();

    await page.goto(`/workspaces/${firstId}/settings`);
    const deleteTrigger = page.getByRole("button", { name: "Delete workspace" });
    await deleteTrigger.focus();
    await page.keyboard.press("Enter");
    await expect(
      page.getByLabel(`Type the workspace name (${renamedFirst}) to confirm`),
    ).toBeFocused();
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("button", { name: "Delete workspace" })).toBeFocused();

    await deleteWorkspace(page, firstId, renamedFirst);
    await expect(
      page.getByRole("link", { name: `Open ${renamedFirst} workspace` }),
    ).not.toBeVisible();
    await deleteWorkspace(page, secondId, secondName);
    await expect(page.getByRole("heading", { name: "No workspaces yet" })).toBeVisible();
  });

  test("conceals an existing workspace from another tenant", async ({ browser }) => {
    const ownerContext = await browser.newContext();
    const strangerContext = await browser.newContext();
    const ownerPage = await ownerContext.newPage();
    const strangerPage = await strangerContext.newPage();
    const suffix = randomUUID().slice(0, 8);
    const workspaceName = `Isolation Tenant ${suffix}`;
    try {
      await registerAndSignIn(ownerPage, "isolation-owner");
      const workspaceId = await createWorkspace(ownerPage, workspaceName, "a4");

      await registerAndSignIn(strangerPage, "isolation-stranger");
      await strangerPage.goto(`/workspaces/${workspaceId}`);
      await expect(
        strangerPage.getByRole("heading", { name: "Workspace not found" }),
      ).toBeVisible();
      await strangerPage.goto("/workspaces");
      await expect(strangerPage.locator(`a[href*="${workspaceId}"]`)).toHaveCount(0);

      await deleteWorkspace(ownerPage, workspaceId, workspaceName);
    } finally {
      await ownerContext.close();
      await strangerContext.close();
    }
  });

  test("delivers and accepts a viewer invitation without granting settings mutations", async ({
    browser,
  }) => {
    const ownerContext = await browser.newContext();
    const viewerContext = await browser.newContext();
    const ownerPage = await ownerContext.newPage();
    const viewerPage = await viewerContext.newPage();
    const viewerIdentity = freshIdentity("invited-viewer");
    const workspaceName = `Invitation Tenant ${randomUUID().slice(0, 8)}`;
    try {
      await registerAndSignIn(ownerPage, "invitation-owner");
      const workspaceId = await createWorkspace(ownerPage, workspaceName, "a4");
      const inviteResponse = await ownerPage.request.post(
        `${apiUrl}/api/v1/workspaces/${workspaceId}/invitations`,
        {
          headers: { Origin: appUrl },
          data: { email: viewerIdentity.email, role: "viewer" },
        },
      );
      await expect(inviteResponse).toBeOK();
      const invitationUrl = await latestActionLink(
        ownerPage.request,
        viewerIdentity.email,
        `Join ${workspaceName}`,
      );

      await registerAndSignIn(viewerPage, "invited-viewer", viewerIdentity);
      await viewerPage.goto(invitationUrl);
      await viewerPage.getByRole("button", { name: "Accept workspace invitation" }).click();
      await expect(viewerPage).toHaveURL(`/workspaces/${workspaceId}`);
      await viewerPage.goto(`/workspaces/${workspaceId}/settings`);
      await expect(viewerPage.getByLabel("Workspace name")).toBeDisabled();
      await expect(viewerPage.getByLabel("Default page size")).toBeDisabled();
      await expect(viewerPage.getByText(/Default page size is read-only/i)).toBeVisible();
      await expect(viewerPage.getByRole("button", { name: "Save changes" })).toBeDisabled();
      await expect(viewerPage.getByRole("button", { name: "Delete workspace" })).toHaveCount(0);

      await deleteWorkspace(ownerPage, workspaceId, workspaceName);
    } finally {
      await ownerContext.close();
      await viewerContext.close();
    }
  });
});
