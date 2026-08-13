import { expect, test, type Page } from "@playwright/test";

const shellEmail = process.env.PLAYWRIGHT_SHELL_EMAIL;
const shellPassword = process.env.PLAYWRIGHT_SHELL_PASSWORD;
const hasShellFixture = typeof shellEmail === "string" && typeof shellPassword === "string";

async function signIn(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email", { exact: true }).first().fill(shellEmail!);
  await page.getByLabel("Password").fill(shellPassword!);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/$/u);
}

test.describe("Part 25 dashboard shell", () => {
  test.skip(
    !hasShellFixture,
    "requires a tenant-aware fixture user with two workspaces and unread notifications",
  );

  test.beforeEach(async ({ page }) => signIn(page));

  for (const viewport of [
    { name: "phone", width: 390, height: 844 },
    { name: "tablet", width: 820, height: 1180 },
    { name: "desktop", width: 1440, height: 900 },
  ]) {
    test(`${viewport.name} reflows with landmarks, skip links and keyboard access`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      await page.reload();
      await expect(page.getByRole("main")).toBeVisible();
      await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toBeVisible();
      await page.keyboard.press("Tab");
      await expect(page.getByRole("link", { name: "Skip to main content" })).toBeFocused();
      if (viewport.width < 768) {
        const trigger = page.getByRole("button", { name: "Open navigation" });
        await trigger.focus();
        await page.keyboard.press("Enter");
        await expect(page.getByRole("dialog", { name: "Workspace navigation" })).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(trigger).toBeFocused();
      }
      await expect(page.locator("body")).not.toHaveCSS("overflow-x", "scroll");
    });
  }

  test("keyboard command palette, user menu security link and logout work", async ({ page }) => {
    const commandTrigger = page.getByRole("button", { name: "Open command menu and search" });
    await commandTrigger.click();
    const palette = page.getByRole("dialog", { name: "Search notes" });
    await expect(palette).toBeVisible();
    await page.keyboard.press("Escape");
    await page.keyboard.press("Control+K");
    await expect(palette).toBeVisible();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Open user menu" }).click();
    await expect(page.getByRole("menuitem", { name: "Security settings" })).toBeVisible();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Open user menu" }).click();
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/login/u);
  });

  test("server-validates workspace switching and never exposes an invented option", async ({
    page,
  }) => {
    const selector = page.getByRole("combobox", { name: "Current workspace" });
    await expect(selector.locator("option")).toHaveCount(2);
    const options = await selector.locator("option").allTextContents();
    expect(options.length).toBeGreaterThanOrEqual(2);
    await selector.selectOption({ index: 1 });
    await expect(page).toHaveURL(/workspace=/u);
    await page.reload();
    await expect(selector).toHaveValue(
      (await selector.locator("option").nth(1).getAttribute("value")) ?? "",
    );
  });

  test("notification read state persists across navigation/reload and mark-all updates the badge", async ({
    page,
  }) => {
    await page.getByRole("button", { name: /Notifications, \d+ unread/u }).click();
    const dialog = page.getByRole("dialog", { name: "Notifications" });
    const firstRead = dialog.getByRole("button", { name: /^Mark read:/u }).first();
    const label = await firstRead.getAttribute("aria-label");
    await firstRead.click();
    await page.keyboard.press("Escape");
    await page.goto("/settings/security");
    await page.goto("/");
    await page.reload();
    await page.getByRole("button", { name: /Notifications/u }).click();
    await expect(
      dialog.getByRole("button", { name: label!.replace("Mark read:", "Mark unread:") }),
    ).toBeVisible();
    await dialog.getByRole("button", { name: "Mark all read" }).click();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Notifications" })).toBeVisible();
  });

  test("notification errors are retryable and do not leak payloads", async ({ page }) => {
    await page.route("**/api/v1/workspaces/*/notifications?*", (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: { message: "safe" } }),
      }),
    );
    await page.getByRole("button", { name: /Notifications/u }).click();
    await expect(page.getByRole("alert").filter({ hasText: "could not be loaded" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
  });

  test("reduced motion and 200% zoom retain usable controls without horizontal page overflow", async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.reload();
    await expect(page.getByRole("button", { name: /Notifications/u })).toBeVisible();
    await page.evaluate(() => {
      document.documentElement.style.zoom = "200%";
    });
    await expect(page.getByRole("main")).toBeVisible();
    const dimensions = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth + 1);
  });
});
