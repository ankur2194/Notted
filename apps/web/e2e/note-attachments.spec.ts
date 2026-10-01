import { randomUUID } from "node:crypto";
import { deflateSync } from "node:zlib";

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import { latestActionLink } from "./mailpit";

/**
 * Part 44 browser verification.
 *
 * What genuinely needs a real browser here, and cannot be proved anywhere else:
 *
 * 1. **A real download.** `Content-Disposition: attachment` plus
 *    `X-Content-Type-Options: nosniff` is the security decision of the part —
 *    a generic file is NEVER served inline. Only a browser can show that
 *    clicking the card's Download produces a *download event* rather than a
 *    navigation that renders a PDF in the built-in viewer. jsdom has no
 *    download semantics at all, so no unit test can see a regression here.
 * 2. **The real upload path end to end.** An explicit kind routes files and
 *    images to their separate pipelines; the card only appears once a permanent
 *    attachment id exists. Generic files retain their original extension.
 * 3. **Confirmed deletion.** That the server delete happens first, the node is
 *    removed second, and the stored document really loses the reference.
 * 4. **Persistence with no URL in the document**, which is the invariant the
 *    whole part is built around.
 */

const disposable = process.env.PLAYWRIGHT_DISPOSABLE_TEST_RUN === "true";
const apiUrl = process.env.PLAYWRIGHT_API_URL ?? "http://localhost:3001";
const appUrl = process.env.PLAYWRIGHT_APP_URL ?? "http://localhost:3000";
const password = "Fresh1!Password";

/** Generous enough for a cold Next dev-server route compile. */
const ROUTE_COMPILE_MS = 45_000;
/** Upload, storage, and the debounced save all have to complete. */
const UPLOAD_MS = 30_000;

/* -------------------------------------------------------------------------- */
/* Real files, built here rather than committed as fixtures                     */
/* -------------------------------------------------------------------------- */

/**
 * A genuine, structurally valid single-page PDF.
 *
 * Generated rather than committed so the fixture remains reviewable. A valid
 * document supports the optional PDF preview; generic attachment admission
 * itself does not inspect its contents.
 */
function pdfBytes(text: string): Buffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R " +
      "/Resources << /Font << /F1 5 0 R >> >> >>",
    null,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const stream = `BT /F1 12 Tf 20 100 Td (${text}) Tj ET`;
  objects[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;

  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object ?? ""}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  body +=
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n` + `startxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

/** A real ZIP with an empty central directory. */
function emptyZipBytes(): Buffer {
  const end = Buffer.alloc(22);
  // `PK\x05\x06` — the ZIP End Of Central Directory signature.
  end.writeUInt32LE(0x06054b50, 0);
  return end;
}

