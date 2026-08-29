import { createHmac, randomUUID } from "node:crypto";

import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";

import { clearMailpit, latestActionLink } from "./mailpit";

const fixturePassword = "Advanced1!Fixture";
const apiUrl = process.env.PLAYWRIGHT_API_URL ?? "http://localhost:3001";
const googleOAuthConfigured =
  process.env.AUTH_OAUTH_GOOGLE_CLIENT_ID !== undefined &&
  process.env.AUTH_OAUTH_GOOGLE_CLIENT_SECRET !== undefined;

function identity(prefix: string) {
  return {
    name: `Advanced ${prefix}`,
    email: `${prefix}.${randomUUID()}@example.test`,
    password: fixturePassword,
  };
}

async function registerAndVerify(page: Page, user: ReturnType<typeof identity>) {
  await page.goto("/register");
  await page.getByLabel("Name").fill(user.name);
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password", { exact: true }).fill(user.password);
  await page.getByLabel("Confirm password").fill(user.password);
  await page.getByRole("button", { name: "Create account" }).click();
  const link = await latestActionLink(page.request, user.email, "Verify your Notted email");
  await page.goto(link);
  await expect(page.getByRole("heading", { name: "Email verified" })).toBeVisible();
}

async function signIn(page: Page, user: ReturnType<typeof identity>, remember = false) {
  await page.goto("/login");
  await page.getByLabel("Email", { exact: true }).first().fill(user.email);
  await page.getByLabel("Password").fill(user.password);
  const checkbox = page.getByLabel(/Remember this browser/i);
  if (remember) await checkbox.check();
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL((url) => url.pathname !== "/login");
}

async function signOut(page: Page) {
  const menuButton = page.getByRole("button", { name: "Open user menu" });
  await expect(async () => {
    if ((await menuButton.getAttribute("aria-expanded")) !== "true") await menuButton.click();
    await expect(menuButton).toHaveAttribute("aria-expanded", "true", { timeout: 1_000 });
  }).toPass({ timeout: 10_000 });
  await page.getByRole("button", { name: "Sign out" }).click();
}

function decodeBase32(value: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const character of value.toUpperCase().replaceAll("=", "")) {
    bits += alphabet.indexOf(character).toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let offset = 0; offset + 8 <= bits.length; offset += 8) {
    bytes.push(Number.parseInt(bits.slice(offset, offset + 8), 2));
  }
  return Buffer.from(bytes);
}

function totpFromUri(uri: string): string {
  const secret = new URL(uri).searchParams.get("secret");
  if (secret === null) throw new Error("Authenticator setup URI omitted its secret");
  const counter = Math.floor(Date.now() / 30_000);
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", decodeBase32(secret)).update(buffer).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const value =
    (((digest[offset]! & 0x7f) << 24) |
      ((digest[offset + 1]! & 0xff) << 16) |
      ((digest[offset + 2]! & 0xff) << 8) |
      (digest[offset + 3]! & 0xff)) %
    1_000_000;
  return value.toString().padStart(6, "0");
}

async function enableVirtualAuthenticator(context: BrowserContext) {
  const pages = context.pages();
  const session = await context.newCDPSession(pages[0]!);
  await session.send("WebAuthn.enable");
  const result = await session.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return { session, authenticatorId: result.authenticatorId };
}

test.beforeEach(async ({ request }) => {
  await clearMailpit(request);
});

/*
 * The "provider metadata renders enabled controls" test lived here and gated on
 * `AUTH_OAUTH_GOOGLE_CLIENT_ID` / `_SECRET`, which nothing in this repository
 * sets — so it never ran. It could not be revived with `page.route` either: the
 * provider button is rendered from server-supplied capabilities, so without
 * those variables it is not in the DOM, and supplying them would flip the
 * "provider-disabled" test below — which DOES run — to skipped. The pair is
 * mutually exclusive by construction.
 *
 * Its one unique assertion, that a hostile `?redirect=` never reaches the OAuth
 * callback URLs, now lives in
 * `src/components/auth/advanced-authentication.test.tsx`, where it runs with no
 * browser and no credentials.
 */

test("OAuth callback failures return to a generic local provider error state", async ({ page }) => {
  await page.goto("/login?oauth=error&redirect=%2Fsettings%2Fsecurity");
  await expect(page.getByText(/Social sign-in could not be completed/u)).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeEnabled();
  await expect(page).toHaveURL(/\/login\?oauth=error/u);
});

