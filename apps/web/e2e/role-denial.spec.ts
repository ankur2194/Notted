import { randomUUID } from "node:crypto";

import {
  expect,
  test,
  type APIRequestContext,
  type BrowserContext,
  type Page,
} from "@playwright/test";

import {
  API_URL,
  APP_URL,
  createWorkspace,
  identity,
  inviteAndJoin,
  registerAndSignIn,
  type Account,
  type InvitableRole,
} from "./accounts";

/**
 * Part 75: server-side role denial.
 *
 * The gap this closes: today every role denial in the browser suite is asserted
 * as a UI *affordance* — a button hidden or disabled inside one of five large
 * journey tests. Nothing asserts that the SERVER refuses when the UI is
 * bypassed, which is the only assertion that matters, because a hidden button
 * is a convenience and an API is the boundary.
 *
 * So this spec drives `page.request` exclusively. No clicking, no navigation:
 * the session cookies are real, the requests are the ones a hostile client
 * would send, and the whole thing runs in seconds rather than minutes.
 *
 * The **403-vs-404 split is the load-bearing assertion**. `docs/authorization.md`
 * promises that a cross-tenant or guessed identifier is concealed as `404`
 * while a known same-tenant permission failure is `403`. Collapsing those two
 * is a silent tenant-existence oracle that every layer below would still call
 * "denied", so it is asserted end to end here and nowhere else.
 *
 * Status codes are asserted **exactly**. "Not 2xx" would let a `429` from a
 * rate limiter masquerade as an authorization decision — the `e2e` Compose
 * profile raises the limits precisely so the five identities below cannot trip
 * one, but the assertion must not depend on that holding.
 */

const disposable = process.env.PLAYWRIGHT_DISPOSABLE_TEST_RUN === "true";

/**
 * Every REST operation this spec asserts against, as an OpenAPI path template.
 *
 * A wrong path returns `404` — which is a *passing* result for half the
 * assertions below, so route drift would silently hollow this spec out. The
 * first test checks the list against the document the running API serves, so a
 * renamed route fails loudly instead.
 */
const ROUTES: readonly (readonly [string, string])[] = [
  ["post", "/api/v1/workspaces/{workspaceId}/notes"],
  ["get", "/api/v1/workspaces/{workspaceId}/notes/{noteId}"],
  ["patch", "/api/v1/workspaces/{workspaceId}/notes/{noteId}"],
  ["delete", "/api/v1/workspaces/{workspaceId}/notes/{noteId}"],
  ["post", "/api/v1/workspaces/{workspaceId}/projects"],
  ["post", "/api/v1/workspaces/{workspaceId}/tasks"],
  ["patch", "/api/v1/workspaces/{id}"],
  ["delete", "/api/v1/workspaces/{id}"],
  ["post", "/api/v1/workspaces/{workspaceId}/invitations"],
  ["post", "/api/v1/workspaces/{workspaceId}/api-keys"],
  ["get", "/api/v1/workspaces/{workspaceId}/audit-logs"],
  ["get", "/api/v1/workspaces/{workspaceId}/members"],
  ["patch", "/api/v1/workspaces/{workspaceId}/members/{memberId}"],
  // Part 78 (R31): the rest of the workspace-scoped surface. Before these, the
  // HTTP-level cross-tenant proof covered notes and members only — every other
  // resource's 403-vs-404 split rested on service tests alone.
  ["get", "/api/v1/workspaces/{workspaceId}/tasks"],
  ["get", "/api/v1/workspaces/{workspaceId}/tasks/{taskId}"],
  ["get", "/api/v1/workspaces/{workspaceId}/projects"],
  ["get", "/api/v1/workspaces/{workspaceId}/projects/{projectId}"],
  ["get", "/api/v1/workspaces/{workspaceId}/tags"],
  ["delete", "/api/v1/workspaces/{workspaceId}/tags/{tagId}"],
  ["get", "/api/v1/workspaces/{workspaceId}/folders"],
  ["delete", "/api/v1/workspaces/{workspaceId}/folders/{folderId}"],
  ["get", "/api/v1/workspaces/{workspaceId}/exports"],
  ["get", "/api/v1/workspaces/{workspaceId}/exports/{exportId}"],
  ["get", "/api/v1/workspaces/{workspaceId}/webhooks"],
  ["delete", "/api/v1/workspaces/{workspaceId}/webhooks/{webhookId}"],
  ["get", "/api/v1/workspaces/{workspaceId}/api-keys"],
  ["delete", "/api/v1/workspaces/{workspaceId}/api-keys/{apiKeyId}"],
  ["delete", "/api/v1/workspaces/{workspaceId}/attachments/{attachmentId}"],
  ["get", "/api/v1/workspaces/{workspaceId}/task-statuses"],
  ["get", "/api/v1/workspaces/{workspaceId}/storage"],
  ["get", "/api/v1/workspaces/{workspaceId}/search"],
  ["get", "/api/v1/workspaces/{workspaceId}/notifications"],
  ["get", "/api/v1/workspaces/{workspaceId}/invitations"],
  ["get", "/api/v1/workspaces/{workspaceId}/notes/{noteId}/attachments"],
  ["get", "/api/v1/workspaces/{workspaceId}/notes/{noteId}/comments"],
  ["get", "/api/v1/workspaces/{workspaceId}/notes/{noteId}/versions"],
  ["get", "/api/v1/workspaces/{workspaceId}/notes/{noteId}/shares"],
];

