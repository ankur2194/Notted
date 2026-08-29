import { randomUUID } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";

import { clearMailpit, latestActionLink } from "./mailpit";

const strongPassword = "Fresh1!Password";

function freshIdentity(prefix: string) {
  const suffix = randomUUID();
  return {
    name: `Fresh ${prefix} User`,
    email: `${prefix}.${suffix}@example.test`,
    password: strongPassword,
  };
}

async function registerAndVerify(page: Page, identity: ReturnType<typeof freshIdentity>) {
  await page.goto("/register");
  await page.getByLabel("Name").fill(identity.name);
  await page.getByLabel("Email").fill(identity.email);
  await page.getByLabel("Password", { exact: true }).fill(identity.password);
  await page.getByLabel("Confirm password").fill(identity.password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();

  const verificationLink = await latestActionLink(
    page.request,
    identity.email,
    "Verify your Notted email",
  );
  await page.goto(verificationLink);
  await expect(page).toHaveURL(/\/verify-email/u);
  await expect(page.getByRole("heading", { name: "Email verified" })).toBeVisible();
  return verificationLink;
}

async function signIn(page: Page, email: string, password: string, redirect = "/") {
  await page.goto(`/login?redirect=${encodeURIComponent(redirect)}`);
  await page.getByLabel("Email", { exact: true }).first().fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

async function signOut(page: Page) {
  const menuButton = page.getByRole("button", { name: "User menu" });
  await expect(async () => {
    if ((await menuButton.getAttribute("aria-expanded")) !== "true") await menuButton.click();
    await expect(menuButton).toHaveAttribute("aria-expanded", "true", { timeout: 1_000 });
  }).toPass({ timeout: 10_000 });
  await page.getByRole("button", { name: "Sign out" }).click();
}

test.beforeEach(async ({ request }) => {
  await clearMailpit(request);
});

test("direct protected access, invalid/valid registration, verification, login, refresh, auth redirect and logout", async ({
  page,
}) => {
  const identity = freshIdentity("password");

  await page.goto("/");
  await expect(page).toHaveURL(/\/login\?redirect=%2F/u);

  await page.goto("/register");
  await page.getByLabel("Name").fill(identity.name);
  await page.getByLabel("Email").fill("not-an-email");
  await page.getByLabel("Password", { exact: true }).fill("weak");
  await page.getByLabel("Confirm password").fill("different");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.locator("[data-error-summary]")).toBeFocused();
  await expect(page.getByLabel("Confirm password")).toHaveAttribute("aria-invalid", "true");

  const verificationLink = await registerAndVerify(page, identity);
  const invalidVerificationLink = new URL(verificationLink);
  invalidVerificationLink.searchParams.set("token", "invalid-or-expired-token");
  await page.goto(invalidVerificationLink.toString());
  await expect(page.getByRole("heading", { name: "Verification link unavailable" })).toBeVisible();

  await signIn(page, identity.email, "Incorrect1!Password");
  await expect(page.getByText(/unable to sign in/i)).toBeVisible();
  await page.getByLabel("Password").fill(identity.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL("/");
  await page.reload();
  await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();

  await page.goto("/login");
  await expect(page).toHaveURL("/");
  await signOut(page);
  await expect(page).toHaveURL(/\/login/u);
  await page.goto("/");
  await expect(page).toHaveURL(/\/login\?redirect=%2F/u);
});

test("safe redirects reject external, protocol-relative, encoded and auth-loop targets", async ({
  page,
}) => {
  const identity = freshIdentity("redirect");
  await registerAndVerify(page, identity);

  for (const unsafe of [
    "https://evil.example/path",
    "//evil.example/path",
    "/%2f%2fevil.example/path",
    "javascript:alert(1)",
    "/login?redirect=/",
  ]) {
    await signIn(page, identity.email, identity.password, unsafe);
    await expect(page).toHaveURL("/");
    await signOut(page);
  }
});

test("forgot and reset password remain generic, handle invalid links, revoke old credentials, and allow retry", async ({
  page,
}) => {
  const identity = freshIdentity("reset");
  await registerAndVerify(page, identity);

  await page.goto("/forgot-password");
  await page.getByLabel("Email").fill(`unknown.${randomUUID()}@example.test`);
  await page.getByRole("button", { name: "Request password reset" }).click();
  await expect(page.getByRole("status")).toContainText("If an account exists");

  await clearMailpit(page.request);
  await page.getByLabel("Email").fill(identity.email);
  await page.getByRole("button", { name: "Request password reset" }).click();
  await expect(page.getByRole("status")).toContainText("If an account exists");
  const resetLink = await latestActionLink(
    page.request,
    identity.email,
    "Reset your Notted password",
  );

  await page.goto("/reset-password?token=invalid");
  await expect(page.getByRole("heading", { name: /invalid or expired/i })).toBeVisible();
  await page.goto(resetLink);
  const newPassword = "Changed2!Password";
  await page.getByLabel("New password", { exact: true }).fill(newPassword);
  await page.getByLabel("Confirm new password").fill(newPassword);
  await page.getByRole("button", { name: "Reset password" }).click();
  await expect(page.getByRole("status")).toContainText("password has been reset");

  await signIn(page, identity.email, identity.password);
  await expect(page.getByText(/unable to sign in/i)).toBeVisible();
  await page.getByLabel("Password").fill(newPassword);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL("/");
  await signOut(page);

  await page.goto(resetLink);
  await page.getByLabel("New password", { exact: true }).fill("Again3!Password");
  await page.getByLabel("Confirm new password").fill("Again3!Password");
  await page.getByRole("button", { name: "Reset password" }).click();
  await expect(page.getByText(/invalid or expired/i)).toBeVisible();
  await expect(page.getByRole("link", { name: "Request a new reset link" })).toBeVisible();
});

test("magic-link request has generic result states and one-time links", async ({ page }) => {
  const identity = freshIdentity("magic");
  await registerAndVerify(page, identity);
  await clearMailpit(page.request);
  await page.goto("/login");
  await page.getByText("Email me a sign-in link").click();
  await page.getByLabel("Email", { exact: true }).last().fill(identity.email);
  await page.getByRole("button", { name: "Send sign-in link" }).click();
  await expect(page.getByRole("status")).toContainText("If an account can use this address");

  const magicLink = await latestActionLink(page.request, identity.email, "Your Notted magic link");
  await page.goto(magicLink);
  await expect(page.getByRole("heading", { name: "Signed in securely" })).toBeVisible();
  await page.getByRole("link", { name: "Continue to Notted" }).click();
  await expect(page).toHaveURL("/");
  await signOut(page);

  await page.goto(magicLink);
  await expect(page.getByRole("heading", { name: "Sign-in link unavailable" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Request another sign-in link" })).toBeVisible();
});
