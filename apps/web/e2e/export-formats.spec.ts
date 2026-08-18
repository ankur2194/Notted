import { randomUUID } from "node:crypto";
import { inflateRawSync, inflateSync } from "node:zlib";

import { SUPPORTED_EXPORT_FORMATS, type ExportFormat } from "@notted/shared-types";
import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
  type Download,
  type Locator,
  type Page,
} from "@playwright/test";

import { latestActionLink } from "./mailpit";

/*
 * Part 64 — `markdown`, `docx` and `zip` exports, driven through the real
 * `ExportNoteDialog` against the real queue, worker and object store.
 *
 * WHAT ONLY A BROWSER CAN PROVE HERE, and why each journey exists:
 *
 * 1. The dialog really reaches a terminal `ready` and really hands the reader
 *    BYTES. `downloadPath` is a login-gated API route, never a presigned URL,
 *    so a download event (not a navigation) is the only way to tell "the
 *    authorized route streamed the file" from "the browser opened a viewer".
 * 2. The three include toggles are wired to the three `ExportOptions` flags.
 *    A unit test can assert the mutation payload; only this can assert the
 *    ARCHIVE that came back, which is the thing the reader actually gets.
 * 3. PDF pagination parity. The server renders the note in its own headless
 *    Chromium with its own copy of the print CSS. If that copy drifts from the
 *    editor's `@page` rule, nothing else in the repository notices — the two
 *    renderers are never compared anywhere. Byte equality is impossible
 *    (timestamps, font-subset ids), so page count plus per-page MediaBox is the
 *    strongest honest signal, and it is exactly what a CSS divergence breaks.
 *
 * SELECTORS THIS SPEC DEPENDS ON. `ExportNoteDialog` lands in parallel, so
 * these are the contract between the two changes. Everything is role/label
 * based and deliberately forgiving, so cosmetic markup changes do not break it:
 *   role   button    /^Export/          — the header trigger, next to Share
 *   role   dialog    /export/i          — the dialog itself
 *   label  /format/i                    — a native <select> of ExportFormat values
 *   role   checkbox  /attachments|comments|version/i — the three zip toggles
 *   role   button    /^(Export|Start|Generate|Create)/ — the dialog's submit
 *   role   link      /download/i        — the real <a download href> when ready
 *   [aria-live="polite"]                — the trailing status paragraph
 */

const disposable = process.env.PLAYWRIGHT_DISPOSABLE_TEST_RUN === "true";
const apiUrl = process.env.PLAYWRIGHT_API_URL ?? "http://localhost:3001";
const appUrl = process.env.PLAYWRIGHT_APP_URL ?? "http://localhost:3000";
const password = "Fresh1!Password";

/** A cold Next.js dev route compiles on its first visit. */
const ROUTE_COMPILE_MS = 45_000;
/** Enqueue, worker pickup, generation, upload, then the poll that observes it. */
const EXPORT_MS = 120_000;

/** The one attachment the `zip` matrix includes or excludes. */
const ATTACHMENT_NAME = "export-fixture.txt";
const ATTACHMENT_BYTES = Buffer.from("bundled attachment bytes\n", "utf8");

interface Account {
  readonly name: string;
  readonly email: string;
  readonly password: string;
}

interface ZipIncludes {
  readonly includeAttachments: boolean;
  readonly includeComments: boolean;
  readonly includeVersionHistory: boolean;
}

interface ExportManifest {
  readonly schemaVersion: number;
  readonly entries: readonly { path: string; kind: string; bytes: number }[];
  readonly skipped: readonly { kind: string; id: string; name: string; reason: string }[];
}

/* -------------------------------------------------------------------------- */
/* Fixtures and API seeding — the house per-spec convention                     */
/* -------------------------------------------------------------------------- */

function identity(role: string): Account {
  const suffix = randomUUID();
  const emailRole = role.toLowerCase().replaceAll(/[^a-z0-9]+/gu, "-");
  return { name: `Export ${role}`, email: `export.${emailRole}.${suffix}@example.test`, password };
}

async function expectOk(response: APIResponse): Promise<void> {
  expect(response.ok(), `${response.url()} returned ${response.status()}`).toBe(true);
}

/** Provision real verified auth without re-proving Part 9's already-covered forms. */
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
  const response = await request.patch(`${apiUrl}${path}`, { headers: { Origin: appUrl }, data });
  await expectOk(response);
  return response.json() as Promise<T>;
}

