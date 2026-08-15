import { randomUUID } from "node:crypto";

import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
  type Locator,
  type Page,
} from "@playwright/test";

import { latestActionLink } from "./mailpit";

/*
 * Part 60 — one browser context, one pass: comment on a selection, reply,
 * resolve, reload, then mention a member and read the notification center.
 *
 * DELIBERATELY SINGLE-CONTEXT AND WITHOUT REALTIME ASSERTIONS.
 *
 * Be precise about what that costs, because an earlier version of this comment
 * was not: NOTHING anywhere proves the browser-to-browser path — one member
 * commenting and a second member's open panel updating without a reload — end to
 * end. What exists is the two halves of it, each proved on its own side:
 *
 *   - the server half, in `apps/api/test/comments.integration.test.ts`: a reply
 *     written by one member is read back through the authorized list as another,
 *     and the write emits `realtime:comment:changed` into the note's room with
 *     that note's id;
 *   - the client half, in `src/components/notes/note-comments.test.tsx`: the
 *     panel refetches through the authorized `GET` when a frame for ITS note
 *     arrives, and ignores a frame for any other note on the same shared socket.
 *
 * The seam between them — that the frame the server emits is the frame the
 * browser is listening for — is a shared event-name constant and nothing else.
 * Closing it properly means a second live browser peer here, which would add
 * socket timing to a suite that runs chromium-only with `workers: 1`; it is a
 * known gap, not a covered case.
 *
 * SELECTORS THIS SPEC DEPENDS ON (the comment UI lands in parallel, so these
 * are the contract between the two changes):
 *   role   button   "Comment" (exact)          — start a comment on the selection
 *   role   button   /^Comments/                — open the comments panel
 *   role   button   /^Reply$/                  — open a thread's reply composer
 *   role   button   /^Resolve$/                — resolve a thread
 *   role   textbox  /comment/i, /reply/i       — the two composers
 *   text   /Resolved by /                      — the resolution label
 *   testid note-comments, comment-thread, comment-submit, comment-reply-submit
 */

const disposable = process.env.PLAYWRIGHT_DISPOSABLE_TEST_RUN === "true";
const apiUrl = process.env.PLAYWRIGHT_API_URL ?? "http://localhost:3001";
const appUrl = process.env.PLAYWRIGHT_APP_URL ?? "http://localhost:3000";
const password = "Fresh1!Password";

/** A cold Next.js dev route compiles on its first visit. */
const ROUTE_COMPILE_MS = 45_000;
/** Outbox dispatch plus the BullMQ round trip that writes the notification row. */
const NOTIFY_MS = 60_000;
/**
 * How long a DUPLICATE notification is given to show up before the count is
 * read once and asserted.
 *
 * There is no polite way around a fixed wait here: "exactly one" is a claim
 * about something that must NOT appear, and `expect.poll` resolves on its first
 * matching read, so it can only ever prove "at least one". By the time this runs
 * the first notification has already arrived, which means the whole pipeline —
 * outbox dispatcher, queue, worker, insert — has just been measured warm and
 * well inside `NOTIFY_MS`; a second job travelling the same path would land far
 * inside this window.
 */
const DUPLICATE_SETTLE_MS = 20_000;

interface Account {
  readonly name: string;
  readonly email: string;
  readonly password: string;
}

function identity(role: string): Account {
  const suffix = randomUUID();
  const emailRole = role.toLowerCase().replaceAll(/[^a-z0-9]+/gu, "-");
  return {
    name: `Comments ${role}`,
    email: `comments.${emailRole}.${suffix}@example.test`,
    password,
  };
}

async function expectOk(response: APIResponse): Promise<void> {
  expect(response.ok(), `${response.url()} returned ${response.status()}`).toBe(true);
}