type Method = "get" | "post" | "patch" | "delete";

type Role = "owner" | "admin" | "editor" | "viewer" | "stranger";

const ROLES: readonly Role[] = ["owner", "admin", "editor", "viewer", "stranger"];
const INVITED_ROLES: readonly InvitableRole[] = ["admin", "editor", "viewer"];

interface Attempt {
  readonly what: string;
  readonly method: Method;
  readonly path: string;
  readonly data?: unknown;
}

/** Only the fields `expectNoLeak` reads; the raw body covers the rest. */
interface ErrorEnvelope {
  readonly success?: unknown;
  readonly error?: { readonly code?: unknown };
  readonly requestId?: unknown;
}

async function send(
  request: APIRequestContext,
  attempt: Attempt,
): Promise<{ readonly status: number; readonly body: string }> {
  const url = `${API_URL}${attempt.path}`;
  const options = {
    headers: { Origin: APP_URL, "Idempotency-Key": randomUUID() },
    ...(attempt.data === undefined ? {} : { data: attempt.data }),
  };
  const response =
    attempt.method === "get"
      ? await request.get(url, options)
      : attempt.method === "post"
        ? await request.post(url, options)
        : attempt.method === "patch"
          ? await request.patch(url, options)
          : await request.delete(url, options);
  return { status: response.status(), body: await response.text() };
}

/** Asserts an exact status and returns the body for leak inspection. */
async function expectStatus(
  request: APIRequestContext,
  attempt: Attempt,
  expected: number,
): Promise<string> {
  const { status, body } = await send(request, attempt);
  expect(status, `${attempt.what}: ${attempt.method.toUpperCase()} ${attempt.path}`).toBe(expected);
  return body;
}

/**
 * A denial body may name the *outcome* and nothing else.
 *
 * The whole raw body is scanned, not just the message: `details` is optional in
 * the envelope and a future error path could put the leak there. The forbidden
 * strings are what a naive error path actually leaks — the SQL that decided it,
 * the table it decided against, and any word that confirms whether the row or
 * the membership exists.
 *
 * Deliberately NOT forbidden: the role names. A message naming a role discloses
 * nothing a member cannot already read from `GET /members`, and banning them
 * would fail on any reasonable future wording.
 */
