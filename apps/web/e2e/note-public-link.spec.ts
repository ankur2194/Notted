import { randomUUID } from "node:crypto";

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import { latestActionLink } from "./mailpit";

/*
 * Task 13 — the note public link journey, driven through the real
 * `ShareModal` "Public link" section and the real unauthenticated `/p/:token`
 * page.
 *
 * WHAT ONLY A BROWSER CAN PROVE HERE: the public link is genuinely
 * unauthenticated. A unit or API test can assert the create/revoke endpoints
 * return the right payloads, but only a *fresh browser context with no
 * cookies* proves that a stranger who received the URL can read the note
 * without ever having signed in, and that revoking it really locks that
 * stranger out on their very next request for the same URL rather than only
 * updating the owner's own management UI.
 */

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
  await expect(response).toBeOK();
  return response.json() as Promise<Record<string, unknown>>;
}

test.describe.serial("Task 13 note public link journey", () => {
  test.skip(
    !disposable,
    "note public link journey requires PLAYWRIGHT_DISPOSABLE_TEST_RUN=true and disposable PostgreSQL, Redis, and Mailpit",
  );

  test("create, view anonymously, then revoke", async ({ page, browser }) => {
    const workspaceName = `Notes Public ${randomUUID().slice(0, 8)}`;
    const noteTitle = `Public link note ${randomUUID().slice(0, 8)}`;
    let workspaceId: string | null = null;
    try {
      await register(page, identity("owner"));
      workspaceId = await createWorkspace(page, workspaceName);

      const noteResult = await apiPost(
        page.request,
        `/api/v1/workspaces/${workspaceId}/notes`,
        { title: noteTitle, projectId: null, folderId: null, parentId: null },
        randomUUID(),
      );
      const note = noteResult.note as { id: string };

      await page.goto(`/workspaces/${workspaceId}/notes/${note.id}`);
      await page.getByRole("button", { name: "Share" }).click();
      const shareDialog = page.getByRole("dialog", { name: "Share note" });
      await shareDialog.getByRole("button", { name: "Create link" }).click();
      await expect(shareDialog.getByText("Public link created. Copy it now")).toBeVisible();
      const publicUrl = await shareDialog.getByLabel("Public note link").inputValue();
      expect(publicUrl).not.toBe("");

      // A fresh, unauthenticated browser context — no cookies from `page` at
      // all — is the only honest way to prove a stranger with just the URL
      // can read the note without ever signing in.
      const publicContext = await browser.newContext();
      try {
        const publicPage = await publicContext.newPage();
        await publicPage.goto(publicUrl);
        await expect(publicPage.getByRole("heading", { name: noteTitle })).toBeVisible();

        await shareDialog.getByRole("button", { name: "Revoke public link" }).click();
        await expect(shareDialog.getByText("Public link revoked.")).toBeVisible();

        // Re-request the exact same public URL in the same unauthenticated
        // context; the management UI updating is not proof the link itself
        // stopped working for whoever already had it.
        await publicPage.reload();
        await expect(publicPage.getByRole("heading", { name: /doesn't work/iu })).toBeVisible();
      } finally {
        await publicContext.close();
      }
    } finally {
      if (workspaceId !== null)
        await page.request
          .delete(`${apiUrl}/api/v1/workspaces/${workspaceId}`, {
            headers: { Origin: appUrl },
            data: { confirm: true, expectedName: workspaceName },
          })
          .catch(() => undefined);
    }
  });
});