/** Provision real verified auth without spending browser time on Part 9's already-covered forms. */
async function provisionAccount(request: APIRequestContext, account: Account): Promise<void> {
  const registration = await request.post(`${apiUrl}/api/auth/sign-up/email`, {
    headers: { Origin: appUrl },
    data: { ...account, callbackURL: "/verify-email?status=success" },
  });
  await expectOk(registration);

  const verification = await request.get(
    await latestActionLink(request, account.email, "Verify your Notted email"),
    { headers: { Origin: appUrl }, maxRedirects: 0 },
  );
  expect(verification.status()).toBe(302);

  await signIn(request, account);
}

/** Also used on its own to swap the browser context's session to another account. */
async function signIn(request: APIRequestContext, account: Account): Promise<void> {
  const login = await request.post(`${apiUrl}/api/auth/sign-in/email`, {
    headers: { Origin: appUrl },
    data: { email: account.email, password: account.password, rememberMe: false },
  });
  await expectOk(login);
}

async function apiPost<T>(
  request: APIRequestContext,
  path: string,
  data: unknown,
  idempotencyKey?: string,
): Promise<T> {
  const response = await request.post(`${apiUrl}${path}`, {
    headers: {
      Origin: appUrl,
      ...(idempotencyKey === undefined ? {} : { "Idempotency-Key": idempotencyKey }),
    },
    data,
  });
  await expectOk(response);
  return response.json() as Promise<T>;
}

async function apiPatch<T>(request: APIRequestContext, path: string, data: unknown): Promise<T> {
  const response = await request.patch(`${apiUrl}${path}`, {
    headers: { Origin: appUrl },
    data,
  });
  await expectOk(response);
  return response.json() as Promise<T>;
}

async function apiGet<T>(request: APIRequestContext, path: string): Promise<T> {
  const response = await request.get(`${apiUrl}${path}`);
  await expectOk(response);
  return response.json() as Promise<T>;
}

function editorBody(page: Page): Locator {
  return page.getByRole("textbox", { name: /Note content/u });
}

/**
 * The comments panel, whether it is already open (first visit, straight after
 * commenting) or has to be re-opened (after a reload). The panel and its
 * trigger are raced rather than probed blindly, so this never reads visibility
 * before the route has hydrated.
 */
async function openComments(page: Page): Promise<Locator> {
  const panel = page.getByTestId("note-comments");
  const trigger = page.getByRole("button", { name: /^Comments/u });
  await expect(panel.or(trigger).first()).toBeVisible({ timeout: ROUTE_COMPILE_MS });
  if (!(await panel.isVisible())) await trigger.click();
  await expect(panel).toBeVisible();
  return panel;
}

