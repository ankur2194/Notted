import { randomUUID } from "node:crypto";

import { expect, type APIRequestContext, type APIResponse, type Page } from "@playwright/test";

import { latestActionLink } from "./mailpit";

/**
 * Shared account, workspace, and membership fixtures for Playwright specs.
 *
 * NOT a `*.spec.ts`: `playwright.config.ts` would collect it as a test file.
 * Follows the `./mailpit.ts` precedent — plain module, no `test.*` calls.
 *
 * **New specs import this.** Existing specs keep their own copies on purpose:
 * they diverged for real reasons (503 route injection, focus-order assertions,
 * passkey and OAuth variants, deliberate UI-form coverage of the registration
 * screens), and a rewrite would trade working browser coverage for tidiness.
 * Migrate one only when it is already being edited for another reason.
 *
 * Provisioning here is API-driven, like `collaboration.spec.ts` — the sign-up
 * and sign-in *forms* are already covered by `auth.spec.ts`, so a spec about
 * something else should not spend browser time re-proving them. The session
 * cookie lands in the browser context's jar either way, so `page.goto` after
 * `registerAndSignIn` is authenticated exactly as a form login would be.
 */

export const APP_URL = process.env.PLAYWRIGHT_APP_URL ?? "http://localhost:3000";
export const API_URL = process.env.PLAYWRIGHT_API_URL ?? "http://localhost:3001";

/** Meets the password policy; shared because no spec varies it. */
const PASSWORD = "Fresh1!Password";

export interface Account {
  readonly name: string;
  readonly email: string;
  readonly password: string;
}

/** Roles an invitation can grant. `owner` is held by the creator, not invited. */
export type InvitableRole = "admin" | "editor" | "viewer";

/**
 * A fresh identity, unique per call.
 *
 * The UUID suffix is what makes a spec safe against a database that already
 * holds rows from an earlier run, so never drop it.
 */
export function identity(label: string): Account {
  const slug = label.toLowerCase().replaceAll(/[^a-z0-9]+/gu, "-");
  return {
    name: `Notted ${label}`,
    email: `${slug}.${randomUUID()}@example.test`,
    password: PASSWORD,
  };
}

async function expectOk(response: APIResponse): Promise<void> {
  // Playwright's `APIResponse` exposes no request handle, so the message is
  // built from what the response itself carries.
  expect(response.ok(), `${response.status()} ${response.url()}`).toBe(true);
}

async function post<T>(
  request: APIRequestContext,
  path: string,
  data: unknown,
  idempotencyKey?: string,
): Promise<T> {
  const response = await request.post(`${API_URL}${path}`, {
    headers: {
      Origin: APP_URL,
      ...(idempotencyKey === undefined ? {} : { "Idempotency-Key": idempotencyKey }),
    },
    data,
  });
  await expectOk(response);
  return response.json() as Promise<T>;
}

/**
 * Register, verify through Mailpit, and sign in — leaving `page` authenticated.
 *
 * The verification link is fetched with `maxRedirects: 0` because the handler
 * answers 302 to `/verify-email?status=success`; following it would need the
 * web app to be warm and proves nothing extra.
 */
export async function registerAndSignIn(page: Page, account: Account): Promise<Account> {
  await expectOk(
    await page.request.post(`${API_URL}/api/auth/sign-up/email`, {
      headers: { Origin: APP_URL },
      data: { ...account, callbackURL: "/verify-email?status=success" },
    }),
  );

  const verification = await page.request.get(
    await latestActionLink(page.request, account.email, "Verify your Notted email"),
    { headers: { Origin: APP_URL }, maxRedirects: 0 },
  );
  expect(verification.status()).toBe(302);

  await expectOk(
    await page.request.post(`${API_URL}/api/auth/sign-in/email`, {
      headers: { Origin: APP_URL },
      data: { email: account.email, password: account.password, rememberMe: false },
    }),
  );
  return account;
}

/** Creates a workspace owned by `page`'s account and returns its id. */
export async function createWorkspace(page: Page, name: string): Promise<string> {
  const created = await post<{ workspace: { id: string } }>(
    page.request,
    "/api/v1/workspaces",
    {
      name,
      slug: `ws-${randomUUID().slice(0, 12)}`,
      description: null,
      settings: { defaultPageSize: "a4" },
    },
    randomUUID(),
  );
  return created.workspace.id;
}

/**
 * Invites `account` into `workspaceId` at `role` and accepts on `member`'s
 * behalf. `member` must already be registered and signed in.
 *
 * `workspaceName` is required because the invitation subject is
 * `Join <workspace name>`, and since Part 61 a mailbox also holds a welcome
 * email — an unfiltered lookup would hand back the wrong link.
 */
export async function inviteAndJoin(
  owner: Page,
  member: Page,
  workspaceId: string,
  workspaceName: string,
  account: Account,
  role: InvitableRole,
): Promise<void> {
  await post(owner.request, `/api/v1/workspaces/${workspaceId}/invitations`, {
    email: account.email,
    role,
  });
  const invitation = new URL(
    await latestActionLink(owner.request, account.email, `Join ${workspaceName}`),
  );
  const token = invitation.searchParams.get("token");
  expect(token, "invitation email did not carry a token").not.toBeNull();
  await post(member.request, "/api/v1/invitations/accept", { token });
}