async function apiGet<T>(request: APIRequestContext, path: string): Promise<T> {
  const response = await request.get(`${apiUrl}${path}`);
  await expectOk(response);
  return response.json() as Promise<T>;
}

interface SeededNote {
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly noteId: string;
  readonly title: string;
  readonly path: string;
}

/**
 * A note carrying every artifact the `zip` matrix has to include or exclude:
 * one attachment, one comment thread, and (via two saves) prior versions.
 *
 * Seeded through the API on purpose. Typing this in the editor would re-prove
 * Parts 39/44/60 and add their timing to a suite that is about export bytes.
 */
async function seedRichNote(request: APIRequestContext, label: string): Promise<SeededNote> {
  const suffix = randomUUID().slice(0, 8);
  const workspaceName = `Export ${suffix}`;
  const workspace = await apiPost<{ workspace: { id: string } }>(
    request,
    "/api/v1/workspaces",
    {
      name: workspaceName,
      slug: `export-${suffix}`,
      description: null,
      settings: { defaultPageSize: "a4" },
    },
    randomUUID(),
  );
  const workspaceId = workspace.workspace.id;

  const title = `${label} note ${suffix}`;
  const created = await apiPost<{ note: { id: string; version: number } }>(
    request,
    `/api/v1/workspaces/${workspaceId}/notes`,
    { title, projectId: null, folderId: null, parentId: null },
    randomUUID(),
  );
  const noteId = created.note.id;

  const uploaded = await request.post(
    `${apiUrl}/api/v1/workspaces/${workspaceId}/notes/${noteId}/attachments`,
    {
      headers: { Origin: appUrl, "Idempotency-Key": randomUUID() },
      multipart: {
        file: { name: ATTACHMENT_NAME, mimeType: "text/plain", buffer: ATTACHMENT_BYTES },
      },
    },
  );
  await expectOk(uploaded);
  const attachmentId = ((await uploaded.json()) as { attachment: { id: string } }).attachment.id;

  // Save one: becomes a historical version once save two lands.
  const first = await apiPatch<{ note: { version: number } }>(
    request,
    `/api/v1/workspaces/${workspaceId}/notes/${noteId}`,
    {
      expectedVersion: created.note.version,
      content: {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "First revision." }] }],
      },
    },
  );

  // Save two: the current document. Two paragraphs plus the attachment node, so
  // `note.md` has body text to carry and the attachment is genuinely referenced.
  await apiPatch(request, `/api/v1/workspaces/${workspaceId}/notes/${noteId}`, {
    expectedVersion: first.note.version,
    content: {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Exported body paragraph." }] },
        { type: "paragraph", content: [{ type: "text", text: "Second exported paragraph." }] },
        {
          type: "attachment",
          attrs: {
            attachmentId,
            name: ATTACHMENT_NAME,
            mimeType: "text/plain",
            sizeBytes: ATTACHMENT_BYTES.byteLength,
          },
        },
      ],
    },
  });

  await apiPost(
    request,
    `/api/v1/workspaces/${workspaceId}/notes/${noteId}/comments`,
    { content: `Bundled comment ${suffix}`, parentId: null, anchor: null },
    // `CommentsController.create` calls `requireIdempotencyKey`, so an omitted
    // header is a 400 before the body is ever looked at — same as every other
    // POST seeded above.
    randomUUID(),
  );

  return {
    workspaceId,
    workspaceName,
    noteId,
    title,
    path: `/workspaces/${workspaceId}/notes/${noteId}`,
  };
}

/* -------------------------------------------------------------------------- */
/* Reading the bytes back                                                       */
/* -------------------------------------------------------------------------- */