test("provider-disabled rendering keeps password, magic-link, and passkey entry usable", async ({
  page,
}) => {
  test.skip(googleOAuthConfigured, "Run without OAuth fixture credentials configured");
  await page.goto("/login");
  await expect(page.getByRole("button", { name: /Continue with/i })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeEnabled();
  await expect(page.getByText("Email me a sign-in link")).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in with a passkey" })).toBeVisible();
});

test("TOTP enrollment presents QR/URI and one-time recovery, then challenges login", async ({
  page,
}) => {
  const user = identity("totp");
  await registerAndVerify(page, user);
  await signIn(page, user);
  await page.goto("/settings/security");
  await page.getByRole("button", { name: "Enable two-factor authentication" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByLabel("Current password")).toBeFocused();
  await page.getByLabel("Current password").fill(user.password);
  await page.getByRole("button", { name: "Confirm with password" }).click();
  await expect(page.getByRole("img", { name: "Authenticator setup QR code" })).toBeVisible();
  const uri = await page.locator("code").filter({ hasText: "otpauth://" }).textContent();
  if (uri === null) throw new Error("Authenticator setup URI was not rendered");
  await page.getByLabel("Authenticator code").fill(totpFromUri(uri));
  await page.getByRole("button", { name: "Confirm authenticator" }).click();
  await expect(page.getByRole("heading", { name: "Save these recovery codes now" })).toBeVisible();
  const recoveryCode = await page.locator("ul.font-mono li").first().textContent();
  if (recoveryCode === null) throw new Error("Recovery codes were not displayed");
  await page.getByRole("button", { name: "I saved these codes" }).click();
  await signOut(page);

  await signIn(page, user);
  await expect(page).toHaveURL(/\/two-factor/u);
  await page.getByRole("button", { name: "Use a recovery code" }).click();
  await page.getByLabel("Recovery code").fill(recoveryCode);
  await page.getByRole("button", { name: "Verify and continue" }).click();
  await expect(page).toHaveURL("/");
  await signOut(page);
  await signIn(page, user);
  await expect(page).toHaveURL(/\/two-factor/u);
  await page.getByLabel("Authenticator code").fill(totpFromUri(uri));
  await page.getByRole("button", { name: "Verify and continue" }).click();
  await expect(page).toHaveURL("/");
});

test("Chromium virtual authenticator registers, signs in, and removes a named passkey", async ({
  browserName,
  context,
  page,
}) => {
  test.skip(browserName !== "chromium", "CDP virtual authenticators are Chromium-only");
  const user = identity("passkey");
  await registerAndVerify(page, user);
  await signIn(page, user);
  const virtual = await enableVirtualAuthenticator(context);
  await page.goto("/settings/security");
  await page.getByLabel("New passkey name").fill("Virtual security key");
  await page.getByRole("button", { name: "Register passkey" }).click();
  await page.getByLabel("Current password").fill(user.password);
  await page.getByRole("button", { name: "Confirm with password" }).click();
  await expect(page.getByText("Virtual security key")).toBeVisible();

  await signOut(page);
  await page.goto("/login");
  await page.getByRole("button", { name: "Sign in with a passkey" }).click();
  await expect(page).toHaveURL("/");
  await page.goto("/settings/security");
  await page.getByRole("button", { name: "Remove passkey" }).click();
  await page.getByRole("button", { name: "Confirm with a passkey" }).click();
  await expect(page.getByText("Virtual security key")).toHaveCount(0);
  await virtual.session.send("WebAuthn.removeVirtualAuthenticator", {
    authenticatorId: virtual.authenticatorId,
  });
});

test("remember-me cookie duration, remote revocation, and reauthentication accessibility", async ({
  browser,
  page,
}) => {
  const user = identity("sessions");
  await registerAndVerify(page, user);
  await signIn(page, user, false);
  const shortCookie = (await page.context().cookies()).find((cookie) =>
    cookie.name.includes("session_token"),
  );
  expect(shortCookie?.expires).toBe(-1);
  await signOut(page);
  await signIn(page, user, true);
  const rememberedCookie = (await page.context().cookies()).find((cookie) =>
    cookie.name.includes("session_token"),
  );
  expect(rememberedCookie?.expires ?? 0).toBeGreaterThan(Date.now() / 1_000 + 86_400);

  const remoteContext = await (browser as Browser).newContext();
  const remotePage = await remoteContext.newPage();
  await signIn(remotePage, user, true);
  await page.goto("/settings/security");
  await expect(page.getByText(/\(current\)/u)).toBeVisible();
  await page.getByRole("button", { name: "Revoke session" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByLabel("Current password")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Revoke session" }).click();
  await page.getByLabel("Current password").fill("incorrect-fixture");
  await page.getByRole("button", { name: "Confirm with password" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "could not be confirmed" })).toBeVisible();
  await expect(page.getByLabel("Current password")).toHaveValue("");
  await page.getByLabel("Current password").fill(user.password);
  await page.getByRole("button", { name: "Confirm with password" }).click();
  await expect
    .poll(async () => (await remotePage.request.get(`${apiUrl}/api/v1/auth/session`)).status())
    .toBe(401);
  await remotePage.goto(`/settings/security?revoked=${Date.now()}`);
  await expect(remotePage).toHaveURL(/\/login/u);
  await remoteContext.close();
});
