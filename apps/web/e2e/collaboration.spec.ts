import { randomUUID } from "node:crypto";

import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
  type BrowserContext,
  type Page,
} from "@playwright/test";

import { latestActionLink } from "./mailpit";

const disposable = process.env.PLAYWRIGHT_DISPOSABLE_TEST_RUN === "true";
const apiUrl = process.env.PLAYWRIGHT_API_URL ?? "http://localhost:3001";
const appUrl = process.env.PLAYWRIGHT_APP_URL ?? "http://localhost:3000";
const password = "Fresh1!Password";

/** A cold Next.js dev route compiles on its first visit. */
const ROUTE_COMPILE_MS = 45_000;
/** Socket handshake, document load, and the first sync round trip. */
const SYNC_MS = 45_000;
/** Two CRDT peers exchanging updates through the gateway. */
const CONVERGE_MS = 45_000;
/**
 * The server projects the collaborative document into `notes.content` on a ~2s
 * trailing debounce with a 30s maximum wait, so a durable read has to be given
 * the worst case plus a round trip rather than a fixed sleep.
 */
const PROJECTION_MS = 75_000;

interface Account {
  readonly name: string;
  readonly email: string;
  readonly password: string;
}

interface NoteRow {
  readonly id: string;
  readonly title: string;
  readonly version: number;
  readonly content: unknown;
}

interface VersionRow {
  readonly id: string;
  readonly version: number;
}

function identity(role: string): Account {
  const suffix = randomUUID();
  const emailRole = role.toLowerCase().replaceAll(/[^a-z0-9]+/gu, "-");
  return {
    name: `Collab ${role}`,
    email: `collab.${emailRole}.${suffix}@example.test`,
    password,
  };
}

async function expectOk(response: APIResponse): Promise<void> {
  expect(response.ok(), `${response.url()} returned ${response.status()}`).toBe(true);
}