/** A real PNG, used only to prove an image still takes the IMAGE path. */
function pngBytes(): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(8, 0);
  header.writeUInt32BE(8, 4);
  header[8] = 8;
  header[9] = 2;
  const raw = Buffer.alloc(8 * (1 + 8 * 3));
  const crcTable = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    crcTable[index] = value >>> 0;
  }
  const crc32 = (bytes: Buffer): number => {
    let crc = 0xffffffff;
    for (const byte of bytes) crc = (crcTable[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const inner = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(inner));
    return Buffer.concat([length, inner, crc]);
  };
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const REPORT_PDF = pdfBytes("Quarterly report");
const BUNDLE_ZIP = emptyZipBytes();
const NOTES_TXT = Buffer.from("plain text attachment\nsecond line\n", "utf8");
const PHOTO_PNG = pngBytes();

/* -------------------------------------------------------------------------- */
/* Local helpers, per this repository's per-spec convention                     */
/* -------------------------------------------------------------------------- */

function identity(role: string) {
  const suffix = randomUUID();
  return { name: `Files ${role}`, email: `files.${role}.${suffix}@example.test`, password };
}

async function register(page: Page, account: ReturnType<typeof identity>): Promise<void> {
  await page.goto("/register");
  await page.getByLabel("Name").fill(account.name);
  await page.getByLabel("Email").fill(account.email);
  await page.getByLabel("Password", { exact: true }).fill(account.password);
  await page.getByLabel("Confirm password").fill(account.password);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.goto(await latestActionLink(page.request, account.email, "Verify your Notted email"));
  await expect(page.getByRole("heading", { name: "Email verified" })).toBeVisible({
    timeout: ROUTE_COMPILE_MS,
  });
  await page.goto("/login?redirect=%2Fworkspaces");
  await page.getByLabel("Email", { exact: true }).first().fill(account.email);
  await page.getByLabel("Password").fill(account.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/workspaces$/u, { timeout: ROUTE_COMPILE_MS });
}

async function createWorkspace(page: Page, name: string): Promise<string> {
  await page.getByRole("button", { name: "Create workspace", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Create a workspace" });
  await dialog.getByLabel("Workspace name").fill(name);
  await dialog.getByRole("button", { name: "Create workspace", exact: true }).click();
  await expect(page).toHaveURL(/\/workspaces\/[0-9a-f-]+$/u, { timeout: ROUTE_COMPILE_MS });
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

async function createNote(page: Page, workspaceId: string, title: string): Promise<string> {
  const result = await apiPost(
    page.request,
    `/api/v1/workspaces/${workspaceId}/notes`,
    { title, projectId: null, folderId: null, parentId: null },
    randomUUID(),
  );
  return (result.note as { id: string }).id;
}

/** The stored document, read straight from the API rather than from the DOM. */
async function storedDocument(
  request: APIRequestContext,
  workspaceId: string,
  noteId: string,
): Promise<string> {
  const response = await request.get(`${apiUrl}/api/v1/workspaces/${workspaceId}/notes/${noteId}`, {
    headers: { Origin: appUrl },
  });
  await expect(response).toBeOK();
  const body = (await response.json()) as { content: unknown };
  return JSON.stringify(body.content);
}

const cards = (page: Page) => page.locator(".notted-editor-content .notted-attachment");
const images = (page: Page) => page.locator(".notted-editor-content img.notted-image");

/**
 * Picks files through the REAL user path.
 *
 * Driving `input[type=file]` directly with `setInputFiles` does not work, and
 * should not: `useImageUploads` records the caret position and the insertion
 * controller at the moment the pick is REQUESTED and deliberately ignores a
 * selection no request is waiting for. Opening the picker first is the only
 * faithful way to exercise the upload.
 */
async function pickAttachments(
  page: Page,
  files: readonly { name: string; mimeType: string; buffer: Buffer }[],
): Promise<void> {
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.getByRole("button", { name: "Attach file" }).click(),
  ]);
  await chooser.setFiles(files.map((file) => ({ ...file })));
}

/**
 * Wait until the note's PERSISTED document satisfies `expectation`.
 *
 * Not the save indicator. A synced collaborative session is the single writer
 * (`NoteEditorSurface` binds one at a time), so the Part 39 autosave machine is
 * deliberately left unbound and the indicator never leaves "No unsaved
 * changes." — content durability is owned by the server-side Yjs projection.
 * Reading the row back is therefore the only honest proof, and it is stronger
 * than the string it replaces.
 */
async function waitForStored(
  page: Page,
  workspaceId: string,
  noteId: string,
  expectation: (document: string) => boolean,
): Promise<void> {
  await expect
    .poll(async () => expectation(await storedDocument(page.request, workspaceId, noteId)), {
      timeout: UPLOAD_MS,
    })
    .toBe(true);
}

test.describe.serial("Part 44 generic attachments in a real browser", () => {
  test.skip(
    !disposable,
    "attachment verification requires PLAYWRIGHT_DISPOSABLE_TEST_RUN=true and disposable PostgreSQL, Redis, MinIO, and Mailpit",
  );

  test("uploads, renders a card, downloads, deletes, and stores no URL", async ({ browser }) => {
    test.slow();
    const context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();
    const workspaceName = `Files ${randomUUID().slice(0, 8)}`;
    let workspaceId: string | null = null;

    /*
     * Every PATCH is captured: the invariant is about what is *sent*, not only
     * about what is finally stored. A document that carried a URL for one
     * request and was corrected afterwards would still have persisted one.
     */
    const patchBodies: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "PATCH" && request.url().includes("/notes/")) {
        patchBodies.push(request.postData() ?? "");
      }
    });

    try {
      await register(page, identity("owner"));
      workspaceId = await createWorkspace(page, workspaceName);
      const noteId = await createNote(page, workspaceId, "Attachment note");
      await page.goto(`/workspaces/${workspaceId}/notes/${noteId}`);

      const body = page.getByRole("textbox", { name: /Note content/u });
      await expect(body).toBeVisible({ timeout: ROUTE_COMPILE_MS });
      await body.click();
      await page.keyboard.type("Attachments below.");

      // ------------------------------------------------ three kinds at once
      await pickAttachments(page, [
        { name: "report.pdf", mimeType: "application/pdf", buffer: REPORT_PDF },
        { name: "bundle.zip", mimeType: "application/zip", buffer: BUNDLE_ZIP },
        // Generic files retain their declared MIME metadata and original bytes.
        { name: "notes.txt", mimeType: "text/plain", buffer: NOTES_TXT },
      ]);

      await expect(cards(page)).toHaveCount(3, { timeout: UPLOAD_MS });
      // Placeholders are decorations, so they leave nothing behind.
      await expect(page.locator(".notted-image-upload")).toHaveCount(0, { timeout: UPLOAD_MS });
      await waitForStored(
        page,
        workspaceId,
        noteId,
        (document) =>
          document.includes("report.pdf") &&
          document.includes("bundle.zip") &&
          document.includes("notes.txt"),
      );

      // Each card names its file and states its kind and size in text.
      await expect(cards(page).filter({ hasText: "report.pdf" })).toHaveCount(1);
      await expect(cards(page).filter({ hasText: "bundle.zip" })).toHaveCount(1);
      await expect(cards(page).filter({ hasText: "notes.txt" })).toHaveCount(1);

      // --------------------------------------------------------- a real download
      /*
       * THE DISPOSITION ASSERTION.
       *
       * A generic file is served with `Content-Disposition: attachment` and
       * `X-Content-Type-Options: nosniff`, so activating the card's Download
       * must produce a DOWNLOAD rather than a navigation that renders the PDF
       * in the browser's built-in viewer. Waiting for the `download` event is
       * the only way to tell those two outcomes apart.
       */
      const pdfCard = cards(page).filter({ hasText: "report.pdf" });
      const [download] = await Promise.all([
        page.waitForEvent("download", { timeout: UPLOAD_MS }),
        pdfCard.getByTestId("attachment-download").click(),
      ]);
      expect(download.url()).toContain("/api/v1/workspaces/");
      expect(download.url()).not.toContain("blob:");
      expect(await download.failure()).toBeNull();

      // The same route, asserted at the header level so the reason is explicit.
      const head = await page.request.get(download.url(), { headers: { Origin: appUrl } });
      await expect(head).toBeOK();
      expect(head.headers()["content-disposition"] ?? "").toContain("attachment");
      expect(head.headers()["x-content-type-options"] ?? "").toBe("nosniff");

      // ---------------------------------------- an image still takes its own path
      const [imageChooser] = await Promise.all([
        page.waitForEvent("filechooser"),
        page.getByRole("button", { name: "Insert image" }).click(),
      ]);
      await imageChooser.setFiles([
        { name: "photo.png", mimeType: "image/png", buffer: PHOTO_PNG },
      ]);
      await expect(images(page)).toHaveCount(1, { timeout: UPLOAD_MS });
      // …and produced no attachment card, which is what keeps the two flows apart.
      await expect(cards(page)).toHaveCount(3);
      // An image node stores only its `attachmentId` — never the filename, and
      // never a `src` — so the fourth reference is what proves it persisted.
      await waitForStored(
        page,
        workspaceId,
        noteId,
        (document) => (document.match(/"attachmentId"/gu) ?? []).length === 4,
      );

      // ------------------------------------------------- survives a reload
      await page.reload();
      await expect(page.getByRole("textbox", { name: /Note content/u })).toBeVisible({
        timeout: ROUTE_COMPILE_MS,
      });
      await expect(cards(page)).toHaveCount(3, { timeout: UPLOAD_MS });

      // ------------------------------------------ the invariant, stated verbatim
      const stored = await storedDocument(page.request, workspaceId, noteId);
      expect(stored).toContain('"attachment"');
      expect(stored).toContain('"attachmentId"');
      expect(stored).not.toContain("blob:");
      // The contract has no attribute that could hold one, which is *why*.
      expect(stored).not.toContain('"src"');
      expect(stored).not.toContain('"href"');
      for (const patch of patchBodies) {
        expect(patch).not.toContain("blob:");
        expect(patch).not.toContain('"src"');
      }

      // --------------------------------------------------- confirmed deletion
      await cards(page).filter({ hasText: "bundle.zip" }).getByTestId("attachment-remove").click();
      const confirm = page.getByRole("dialog", { name: "Delete this file?" });
      await expect(confirm).toBeVisible();
      // Nothing is destroyed until the writer confirms.
      await expect(cards(page)).toHaveCount(3);

      await page.getByTestId("attachment-delete-confirm").click();
      await expect(cards(page)).toHaveCount(2, { timeout: UPLOAD_MS });
      await expect(cards(page).filter({ hasText: "bundle.zip" })).toHaveCount(0);
      await waitForStored(
        page,
        workspaceId,
        noteId,
        (document) => !document.includes("bundle.zip"),
      );

      const afterDelete = await storedDocument(page.request, workspaceId, noteId);
      expect(afterDelete).not.toContain("bundle.zip");
      // Two cards remain, so deletion removed exactly the one that was confirmed.
      expect(afterDelete).toContain("report.pdf");
      expect(afterDelete).toContain("notes.txt");
    } finally {
      await context.close();
    }
  });

  test("preserves original file names and bytes regardless of extension or MIME", async ({
    browser,
  }) => {
    test.slow();
    const context = await browser.newContext();
    const page = await context.newPage();
    const uploads = [
      { name: "budget.XLSX", mimeType: "application/zip", buffer: BUNDLE_ZIP },
      { name: "memo.docx", mimeType: "application/zip", buffer: BUNDLE_ZIP },
      { name: "archive", mimeType: "application/octet-stream", buffer: NOTES_TXT },
      { name: "installer.exe", mimeType: "application/x-msdownload", buffer: NOTES_TXT },
      { name: "custom.unknown", mimeType: "application/x-custom", buffer: NOTES_TXT },
      { name: "photo.png", mimeType: "image/png", buffer: PHOTO_PNG },
    ];

    try {
      await register(page, identity("original-files"));
      const workspaceId = await createWorkspace(page, `Files ${randomUUID().slice(0, 8)}`);
      const noteId = await createNote(page, workspaceId, "Original file note");
      await page.goto(`/workspaces/${workspaceId}/notes/${noteId}`);
      const body = page.getByRole("textbox", { name: /Note content/u });
      await expect(body).toBeVisible({ timeout: ROUTE_COMPILE_MS });
      await body.click();
      await expect(page.getByTestId("note-attachment-file-input")).toHaveAttribute("accept", "");
      await pickAttachments(page, uploads);
      await expect(cards(page)).toHaveCount(uploads.length, { timeout: UPLOAD_MS });
      // Choosing Attach file stores even an image as a generic original file.
      await expect(images(page)).toHaveCount(0);
      await waitForStored(page, workspaceId, noteId, (document) =>
        uploads.every((file) => document.includes(file.name)),
      );
      await page.reload();
      await expect(body).toBeVisible({ timeout: ROUTE_COMPILE_MS });
      await expect(cards(page)).toHaveCount(uploads.length, { timeout: UPLOAD_MS });
      for (const file of uploads) {
        const card = cards(page).filter({ hasText: file.name });
        const [download] = await Promise.all([
          page.waitForEvent("download", { timeout: UPLOAD_MS }),
          card.getByTestId("attachment-download").click(),
        ]);
        expect(download.suggestedFilename()).toBe(file.name);
        expect(await download.failure()).toBeNull();
        const response = await page.request.get(download.url(), { headers: { Origin: appUrl } });
        await expect(response).toBeOK();
        expect(await response.body()).toEqual(file.buffer);
        expect(response.headers()["content-disposition"] ?? "").toContain("attachment");
        expect(response.headers()["x-content-type-options"] ?? "").toBe("nosniff");
      }
    } finally {
      await context.close();
    }
  });

  test("refuses an empty file without ever contacting the server", async ({ browser }) => {
    test.slow();
    const context = await browser.newContext();
    const page = await context.newPage();
    let uploads = 0;
    page.on("request", (request) => {
      if (request.method() === "POST" && request.url().includes("/attachments")) uploads += 1;
    });

    try {
      await register(page, identity("empty-file"));
      const workspaceId = await createWorkspace(page, `Files ${randomUUID().slice(0, 8)}`);
      const noteId = await createNote(page, workspaceId, "Empty file note");
      await page.goto(`/workspaces/${workspaceId}/notes/${noteId}`);
      await expect(page.getByRole("textbox", { name: /Note content/u })).toBeVisible({
        timeout: ROUTE_COMPILE_MS,
      });
      await page.getByRole("textbox", { name: /Note content/u }).click();
      await pickAttachments(page, [
        { name: "empty.unknown", mimeType: "application/octet-stream", buffer: Buffer.alloc(0) },
      ]);
      await expect(page.getByText(/empty\.unknown is empty/u)).toBeVisible({ timeout: UPLOAD_MS });
      await expect(cards(page)).toHaveCount(0);
      expect(uploads).toBe(0);
    } finally {
      await context.close();
    }
  });
});