test.describe.serial("Part 60 inline comments and mentions", () => {
  test.skip(
    !disposable,
    "Requires the real disposable app, PostgreSQL, Redis, Mailpit, and the queue workers.",
  );

  test("comments, replies, and resolution persist, and a mention notifies exactly once", async ({
    browser,
    request,
  }) => {
    // Two verified accounts, an invitation, a hydrated collaborative editor, and
    // a queue round trip, against a dev server that compiles routes on demand.
    test.setTimeout(300_000);
    const context = await browser.newContext();
    const page = await context.newPage();
    const owner = identity("owner");
    const member = identity("member");
    const suffix = randomUUID().slice(0, 8);
    const workspaceName = `Comments ${suffix}`;
    const noteTitle = `Commented note ${suffix}`;
    const seedText = "The anchored sentence under discussion.";
    const commentText = `Is this still accurate? ${suffix}`;
    const replyText = `It is, as of today. ${suffix}`;

    try {
      await provisionAccount(page.request, owner);
      const createdWorkspace = await apiPost<{ workspace: { id: string } }>(
        page.request,
        "/api/v1/workspaces",
        {
          name: workspaceName,
          slug: `comments-${suffix}`,
          description: null,
          settings: { defaultPageSize: "a4" },
        },
        randomUUID(),
      );
      const workspaceId = createdWorkspace.workspace.id;
      const createdNote = await apiPost<{ note: { id: string; version: number } }>(
        page.request,
        `/api/v1/workspaces/${workspaceId}/notes`,
        { title: noteTitle, projectId: null, folderId: null, parentId: null },
        randomUUID(),
      );
      const noteId = createdNote.note.id;

      // Seeded through the API: this spec is about commenting on text, not
      // about re-proving Part 39/58 typing and persistence.
      await apiPatch(page.request, `/api/v1/workspaces/${workspaceId}/notes/${noteId}`, {
        expectedVersion: createdNote.note.version,
        content: {
          type: "doc",
          content: [{ type: "paragraph", content: [{ type: "text", text: seedText }] }],
        },
      });

      const notePath = `/workspaces/${workspaceId}/notes/${noteId}`;
      await page.goto(notePath);
      await expect(editorBody(page)).toBeVisible({ timeout: ROUTE_COMPILE_MS });
      await expect(editorBody(page)).toContainText(seedText, { timeout: ROUTE_COMPILE_MS });

      // 1 — select the sentence and comment on it.
      //
      // There is no separate "comment on this selection" button: the composer
      // reads `editor.state.selection` at submit time, and ProseMirror keeps
      // that selection when DOM focus moves to the textarea. So the selection
      // made here is still the anchored range when the panel's Comment button
      // is pressed below.
      await editorBody(page).locator("p").first().click({ clickCount: 3 });
      const panel = await openComments(page);
      await panel.getByRole("textbox", { name: /comment/iu }).fill(commentText);
      await panel.getByTestId("comment-submit").click();

      const thread = panel.getByTestId("comment-thread").filter({ hasText: commentText });
      await expect(thread).toHaveCount(1);

      // 2 — reply on the same thread.
      await thread.getByRole("button", { name: /^Reply$/u }).click();
      await thread.getByRole("textbox", { name: /reply/iu }).fill(replyText);
      await thread.getByTestId("comment-reply-submit").click();
      await expect(thread).toContainText(replyText);

      // 3 — resolve it. Resolution belongs to the thread, not to one comment.
      await thread.getByRole("button", { name: /^Resolve$/u }).click();
      await expect(thread).toContainText(/Resolved by /u);

      // 4 — a reload discards every client-side cache, so what survives it is
      // what the server actually stored.
      await page.reload();
      await expect(editorBody(page)).toBeVisible({ timeout: ROUTE_COMPILE_MS });
      const reloaded = await openComments(page);
      const persisted = reloaded.getByTestId("comment-thread").filter({ hasText: commentText });
      await expect(persisted).toHaveCount(1);
      await expect(persisted).toContainText(replyText);
      await expect(persisted).toContainText(new RegExp(`Resolved by ${owner.name}`, "u"));

      // 5 — mention a workspace member.
      await apiPost(page.request, `/api/v1/workspaces/${workspaceId}/invitations`, {
        email: member.email,
        role: "editor",
      });
      const invitation = new URL(
        await latestActionLink(page.request, member.email, `Join ${workspaceName}`),
      );
      const token = invitation.searchParams.get("token");
      expect(token).not.toBeNull();
      // The invitee is provisioned on the isolated `request` fixture — an API
      // context, not a second browser — so the one browser context keeps the
      // owner's session for the mention save below.
      await provisionAccount(request, member);
      await apiPost(request, "/api/v1/invitations/accept", { token });

      const members = await apiGet<{ items: readonly { userId: string; email: string }[] }>(
        page.request,
        `/api/v1/workspaces/${workspaceId}/members?page=1&limit=50`,
      );
      const recipientId = members.items.find((row) => row.email === member.email)?.userId;
      expect(recipientId).toBeDefined();

      /*
       * The mention is saved through the REST resource rather than typed into
       * the live editor. BOTH paths schedule the intent — `NotesService.update`
       * and the collaborative projection each call
       * `MentionNotificationProducer.scheduleMentionNotifications` — so this is
       * about determinism, not coverage: typing would make the assertion wait
       * on the projection debounce, which is exactly the kind of timing this
       * chromium-only, `workers:1` suite should not depend on. The projection's
       * own path is covered by the API integration test. Leaving the note page
       * first closes the collaborative session so the projection cannot race
       * this write and lose the version CAS.
       */
      await page.goto(`/workspaces/${workspaceId}`);
      /** One paragraph, saved against whatever version the note is on now. */
      const saveParagraph = async (content: readonly unknown[]): Promise<void> => {
        const current = await apiGet<{ version: number }>(
          page.request,
          `/api/v1/workspaces/${workspaceId}/notes/${noteId}`,
        );
        await apiPatch(page.request, `/api/v1/workspaces/${workspaceId}/notes/${noteId}`, {
          expectedVersion: current.version,
          content: { type: "doc", content: [{ type: "paragraph", content }] },
        });
      };
      const mentionParagraph = [
        { type: "text", text: `${seedText} ` },
        { type: "mention", attrs: { id: recipientId, label: member.name } },
      ];
      await saveParagraph(mentionParagraph);

      /*
       * 6 — remove the mention, then put it back.
       *
       * This is the only sequence that actually EXECUTES the producer's
       * `ON CONFLICT DO NOTHING` against the real unique index, and without it
       * "each mention notifies at most once" is asserted against a path that
       * never runs. `MentionNotificationProducer` gates on an in-memory diff
       * first: only ids present in the next document and absent from the
       * previous one survive, so re-saving the same document returns before
       * issuing any SQL at all. Removing the mention makes the NEXT save's
       * previous document mention-free, so the re-add passes the diff gate and
       * issues a second insert carrying the same
       * `mention-notify:<sha256(workspace, note, recipient)>` idempotency key as
       * the first — which is exactly where `job_outbox_idempotency_key_unique`
       * collapses it to nothing. Weaken that key, drop that index, or bucket it
       * by time, and the recipient is notified twice and the count below is 2.
       */
      await saveParagraph([{ type: "text", text: seedText }]);
      await saveParagraph(mentionParagraph);

      // 7 — the recipient's own notification center. The session swap keeps
      // this to one browser context.
      await signIn(page.request, member);
      const mentionCount = async (): Promise<number> => {
        const response = await page.request.get(
          `${apiUrl}/api/v1/workspaces/${workspaceId}/notifications?page=1&limit=20`,
        );
        if (!response.ok()) return -1;
        const body = (await response.json()) as { items: readonly { kind: string }[] };
        return body.items.filter((item) => item.kind === "mention").length;
      };

      // Arrival, and arrival only: `expect.poll` returns on its first matching
      // read, so `.toBe(1)` here would pass on the first of two notifications
      // and could never fail on a duplicate.
      await expect
        .poll(mentionCount, { timeout: NOTIFY_MS, intervals: [500, 1_000, 2_000] })
        .toBeGreaterThanOrEqual(1);
      // Exactly-once is a settled read, which is an assertion a duplicate can
      // fail. See `DUPLICATE_SETTLE_MS` for why the wait is fixed.
      await page.waitForTimeout(DUPLICATE_SETTLE_MS);
      expect(await mentionCount()).toBe(1);

      await page.goto(`/workspaces/${workspaceId}`);
      // The unread count is server-rendered, so the badge itself proves the
      // notification arrived unread rather than merely being listed.
      await page.getByRole("button", { name: "Notifications, 1 unread" }).click();
      const center = page.getByRole("dialog", { name: "Notifications" });
      await expect(center).toBeVisible();
      const rows = center.getByRole("list", { name: "Notification list" }).getByRole("listitem");
      await expect(rows).toHaveCount(1);
      await expect(rows.first()).toContainText(`${owner.name} mentioned you`);
      await expect(rows.first()).toContainText(noteTitle);
      // Unread rows offer "Mark read"; a read row would offer "Mark unread".
      await expect(rows.first().getByRole("button", { name: /^Mark read:/u })).toBeVisible();
    } finally {
      await context.close();
    }
  });
});