/** Provision real verified auth without spending browser time on Part 9's already-covered forms. */
async function provisionAccount(page: Page, account: Account): Promise<void> {
  const registration = await page.request.post(`${apiUrl}/api/auth/sign-up/email`, {
    headers: { Origin: appUrl },
    data: { ...account, callbackURL: "/verify-email?status=success" },
  });
  await expectOk(registration);

  const verification = await page.request.get(
    await latestActionLink(page.request, account.email, "Verify your Notted email"),
    { headers: { Origin: appUrl }, maxRedirects: 0 },
  );
  expect(verification.status()).toBe(302);

  const login = await page.request.post(`${apiUrl}/api/auth/sign-in/email`, {
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

async function joinWorkspaceAsEditor(
  owner: Page,
  member: Page,
  workspaceId: string,
  workspaceName: string,
  account: Account,
): Promise<void> {
  await provisionAccount(member, account);
  await apiPost(owner.request, `/api/v1/workspaces/${workspaceId}/invitations`, {
    email: account.email,
    role: "editor",
  });
  const invitation = new URL(
    await latestActionLink(owner.request, account.email, `Join ${workspaceName}`),
  );
  const token = invitation.searchParams.get("token");
  expect(token).not.toBeNull();
  await apiPost(member.request, "/api/v1/invitations/accept", { token });
}

function editorBody(page: Page) {
  return page.getByRole("textbox", { name: /Note content/u });
}

function collabStatus(page: Page) {
  return page.getByTestId("note-collab-status");
}

/**
 * The whitespace-normalised text of the editor. Convergence is an equality
 * check between two peers, so both sides have to be read the same way and
 * ProseMirror's block boundaries must not decide the answer.
 *
 * The remote-caret chrome is stripped first, and that is load-bearing rather
 * than tidy: `createCursorRenderer` mounts each peer's caret and NAME CHIP
 * inside the contenteditable, so a plain text read of the editor returns the
 * document plus the other peer's display name — a different name on each side,
 * which would make two perfectly converged peers compare unequal forever.
 *
 * ponytail: the surviving text nodes are joined with a space, so block
 * boundaries collapse rather than being preserved. Every note in this suite is
 * one paragraph, so nothing here can tell the difference. Upgrade path: read
 * per-block text if a scenario ever needs to assert across paragraphs.
 */
async function editorText(page: Page): Promise<string> {
  const raw = await editorBody(page).evaluate((node) => {
    const clone = node.cloneNode(true) as HTMLElement;
    for (const caret of clone.querySelectorAll(".notted-presence-caret")) caret.remove();
    return clone.textContent ?? "";
  });
  return raw.replaceAll(/\s+/gu, " ").trim();
}

/** Every character of `value`, counted, with whitespace ignored. */
function characterCounts(value: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const character of value.replaceAll(/\s/gu, ""))
    counts.set(character, (counts.get(character) ?? 0) + 1);
  return counts;
}

/**
 * Whether `text` still contains every character of every expected fragment,
 * counting multiplicity.
 *
 * Why not `text.includes(token)`: both peers type into the SAME insertion point
 * with their keystrokes round-tripping through the gateway between presses, so
 * by the time peer B types its second character it has already received peer A's
 * first and inserts after it. The two tokens genuinely interleave, and a
 * contiguous-substring assertion then fails for a reason that has nothing to do
 * with convergence. Character counts do not care about order, and they still
 * cannot be satisfied by a document that LOST an edit — which is the property
 * these tests exist to prove. Paired with an equality check between the two
 * peers' documents, that is convergence plus no-lost-edits, stated exactly.
 */
function containsEveryCharacter(text: string, fragments: readonly string[]): boolean {
  const available = characterCounts(text);
  for (const [character, needed] of characterCounts(fragments.join(""))) {
    if ((available.get(character) ?? 0) < needed) return false;
  }
  return true;
}

/** Concatenated text of a persisted TipTap document, in document order. */
function documentText(content: unknown): string {
  if (typeof content !== "object" || content === null) return "";
  const node = content as { readonly text?: unknown; readonly content?: unknown };
  if (typeof node.text === "string") return node.text;
  return Array.isArray(node.content) ? node.content.map(documentText).join(" ") : "";
}

async function expectCollabStatus(
  page: Page,
  value: string | RegExp,
  timeout = SYNC_MS,
): Promise<void> {
  await expect(collabStatus(page)).toHaveAttribute("data-collab-status", value, { timeout });
}

/**
 * Put the caret at the end of the note's single seeded paragraph.
 *
 * Every scenario deliberately edits the *same* paragraph, so the caret is
 * placed on that paragraph rather than wherever a click on the tall paper
 * container happens to map. The tokens are kept short precisely so the
 * paragraph never wraps and `End` therefore lands past the last token rather
 * than at the end of a visual line in the middle of the text.
 */
async function focusSharedParagraphEnd(page: Page): Promise<void> {
  await editorBody(page).locator("p").first().click();
  await page.keyboard.press("End");
}

/**
 * The polite region that announces an epoch reset to a live collaborator.
 *
 * It is a region of its own, separate from the connection-status region: the
 * two say different things and a reset must not be swallowed by a
 * `connecting -> synced` rewrite happening in the same instant. It is mounted
 * empty for the whole session, because a live region created together with its
 * text is frequently not announced at all.
 */
function collabNotice(page: Page) {
  return page.getByTestId("note-collab-notice");
}

test.describe.serial("Part 58 real-stack collaborative editing", () => {
  test.skip(
    !disposable,
    "collaborative editing requires PLAYWRIGHT_DISPOSABLE_TEST_RUN=true with disposable PostgreSQL, Redis, and Mailpit",
  );

  const suffix = randomUUID().slice(0, 8);
  const workspaceName = `Collab ${suffix}`;
  const noteTitle = `Collaborative note ${suffix}`;
  const seedText = "Seed.";
  /* Short, unique, and space-prefixed so an append never fuses with a neighbour. */
  const liveA = ` a1-${randomUUID().slice(0, 6)}`;
  const liveB = ` b1-${randomUUID().slice(0, 6)}`;
  const offlineA = ` a2-${randomUUID().slice(0, 6)}`;
  const offlineB = ` b2-${randomUUID().slice(0, 6)}`;

  let contextA: BrowserContext;
  let contextB: BrowserContext;
  let pageA: Page;
  let pageB: Page;
  let workspaceId = "";
  let noteId = "";
  let seedVersion = 0;
  let notePath = "";

  test.beforeAll(async ({ browser }) => {
    // Two verified accounts, an invitation, a note share and two hydrated
    // editors, all against a dev server that compiles routes on first visit.
    test.setTimeout(300_000);
    contextA = await browser.newContext();
    contextB = await browser.newContext();
    pageA = await contextA.newPage();
    pageB = await contextB.newPage();
    const accountB = identity("editor");

    await provisionAccount(pageA, identity("owner"));
    const createdWorkspace = await apiPost<{ workspace: { id: string } }>(
      pageA.request,
      "/api/v1/workspaces",
      {
        name: workspaceName,
        slug: `collab-${suffix}`,
        description: null,
        settings: { defaultPageSize: "a4" },
      },
      randomUUID(),
    );
    workspaceId = createdWorkspace.workspace.id;

    const createdNote = await apiPost<{ note: NoteRow }>(
      pageA.request,
      `/api/v1/workspaces/${workspaceId}/notes`,
      { title: noteTitle, projectId: null, folderId: null, parentId: null },
      randomUUID(),
    );
    noteId = createdNote.note.id;
    notePath = `/workspaces/${workspaceId}/notes/${noteId}`;

    /*
     * The note is given real content through the API before any browser opens
     * it. Seeding by typing would prove nothing about the case this suite
     * exists to guard: an empty collaborative document being loaded over a
     * note that already had content, and persisting that emptiness.
     */
    const seeded = await apiPatch<{ note: NoteRow }>(
      pageA.request,
      `/api/v1/workspaces/${workspaceId}/notes/${noteId}`,
      {
        expectedVersion: createdNote.note.version,
        content: {
          type: "doc",
          content: [{ type: "paragraph", content: [{ type: "text", text: seedText }] }],
        },
      },
    );
    seedVersion = seeded.note.version;

    await joinWorkspaceAsEditor(pageA, pageB, workspaceId, workspaceName, accountB);

    // Workspace membership alone does not carry note-level edit rights (Part 32
    // proves a workspace editor is denied until the note itself is shared), so
    // grant the share through the product's own dialog.
    await pageA.goto(notePath);
    await expect(editorBody(pageA)).toBeVisible({ timeout: ROUTE_COMPILE_MS });
    await pageA.getByRole("button", { name: "Share" }).click();
    const shareDialog = pageA.getByRole("dialog", { name: "Share note" });
    await expect(shareDialog).toBeVisible();
    await shareDialog
      .getByLabel("Workspace member")
      .selectOption({ label: `${accountB.name} · editor` });
    await shareDialog.getByLabel("Permission").selectOption("edit");
    await shareDialog.getByRole("button", { name: "Grant access" }).click();
    await expect(shareDialog.getByText("Authenticated note access updated.")).toBeVisible();
    await pageA.keyboard.press("Escape");
    await expect(shareDialog).toBeHidden();

    await pageB.goto(notePath);
    await expect(editorBody(pageB)).toBeVisible({ timeout: ROUTE_COMPILE_MS });
  });

  test.afterAll(async () => {
    if (workspaceId !== "")
      await pageA.request
        .delete(`${apiUrl}/api/v1/workspaces/${workspaceId}`, {
          headers: { Origin: appUrl },
          data: { confirm: true, expectedName: workspaceName },
        })
        .catch(() => undefined);
    await contextA.close();
    await contextB.close();
  });

  test("loads the pre-existing note content into both collaborative sessions", async () => {
    await expect(pageA.getByRole("heading", { name: noteTitle })).toBeVisible();
    await expect(pageB.getByRole("heading", { name: noteTitle })).toBeVisible();

    /*
     * The regression this guards: a collaborative session that starts from an
     * empty Yjs document silently replaces the note it just opened. Both peers
     * must show the API-authored text, not one of them.
     */
    await expect(editorBody(pageA)).toContainText(seedText, { timeout: SYNC_MS });
    await expect(editorBody(pageB)).toContainText(seedText, { timeout: SYNC_MS });

    await expectCollabStatus(pageA, "synced");
    await expectCollabStatus(pageB, "synced");

    // The status is a polite live region, not colour-only chrome.
    await expect(collabStatus(pageA)).toHaveAttribute("role", "status");
    await expect(collabStatus(pageA)).toHaveAttribute("aria-live", "polite");
  });

  test("converges concurrent edits made in the same paragraph", async () => {
    test.slow();
    await expectCollabStatus(pageA, "synced");
    await expectCollabStatus(pageB, "synced");

    await focusSharedParagraphEnd(pageA);
    await focusSharedParagraphEnd(pageB);
    // Both carets sit in the same paragraph and both keyboards run at once, so
    // the two update streams genuinely interleave rather than queue.
    await Promise.all([
      pageA.keyboard.type(liveA, { delay: 30 }),
      pageB.keyboard.type(liveB, { delay: 30 }),
    ]);

    await expect
      .poll(
        async () => {
          const [left, right] = await Promise.all([editorText(pageA), editorText(pageB)]);
          // Same document on both peers, and not one character of the seed or of
          // either typed token missing from it. See `containsEveryCharacter` for
          // why this is not a substring check.
          const converged =
            left === right && containsEveryCharacter(left, [seedText, liveA, liveB]);
          return converged ? "converged" : `A=${left} / B=${right}`;
        },
        { timeout: CONVERGE_MS, intervals: [500, 1_000, 2_000] },
      )
      .toBe("converged");
  });

  test("merges edits made while one peer is offline without losing either side", async () => {
    test.slow();
    await expectCollabStatus(pageB, "synced");

    await contextB.setOffline(true);
    await expectCollabStatus(pageB, /offline|reconnecting/u);

    await focusSharedParagraphEnd(pageA);
    await pageA.keyboard.type(offlineA, { delay: 30 });
    await focusSharedParagraphEnd(pageB);
    await pageB.keyboard.type(offlineB, { delay: 30 });
    // The disconnected peer keeps its own edit locally; that is the precondition
    // for the merge below meaning anything.
    await expect(editorBody(pageB)).toContainText(offlineB.trim());

    await contextB.setOffline(false);
    await expectCollabStatus(pageB, "synced", CONVERGE_MS);

    const expected = [seedText, liveA, liveB, offlineA, offlineB];
    await expect
      .poll(
        async () => {
          const [left, right] = await Promise.all([editorText(pageA), editorText(pageB)]);
          // The whole point of the scenario: the offline peer's edit and the
          // online peer's edit both survive the merge. Counting characters is
          // what makes "survive" mean survive rather than "happens to still be
          // one contiguous run".
          const merged = left === right && containsEveryCharacter(left, expected);
          return merged ? "converged" : `A=${left} / B=${right}`;
        },
        { timeout: CONVERGE_MS, intervals: [500, 1_000, 2_000] },
      )
      .toBe("converged");
  });

  test("projects every collaborative edit into the persisted note", async () => {
    test.slow();
    const expected = [seedText, liveA, liveB, offlineA, offlineB];

    /*
     * The projection is a trailing debounce on the server, so this polls the
     * stored note rather than sleeping for a guessed interval. Reading through
     * the REST resource — not the live document — is what proves the durable
     * `notes.content` row, and not just the in-memory CRDT, carries the edits.
     */
    await expect
      .poll(
        async () => {
          const note = await apiGet<NoteRow>(
            pageA.request,
            `/api/v1/workspaces/${workspaceId}/notes/${noteId}`,
          );
          // The stored document's own text, not `JSON.stringify` of the row: the
          // concurrently typed tokens interleave in the CRDT, so they are not
          // contiguous substrings of anything. Every character of every edit has
          // to be in the persisted paragraph, which is the durable claim.
          const stored = documentText(note.content ?? null);
          return containsEveryCharacter(stored, expected) ? "projected" : stored;
        },
        { timeout: PROJECTION_MS, intervals: [1_000, 2_000, 3_000] },
      )
      .toBe("projected");

    // A reload discards every live document, so what renders afterwards is the
    // server-projected content.
    await Promise.all([pageA.reload(), pageB.reload()]);
    await expect(editorBody(pageA)).toBeVisible({ timeout: ROUTE_COMPILE_MS });
    await expect(editorBody(pageB)).toBeVisible({ timeout: ROUTE_COMPILE_MS });
    await expectCollabStatus(pageA, "synced");
    await expectCollabStatus(pageB, "synced");
    for (const page of [pageA, pageB]) {
      await expect
        .poll(
          async () => {
            const text = await editorText(page);
            return containsEveryCharacter(text, expected) ? "restored" : text;
          },
          { timeout: SYNC_MS, intervals: [500, 1_000, 2_000] },
        )
        .toBe("restored");
    }
  });

  test("resets a live collaborator onto a restored version", async () => {
    test.slow();
    await expectCollabStatus(pageA, "synced");
    await expectCollabStatus(pageB, "synced");
    // Mounted and empty before the restore, so the text that appears afterwards
    // is a change to a live region — which is what actually gets announced.
    await expect(collabNotice(pageB)).toHaveText("");

    const versions = await apiGet<{ items: readonly VersionRow[] }>(
      pageA.request,
      `/api/v1/workspaces/${workspaceId}/notes/${noteId}/versions?limit=50`,
    );
    expect(versions.items.find((version) => version.version === seedVersion)).toBeDefined();

    await pageA.getByRole("button", { name: "Version history" }).click();
    const history = pageA.getByRole("dialog", { name: "Version history" });
    await expect(history).toBeVisible();
    await history.getByRole("button", { name: new RegExp(`Version ${seedVersion}`, "u") }).click();
    pageA.once("dialog", (confirmation) => confirmation.accept());
    await history.getByRole("button", { name: "Restore this version" }).click();
    await expect(history).toContainText(/was restored as new version/u);
    await history.getByRole("button", { name: "Close" }).click();

    /*
     * The restored version is the seeded paragraph and nothing else, so the
     * assertion is equality with it rather than "contains the seed and none of
     * the four tokens". Same reason as the convergence checks above: the two
     * live tokens interleave, so `!text.includes(liveA)` is satisfied by a
     * document that still carries every character of `liveA` — an assertion that
     * cannot fail is not a check.
     */
    await expect(editorBody(pageA)).toContainText(seedText, { timeout: CONVERGE_MS });

    /*
     * The point of the epoch reset: the peer that was still holding the
     * pre-restore document is pulled onto the restored content instead of
     * replaying its own state back over it. Without a reset, B's live document
     * wins and the restore is undone within seconds.
     */
    await expect
      .poll(
        async () => {
          const text = await editorText(pageB);
          return text === seedText ? "restored" : text;
        },
        { timeout: CONVERGE_MS, intervals: [500, 1_000, 2_000] },
      )
      .toBe("restored");

    // The reset is announced rather than only rendered, and the session settles
    // back on a synced document rather than a broken one.
    await expect(collabNotice(pageB)).toHaveText("This note was restored to an earlier version", {
      timeout: CONVERGE_MS,
    });
    await expect(collabNotice(pageB)).toHaveAttribute("aria-live", "polite");
    await expectCollabStatus(pageB, "synced");

    // The restore is durable, not just a live-document effect.
    await expect
      .poll(
        async () => {
          const note = await apiGet<NoteRow>(
            pageA.request,
            `/api/v1/workspaces/${workspaceId}/notes/${noteId}`,
          );
          return documentText(note.content ?? null);
        },
        { timeout: PROJECTION_MS, intervals: [1_000, 2_000, 3_000] },
      )
      .toBe(seedText);
  });
});