async function downloadBytes(download: Download): Promise<Buffer> {
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/**
 * Reads a ZIP by walking its central directory, inflating each member with
 * `node:zlib`.
 *
 * `fflate` is a dependency of `apps/api` only and does NOT resolve from
 * `apps/web/e2e` under pnpm's strict layout (verified), and shelling out to
 * `unzip` would make the suite depend on a binary that is not part of the
 * pinned matrix in ADR 0008. `inflateRawSync` is a builtin, so this stays
 * dependency-free — the same reasoning `print-export.spec.ts` used for its
 * PDF stream inflation.
 *
 * ponytail: no ZIP64 support (32-bit sizes and offsets only) and no
 * data-descriptor fallback. Export archives here are a handful of small files;
 * reach for a real ZIP library if an export ever exceeds 4GB or an entry count
 * of 65535.
 */
function zipEntries(archive: Buffer): Map<string, Buffer> {
  // End Of Central Directory: variable-length trailing comment, so scan back.
  let eocd = archive.length - 22;
  while (eocd >= 0 && archive.readUInt32LE(eocd) !== 0x06054b50) eocd -= 1;
  expect(eocd, "the download is not a ZIP archive (no end-of-central-directory)").toBeGreaterThan(
    -1,
  );

  const count = archive.readUInt16LE(eocd + 10);
  let cursor = archive.readUInt32LE(eocd + 16);
  const entries = new Map<string, Buffer>();
  for (let index = 0; index < count; index += 1) {
    expect(archive.readUInt32LE(cursor), "corrupt central directory header").toBe(0x02014b50);
    const method = archive.readUInt16LE(cursor + 10);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const name = archive.toString("utf8", cursor + 46, cursor + 46 + nameLength);

    // The local header repeats the name and carries its OWN extra-field length,
    // which routinely differs from the central directory's.
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const raw = archive.subarray(start, start + compressedSize);
    entries.set(name, method === 8 ? inflateRawSync(raw) : Buffer.from(raw));

    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/**
 * PDF page geometry, lifted verbatim from `print-export.spec.ts`.
 *
 * Chromium writes compressed object streams, so the `/MediaBox` and `/Type
 * /Page` tokens are NOT in the raw bytes — a regex over the file alone finds
 * nothing. Every Flate stream has to be inflated first. Kept local rather than
 * imported because Part 38's spec owns its helpers privately and this suite is
 * the only other reader; promote both to a shared module if a third appears.
 */
function inflatedStreams(pdf: Buffer): string {
  const parts: string[] = [];
  const begin = Buffer.from("stream");
  const end = Buffer.from("endstream");
  let index = pdf.indexOf(begin);
  while (index !== -1) {
    let start = index + begin.length;
    if (pdf[start] === 0x0d) start += 1;
    if (pdf[start] === 0x0a) start += 1;
    const stop = pdf.indexOf(end, start);
    if (stop === -1) break;
    try {
      parts.push(inflateSync(pdf.subarray(start, stop)).toString("latin1"));
    } catch {
      // Not a Flate stream (or not a stream at all); the raw source covers it.
    }
    index = pdf.indexOf(begin, stop + end.length);
  }
  return parts.join("\n");
}

function pdfSource(pdf: Buffer): string {
  return `${pdf.toString("latin1")}\n${inflatedStreams(pdf)}`;
}

function pdfPageBoxes(source: string): Array<{ width: number; height: number }> {
  const pattern = /\/MediaBox\s*\[\s*(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s*\]/gu;
  return [...source.matchAll(pattern)].map((match) => ({
    width: Number(match[3]) - Number(match[1]),
    height: Number(match[4]) - Number(match[2]),
  }));
}

function pdfPageCount(source: string): number {
  const pages = [...source.matchAll(/\/Type\s*\/Page(?![s])/gu)].length;
  if (pages > 0) return pages;
  const counted = /\/Type\s*\/Pages(?:[^>]|>(?!>))*?\/Count\s+(\d+)/u.exec(source);
  return counted === null ? 0 : Number(counted[1]);
}

/* -------------------------------------------------------------------------- */
/* Driving the dialog                                                           */
/* -------------------------------------------------------------------------- */

function exportTrigger(page: Page): Locator {
  // EXACT, not a prefix. The dialog's own submit button is labelled
  // "Export note", so a `/^Export/` regex matches two buttons the moment the
  // dialog is open and trips Playwright's strict mode. The header trigger is
  // the only control whose accessible name is exactly "Export".
  return page.getByRole("button", { name: "Export", exact: true });
}

/**
 * One full pass through the dialog: open, pick a format, set the zip toggles,
 * submit, wait for a terminal `ready`, take the real download, close.
 *
 * The wait is a bounded `toBeVisible({ timeout })` on the download link rather
 * than a hand-rolled poll: the link only exists once the job is `ready`, so its
 * appearance IS the terminal-status assertion, and Playwright's timeout keeps
 * it finite.
 */
async function runExport(
  page: Page,
  format: ExportFormat,
  includes?: ZipIncludes,
): Promise<{ filename: string; bytes: Buffer }> {
  const trigger = exportTrigger(page);
  await expect(trigger).toBeVisible({ timeout: ROUTE_COMPILE_MS });
  await trigger.click();

  const dialog = page.getByRole("dialog", { name: /export/iu });
  await expect(dialog).toBeVisible();

  await dialog.getByLabel(/format/iu).selectOption(format);

  const toggles = [
    { name: /attachments/iu, value: includes?.includeAttachments ?? false },
    { name: /comments/iu, value: includes?.includeComments ?? false },
    { name: /version/iu, value: includes?.includeVersionHistory ?? false },
  ];
  if (format === "zip") {
    for (const toggle of toggles) {
      await dialog.getByRole("checkbox", { name: toggle.name }).setChecked(toggle.value);
    }
  } else {
    // The three flags are meaningless outside a bundle, so they are not offered.
    for (const toggle of toggles) {
      await expect(dialog.getByRole("checkbox", { name: toggle.name })).toHaveCount(0);
    }
  }

  await dialog.getByRole("button", { name: /^(Export|Start|Generate|Create)/u }).click();

  const link = dialog.getByRole("link", { name: /download/iu });
  await expect(link, `the ${format} export never reached a ready status`).toBeVisible({
    timeout: EXPORT_MS,
  });
  // The bytes come from the login-gated API route, never a presigned URL or a
  // client-side blob: that is the security decision of the part.
  const href = (await link.getAttribute("href")) ?? "";
  expect(href).toContain(`/exports/`);
  expect(href).not.toContain("blob:");

  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: EXPORT_MS }),
    link.click(),
  ]);
  expect(await download.failure()).toBeNull();
  const result = { filename: download.suggestedFilename(), bytes: await downloadBytes(download) };

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  return result;
}