function expectNoLeak(body: string, what: string): void {
  const envelope = JSON.parse(body) as ErrorEnvelope;
  expect(envelope.success, `${what}: envelope shape`).toBe(false);
  expect(typeof envelope.error?.code, `${what}: error code`).toBe("string");
  expect(typeof envelope.requestId, `${what}: request id`).toBe("string");

  const haystack = body.toLowerCase();
  for (const forbidden of [
    "select ",
    "insert into",
    "update set",
    "delete from",
    " join ",
    "where ",
    "workspace_members",
    "workspace_id",
    "membership",
    "not a member",
    "does not exist",
    "already exists",
    "permission denied for",
    "postgres",
    "drizzle",
  ]) {
    expect(haystack, `${what}: body leaks "${forbidden}"`).not.toContain(forbidden);
  }
}

test.describe.serial("Part 75 server-side role denial", () => {
  test.skip(
    !disposable,
    "role denial requires PLAYWRIGHT_DISPOSABLE_TEST_RUN=true with disposable PostgreSQL, Redis, and Mailpit",
  );

  const suffix = randomUUID().slice(0, 8);
  const workspaceName = `Denial Tenant ${suffix}`;
  const strangerWorkspaceName = `Stranger Tenant ${suffix}`;

  const contexts: BrowserContext[] = [];
  const pages: Partial<Record<Role, Page>> = {};

  /** Narrows away the `Partial`, and fails loudly if provisioning was skipped. */
  function pageFor(role: Role): Page {
    const page = pages[role];
    if (page === undefined) throw new Error(`the ${role} page was never provisioned`);
    return page;
  }

  let workspaceId = "";
  let strangerWorkspaceId = "";
  let noteId = "";
  let ownerMemberId = "";

  test.beforeAll(async ({ browser }) => {
    // Five verified accounts, three invitations, a workspace and a note, all
    // through the API — but Mailpit polling is the slow part, so give it room.
    test.setTimeout(180_000);

    const accounts: Record<Role, Account> = {
      owner: identity("denial-owner"),
      admin: identity("denial-admin"),
      editor: identity("denial-editor"),
      viewer: identity("denial-viewer"),
      stranger: identity("denial-stranger"),
    };

    for (const role of ROLES) {
      const context = await browser.newContext();
      contexts.push(context);
      const page = await context.newPage();
      pages[role] = page;
      await registerAndSignIn(page, accounts[role]);
    }

    workspaceId = await createWorkspace(pageFor("owner"), workspaceName);
    strangerWorkspaceId = await createWorkspace(pageFor("stranger"), strangerWorkspaceName);

    for (const role of INVITED_ROLES) {
      await inviteAndJoin(
        pageFor("owner"),
        pageFor(role),
        workspaceId,
        workspaceName,
        accounts[role],
        role,
      );
    }

    const created = await pageFor("owner").request.post(
      `${API_URL}/api/v1/workspaces/${workspaceId}/notes`,
      {
        headers: { Origin: APP_URL, "Idempotency-Key": randomUUID() },
        data: {
          title: `Denial subject ${suffix}`,
          projectId: null,
          folderId: null,
          parentId: null,
        },
      },
    );
    expect(created.ok(), `note create → ${created.status()}`).toBe(true);
    noteId = ((await created.json()) as { note: { id: string } }).note.id;

    const members = await pageFor("owner").request.get(
      `${API_URL}/api/v1/workspaces/${workspaceId}/members`,
      { headers: { Origin: APP_URL } },
    );
    expect(members.ok(), `member list → ${members.status()}`).toBe(true);
    const page = (await members.json()) as {
      items: { id: string; role: string; email: string }[];
    };
    const owner = page.items.find((member) => member.role === "owner");
    if (owner === undefined) throw new Error("the workspace creator is not listed as its owner");
    ownerMemberId = owner.id;
  });

  test.afterAll(async () => {
    await Promise.all(contexts.map((context) => context.close()));
  });

  test("every route this spec asserts still exists in the served OpenAPI document", async () => {
    const response = await pageFor("owner").request.get(`${API_URL}/api/v1/openapi.json`);
    expect(response.ok(), `openapi.json → ${response.status()}`).toBe(true);
    const document = (await response.json()) as { paths: Record<string, Record<string, unknown>> };

    for (const [method, path] of ROUTES) {
      expect(
        document.paths[path]?.[method],
        `${method.toUpperCase()} ${path} is gone from the API; the denial assertions that use ` +
          `it would now pass on a plain 404`,
      ).toBeDefined();
    }
  });

  test("a viewer may read but is refused every write and the audit trail", async () => {
    // Positive control first: without it a wall of 403s could equally mean the
    // viewer's session never worked.
    await expectStatus(
      pageFor("viewer").request,
      {
        what: "viewer reads the note",
        method: "get",
        path: `/api/v1/workspaces/${workspaceId}/notes/${noteId}`,
      },
      200,
    );

    const denied: readonly Attempt[] = [
      {
        what: "viewer creates a note",
        method: "post",
        path: `/api/v1/workspaces/${workspaceId}/notes`,
        data: { title: "Nope", projectId: null, folderId: null, parentId: null },
      },
      {
        what: "viewer patches a note",
        method: "patch",
        path: `/api/v1/workspaces/${workspaceId}/notes/${noteId}`,
        data: { expectedVersion: 1, title: "Nope" },
      },
      {
        what: "viewer creates a project",
        method: "post",
        path: `/api/v1/workspaces/${workspaceId}/projects`,
        data: { name: "Nope" },
      },
      {
        what: "viewer creates a task",
        method: "post",
        path: `/api/v1/workspaces/${workspaceId}/tasks`,
        data: { title: "Nope" },
      },
      {
        what: "viewer patches workspace settings",
        method: "patch",
        path: `/api/v1/workspaces/${workspaceId}`,
        data: { name: `Hijacked ${suffix}` },
      },
      {
        what: "viewer invites a member",
        method: "post",
        path: `/api/v1/workspaces/${workspaceId}/invitations`,
        data: { email: `nope.${randomUUID()}@example.test`, role: "admin" },
      },
      {
        what: "viewer reads the audit log",
        method: "get",
        path: `/api/v1/workspaces/${workspaceId}/audit-logs`,
      },
    ];

    for (const attempt of denied) {
      expectNoLeak(await expectStatus(pageFor("viewer").request, attempt, 403), attempt.what);
    }
  });

  test("an editor is refused deletes, projects, settings, invitations and API keys", async () => {
    const denied: readonly Attempt[] = [
      {
        what: "editor deletes a note",
        method: "delete",
        path: `/api/v1/workspaces/${workspaceId}/notes/${noteId}`,
        data: { expectedVersion: 1 },
      },
      {
        what: "editor creates a project",
        method: "post",
        path: `/api/v1/workspaces/${workspaceId}/projects`,
        data: { name: "Nope" },
      },
      {
        what: "editor patches workspace settings",
        method: "patch",
        path: `/api/v1/workspaces/${workspaceId}`,
        data: { name: `Hijacked ${suffix}` },
      },
      {
        what: "editor invites a member",
        method: "post",
        path: `/api/v1/workspaces/${workspaceId}/invitations`,
        data: { email: `nope.${randomUUID()}@example.test`, role: "admin" },
      },
      {
        what: "editor creates an API key",
        method: "post",
        path: `/api/v1/workspaces/${workspaceId}/api-keys`,
        data: { name: `Nope ${suffix}` },
      },
    ];

    for (const attempt of denied) {
      expectNoLeak(await expectStatus(pageFor("editor").request, attempt, 403), attempt.what);
    }

    // The note survived the refused delete — a 403 that still deleted the row
    // would satisfy every assertion above.
    await expectStatus(
      pageFor("owner").request,
      {
        what: "owner still reads the note",
        method: "get",
        path: `/api/v1/workspaces/${workspaceId}/notes/${noteId}`,
      },
      200,
    );
  });

  test("an admin may change settings but cannot delete the workspace or demote an owner", async () => {
    await expectStatus(
      pageFor("admin").request,
      {
        what: "admin updates settings",
        method: "patch",
        path: `/api/v1/workspaces/${workspaceId}`,
        data: { description: `Administered ${suffix}` },
      },
      200,
    );

    const denied: readonly Attempt[] = [
      {
        what: "admin deletes the workspace",
        method: "delete",
        path: `/api/v1/workspaces/${workspaceId}`,
        data: { confirm: true, expectedName: workspaceName },
      },
      {
        what: "admin demotes the owner",
        method: "patch",
        path: `/api/v1/workspaces/${workspaceId}/members/${ownerMemberId}`,
        data: { role: "viewer" },
      },
    ];

    for (const attempt of denied) {
      expectNoLeak(await expectStatus(pageFor("admin").request, attempt, 403), attempt.what);
    }
  });

  /*
   * Part 78 (R31). The HTTP-level cross-tenant proof used to cover notes and
   * members only; every other workspace-scoped resource's concealment rested on
   * service tests, which cannot see a transport that authorizes differently.
   *
   * The rule under test is one sentence: a caller with no membership must never
   * receive 2xx from a workspace-scoped route, and must not be told the
   * difference between "forbidden" and "no such workspace".
   *
   * **If any of these answers 403 rather than 404, that is a real
   * tenant-existence oracle and a defect in the API — fix the API, do not adjust
   * the expectation here.** A 200 with an empty body is equally a failure: it
   * confirms the workspace resolves.
   */
  test("no workspace-scoped resource answers a non-member with anything but 404", async () => {
    const foreign: readonly Attempt[] = [
      { what: "tasks", method: "get", path: `/api/v1/workspaces/${workspaceId}/tasks` },
      { what: "projects", method: "get", path: `/api/v1/workspaces/${workspaceId}/projects` },
      { what: "tags", method: "get", path: `/api/v1/workspaces/${workspaceId}/tags` },
      { what: "folders", method: "get", path: `/api/v1/workspaces/${workspaceId}/folders` },
      { what: "exports", method: "get", path: `/api/v1/workspaces/${workspaceId}/exports` },
      { what: "webhooks", method: "get", path: `/api/v1/workspaces/${workspaceId}/webhooks` },
      { what: "api keys", method: "get", path: `/api/v1/workspaces/${workspaceId}/api-keys` },
      { what: "audit logs", method: "get", path: `/api/v1/workspaces/${workspaceId}/audit-logs` },
      {
        what: "task statuses",
        method: "get",
        path: `/api/v1/workspaces/${workspaceId}/task-statuses`,
      },
      { what: "storage usage", method: "get", path: `/api/v1/workspaces/${workspaceId}/storage` },
      {
        what: "invitations",
        method: "get",
        path: `/api/v1/workspaces/${workspaceId}/invitations`,
      },
      {
        what: "notifications",
        method: "get",
        path: `/api/v1/workspaces/${workspaceId}/notifications`,
      },
      {
        what: "search",
        method: "get",
        path: `/api/v1/workspaces/${workspaceId}/search?q=denial`,
      },
      {
        what: "note attachments",
        method: "get",
        path: `/api/v1/workspaces/${workspaceId}/notes/${noteId}/attachments`,
      },
      {
        what: "note comments",
        method: "get",
        path: `/api/v1/workspaces/${workspaceId}/notes/${noteId}/comments`,
      },
      {
        what: "note versions",
        method: "get",
        path: `/api/v1/workspaces/${workspaceId}/notes/${noteId}/versions`,
      },
      {
        what: "note shares",
        method: "get",
        path: `/api/v1/workspaces/${workspaceId}/notes/${noteId}/shares`,
      },
    ];

    for (const attempt of foreign) {
      const what = `stranger reads another tenant's ${attempt.what}`;
      expectNoLeak(
        await expectStatus(pageFor("stranger").request, { ...attempt, what }, 404),
        what,
      );
    }
  });

  /*
   * The other half of the same rule, and the half a membership check alone does
   * not give you: inside a workspace the caller DOES belong to, an identifier
   * that names nothing must be 404 too.
   *
   * Every probe runs as the **owner** deliberately. An owner is refused nothing
   * by role, so a non-404 here can only mean the resource lookup leaked — with a
   * lesser role, a 403 would be an honest answer about the role and would prove
   * nothing about concealment. `delete` is the verb wherever the item path has
   * no `get`, because it carries no body and so cannot fail validation first.
   */
  test("an identifier that names nothing inside your own workspace is 404", async () => {
    const missing: readonly Attempt[] = [
      {
        what: "task",
        method: "get",
        path: `/api/v1/workspaces/${workspaceId}/tasks/${randomUUID()}`,
      },
      {
        what: "project",
        method: "get",
        path: `/api/v1/workspaces/${workspaceId}/projects/${randomUUID()}`,
      },
      {
        what: "export",
        method: "get",
        path: `/api/v1/workspaces/${workspaceId}/exports/${randomUUID()}`,
      },
      {
        what: "tag",
        method: "delete",
        path: `/api/v1/workspaces/${workspaceId}/tags/${randomUUID()}`,
      },
      {
        what: "folder",
        method: "delete",
        path: `/api/v1/workspaces/${workspaceId}/folders/${randomUUID()}`,
      },
      {
        what: "webhook",
        method: "delete",
        path: `/api/v1/workspaces/${workspaceId}/webhooks/${randomUUID()}`,
      },
      {
        what: "attachment",
        method: "delete",
        path: `/api/v1/workspaces/${workspaceId}/attachments/${randomUUID()}`,
      },
      {
        what: "api key",
        method: "delete",
        path: `/api/v1/workspaces/${workspaceId}/api-keys/${randomUUID()}`,
      },
    ];

    for (const attempt of missing) {
      const what = `owner guesses a ${attempt.what} id`;
      expectNoLeak(await expectStatus(pageFor("owner").request, { ...attempt, what }, 404), what);
    }
  });

  test("cross-tenant and guessed identifiers are concealed as 404, never 403", async () => {
    // The distinction this whole spec exists for: a permission failure the
    // caller is entitled to know about is 403; anything that would confirm the
    // existence of a row the caller cannot see is 404.
    const concealed: readonly (readonly [APIRequestContext, Attempt])[] = [
      [
        pageFor("stranger").request,
        {
          what: "stranger reads a note in another tenant",
          method: "get",
          path: `/api/v1/workspaces/${workspaceId}/notes/${noteId}`,
        },
      ],
      [
        pageFor("stranger").request,
        {
          what: "stranger reads another tenant's members",
          method: "get",
          path: `/api/v1/workspaces/${workspaceId}/members`,
        },
      ],
      [
        pageFor("viewer").request,
        {
          what: "member guesses a note id inside their own workspace",
          method: "get",
          path: `/api/v1/workspaces/${workspaceId}/notes/${randomUUID()}`,
        },
      ],
      [
        pageFor("owner").request,
        {
          what: "owner probes a workspace id that is not theirs",
          method: "get",
          path: `/api/v1/workspaces/${strangerWorkspaceId}/notes/${randomUUID()}`,
        },
      ],
    ];

    for (const [request, attempt] of concealed) {
      expectNoLeak(await expectStatus(request, attempt, 404), attempt.what);
    }

    // And the same identifier the stranger was refused with 404 resolves for a
    // member — proving the 404 is concealment, not a broken route.
    await expectStatus(
      pageFor("owner").request,
      {
        what: "owner reads the same note",
        method: "get",
        path: `/api/v1/workspaces/${workspaceId}/notes/${noteId}`,
      },
      200,
    );
  });
});