/** The sorted archive layout the manifest claims, cross-checked against reality. */
function manifestPaths(archive: Buffer): { claimed: string[]; actual: string[] } {
  const entries = zipEntries(archive);
  const manifestBytes = entries.get("manifest.json");
  expect(manifestBytes, "the archive has no manifest.json").toBeDefined();
  const manifest = JSON.parse(manifestBytes!.toString("utf8")) as ExportManifest;
  expect(manifest.schemaVersion).toBe(1);
  return {
    // `manifest.json` DOES list itself (first, with `bytes: 0`), because it is
    // the complete index of the archive and an index omitting one member is not
    // complete. So `claimed` is the manifest verbatim — nothing is appended, and
    // comparing it to `actual` is what catches a manifest that lies in either
    // direction: a member it forgot, or a member it invented.
    claimed: manifest.entries.map((entry) => entry.path).sort(),
    actual: [...entries.keys()].sort(),
  };
}

/* -------------------------------------------------------------------------- */

test.describe.serial("Part 64 export formats", () => {
  test.skip(
    !disposable,
    "Requires the real disposable app, PostgreSQL, Redis, MinIO, and the export worker.",
  );

  test("exports markdown, txt and docx, and honours every zip include toggle", async ({
    browser,
  }) => {
    // Six queue round trips through a dev server that compiles routes on demand.
    test.setTimeout(600_000);
    const context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();

    try {
      await provisionAccount(page.request, identity("owner"));
      const note = await seedRichNote(page.request, "Export");
      await page.goto(note.path);
      await expect(page.getByRole("heading", { name: note.title })).toBeVisible({
        timeout: ROUTE_COMPILE_MS,
      });

      /* ------------------------------------------------ accessibility, once */
      // Folded into this journey rather than given its own test: it is the same
      // dialog, and re-provisioning an account to press Escape is not evidence.
      const trigger = exportTrigger(page);
      await trigger.focus();
      await expect(trigger).toBeFocused();
      await page.keyboard.press("Enter");
      const dialog = page.getByRole("dialog", { name: /export/iu });
      await expect(dialog).toBeVisible();
      // Focus must move INTO the dialog, or a keyboard reader is stranded behind it.
      expect(
        await dialog.evaluate((element) => element.contains(document.activeElement)),
        "focus stayed outside the dialog on open",
      ).toBe(true);
      // The status region exists before anything is announced through it.
      await expect(dialog.locator('[aria-live="polite"]')).toHaveCount(1);
      // Every format the contract claims is offered, so the picker cannot
      // silently fall behind `SUPPORTED_EXPORT_FORMATS`.
      const offered = await dialog
        .getByLabel(/format/iu)
        .locator("option")
        .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value));
      expect([...offered].sort()).toEqual([...SUPPORTED_EXPORT_FORMATS].sort());
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      // Escape returns focus to what opened the dialog.
      await expect(trigger).toBeFocused();

      /* -------------------------------------------------- one file per format */
      const markdown = await runExport(page, "markdown");
      expect(markdown.filename).toMatch(/\.(md|markdown)$/u);
      const markdownText = markdown.bytes.toString("utf8");
      expect(markdownText.startsWith("# ")).toBe(true);
      expect(markdownText).toContain(note.title);

      const txt = await runExport(page, "txt");
      expect(txt.filename).toMatch(/\.txt$/u);
      expect(txt.bytes.toString("utf8")).toContain(note.title);

      const docx = await runExport(page, "docx");
      expect(docx.filename).toMatch(/\.docx$/u);
      // A DOCX is an OPC package: a ZIP whose local file header comes first.
      expect(docx.bytes.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
      // Not named `document`: that would shadow the global the `evaluate` calls
      // above rely on.
      const wordDocument = zipEntries(docx.bytes).get("word/document.xml");
      expect(wordDocument, "the docx has no word/document.xml part").toBeDefined();
      expect(wordDocument!.toString("utf8")).toContain(note.title);

      /* ------------------------------------------ the zip include/exclude matrix */
      // Asserted against `manifest.json`, and the manifest is then held to the
      // archive it describes — a manifest that lied would otherwise pass.
      const attachmentPath = `attachments/${ATTACHMENT_NAME}`;

      const bare = await runExport(page, "zip", {
        includeAttachments: false,
        includeComments: false,
        includeVersionHistory: false,
      });
      expect(bare.filename).toMatch(/\.zip$/u);
      const bareLayout = manifestPaths(bare.bytes);
      expect(bareLayout.claimed).toEqual(["manifest.json", "note.md"]);
      expect(bareLayout.actual).toEqual(bareLayout.claimed);

      const withAttachments = await runExport(page, "zip", {
        includeAttachments: true,
        includeComments: false,
        includeVersionHistory: false,
      });
      const attachmentLayout = manifestPaths(withAttachments.bytes);
      expect(attachmentLayout.claimed).toEqual([attachmentPath, "manifest.json", "note.md"]);
      expect(attachmentLayout.actual).toEqual(attachmentLayout.claimed);
      // The bundled attachment is the real stored object, not a placeholder.
      expect(zipEntries(withAttachments.bytes).get(attachmentPath)).toEqual(ATTACHMENT_BYTES);

      const everything = await runExport(page, "zip", {
        includeAttachments: true,
        includeComments: true,
        includeVersionHistory: true,
      });
      const fullLayout = manifestPaths(everything.bytes);
      expect(fullLayout.claimed).toEqual([
        attachmentPath,
        "comments.json",
        "manifest.json",
        "note.md",
        "versions.json",
      ]);
      expect(fullLayout.actual).toEqual(fullLayout.claimed);
      // Content, not just presence: an empty `comments.json` would still be a path.
      const full = zipEntries(everything.bytes);
      expect(JSON.stringify(JSON.parse(full.get("comments.json")!.toString("utf8")))).toContain(
        "Bundled comment",
      );
      expect(JSON.parse(full.get("versions.json")!.toString("utf8"))).not.toEqual([]);
      expect(full.get("note.md")!.toString("utf8")).toContain("Exported body paragraph.");
    } finally {
      await context.close();
    }
  });

  test("server PDF paginates identically to the editor's own print output", async ({
    browser,
    browserName,
  }, testInfo) => {
    // `page.pdf()` is Chromium-only, and chromium is the baseline project.
    test.skip(browserName !== "chromium", "page.pdf() exists only in Chromium");
    /*
     * Deliberately NOT gated on `EXPORT_CHROMIUM_PATH`. That variable is read
     * by the export worker inside the API container; this code runs inside the
     * Playwright container, where it is never set, so a guard on it skipped the
     * only pagination-parity evidence on every single run. Part 63 ships
     * Chromium in the API image unconditionally (`workspace-chromium` in
     * `docker/Dockerfile.dev`, which `api-e2e` inherits by `extends`), so the
     * renderer is always available here and an unavailable one is a real
     * failure worth seeing rather than a skip.
     */
    test.setTimeout(600_000);

    const context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();

    try {
      await provisionAccount(page.request, identity("pdf"));
      const note = await seedRichNote(page.request, "Pagination");
      await page.goto(note.path);
      await expect(page.getByRole("heading", { name: note.title })).toBeVisible({
        timeout: ROUTE_COMPILE_MS,
      });
      await expect(page.getByRole("textbox", { name: /Note content/u })).toBeVisible({
        timeout: ROUTE_COMPILE_MS,
      });

      // The editor's own print output, produced by the SAME `@page` rule the
      // reader gets when they press Ctrl+P.
      const editorPath = testInfo.outputPath("editor-print.pdf");
      const editorSource = pdfSource(await page.pdf({ preferCSSPageSize: true, path: editorPath }));
      await testInfo.attach("editor-print.pdf", {
        path: editorPath,
        contentType: "application/pdf",
      });

      const exported = await runExport(page, "pdf");
      expect(exported.filename).toMatch(/\.pdf$/u);
      expect(exported.bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
      // Attached, not just held in memory: a pagination failure has to be
      // inspectable next to the editor's own sheet.
      await testInfo.attach("server-export.pdf", {
        body: exported.bytes,
        contentType: "application/pdf",
      });
      const exportedSource = pdfSource(exported.bytes);

      const editorBoxes = pdfPageBoxes(editorSource);
      const exportedBoxes = pdfPageBoxes(exportedSource);
      expect(editorBoxes.length).toBeGreaterThan(0);
      // Page COUNT parity is the headline: an extra or missing page is what a
      // drifted print stylesheet or a divergent `@page` rule actually produces.
      expect(pdfPageCount(exportedSource)).toBe(pdfPageCount(editorSource));
      expect(exportedBoxes).toHaveLength(editorBoxes.length);
      // …and each sheet is the same paper. Compared to the point rather than
      // for byte equality, which is impossible: timestamps and font-subset ids
      // differ between any two renders.
      exportedBoxes.forEach((box, index) => {
        const expected = editorBoxes[index]!;
        expect(box.width, `page ${index + 1} width`).toBeCloseTo(expected.width, 0);
        expect(box.height, `page ${index + 1} height`).toBeCloseTo(expected.height, 0);
      });
    } finally {
      await context.close();
    }
  });

  test("the export trigger tracks the note's canExport capability for a viewer", async ({
    browser,
  }) => {
    test.setTimeout(600_000);
    const ownerContext = await browser.newContext();
    const viewerContext = await browser.newContext({ acceptDownloads: true });
    const owner = await ownerContext.newPage();
    const viewer = await viewerContext.newPage();

    try {
      await provisionAccount(owner.request, identity("gate owner"));
      const note = await seedRichNote(owner.request, "Gated");

      const viewerAccount = identity("gate viewer");
      await provisionAccount(viewer.request, viewerAccount);
      await apiPost(owner.request, `/api/v1/workspaces/${note.workspaceId}/invitations`, {
        email: viewerAccount.email,
        role: "viewer",
      });
      const invitation = new URL(
        await latestActionLink(owner.request, viewerAccount.email, `Join ${note.workspaceName}`),
      );
      const token = invitation.searchParams.get("token");
      expect(token).not.toBeNull();
      await apiPost(viewer.request, "/api/v1/invitations/accept", { token });

      await viewer.goto(note.path);
      await expect(viewer.getByRole("heading", { name: note.title })).toBeVisible({
        timeout: ROUTE_COMPILE_MS,
      });

      /*
       * The gate is asserted against the SERVER's own answer rather than a
       * hard-coded expectation.
       *
       * ponytail: no workspace role reachable here actually yields
       * `canExport: false` — `export.create` is granted to every role that can
       * read the note (`AuthorizationPolicyService.viewerAllowed`), so a member
       * who can open this page can always export it. Faking the false branch
       * would mean asserting a state the product cannot enter. What this DOES
       * catch is the realistic bug: the trigger gated on `canUpdate`/`canShare`
       * instead of `canExport`, which hides it from every viewer. Add the false
       * branch here the day a role or a policy flag can produce it.
       */
      const detail = await apiGet<{ capabilities: { canExport: boolean; canUpdate: boolean } }>(
        viewer.request,
        `/api/v1/workspaces/${note.workspaceId}/notes/${note.noteId}`,
      );
      // A viewer cannot edit — which is exactly why gating on `canUpdate` fails here.
      expect(detail.capabilities.canUpdate).toBe(false);
      const trigger = exportTrigger(viewer);
      await expect(trigger).toHaveCount(detail.capabilities.canExport ? 1 : 0);

      if (detail.capabilities.canExport) {
        // And it is not a decorative button: the viewer's own export completes
        // and downloads through the authorized route.
        const exported = await runExport(viewer, "markdown");
        expect(exported.bytes.toString("utf8")).toContain(note.title);
      }
    } finally {
      await Promise.all([ownerContext.close(), viewerContext.close()]);
    }
  });
});
