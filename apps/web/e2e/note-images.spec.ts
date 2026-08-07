import { randomUUID } from "node:crypto";
import { deflateSync } from "node:zlib";

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import { latestActionLink } from "./mailpit";

/**
 * Part 42 browser verification.
 *
 * Four of the five things this part claims can only be proved in a real browser:
 *
 * 1. **`img.naturalWidth > 0`.** This is the CORP assertion, and the single most
 *    likely regression in the whole part. `main.ts` installs bare `helmet()`,
 *    whose default `Cross-Origin-Resource-Policy: same-origin` makes a browser
 *    HARD-BLOCK an `<img>` served from `:3001` into a page on `:3000`. jsdom does
 *    not enforce CORP at all, so no unit test can ever see the failure — the
 *    element renders, the src is right, and the image is simply blank.
 * 2. **Drop position at 125 % zoom.** `PageContainer` sits inside a
 *    `transform: scale()`; only a real layout engine can show that
 *    `posAtCoords` needs no zoom compensation.
 * 3. **A real clipboard/drag payload.** jsdom implements neither `DataTransfer`
 *    nor a usable `ClipboardEvent`.
 * 4. **Persistence.** That the saved document survives a reload, and that
 *    neither it nor the PATCH that produced it mentions a temporary URL.
 */

const disposable = process.env.PLAYWRIGHT_DISPOSABLE_TEST_RUN === "true";
const apiUrl = process.env.PLAYWRIGHT_API_URL ?? "http://localhost:3001";
const appUrl = process.env.PLAYWRIGHT_APP_URL ?? "http://localhost:3000";
const password = "Fresh1!Password";

/** Generous enough for a cold Next dev-server route compile. */
const ROUTE_COMPILE_MS = 45_000;
/** Upload, sharp processing, and the debounced save all have to complete. */
const UPLOAD_MS = 30_000;

/* -------------------------------------------------------------------------- */
/* A real PNG, built here rather than committed as a fixture                    */
/* -------------------------------------------------------------------------- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/**
 * A genuine, decodable PNG of a solid colour.
 *
 * Generated rather than committed because the assertion that matters is
 * `naturalWidth > 0` — the browser must really decode these bytes — and because
 * the Part 41 pipeline sniffs magic bytes and re-encodes every variant, so a
 * placeholder file would be rejected before any of that ran. `node:zlib` is a
 * builtin, so this adds no dependency (ADR 0008 pins the package matrix).
 */
function pngBytes(width: number, height: number, rgb: readonly [number, number, number]): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: truecolour RGB
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let row = 0; row < height; row += 1) {
    const start = row * (1 + width * 3);
    raw[start] = 0; // filter: none
    for (let column = 0; column < width; column += 1) {
      const at = start + 1 + column * 3;
      raw[at] = rgb[0];
      raw[at + 1] = rgb[1];
      raw[at + 2] = rgb[2];
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const RED_PNG = pngBytes(64, 32, [220, 40, 40]);
// The resize journey needs headroom: a 64 px figure cannot shrink by 120 px,
// because `IMAGE_MIN_WIDTH_PX` (48) correctly clamps the drag long before that.
const WIDE_PNG = pngBytes(400, 200, [220, 40, 40]);
const BLUE_PNG = pngBytes(48, 48, [40, 60, 220]);
const GREEN_PNG = pngBytes(32, 64, [40, 200, 90]);

/* -------------------------------------------------------------------------- */
/* Local helpers, per this repository's per-spec convention                     */
/* -------------------------------------------------------------------------- */

function identity(role: string) {
  const suffix = randomUUID();
  return { name: `Images ${role}`, email: `images.${role}.${suffix}@example.test`, password };
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
  expect(response.ok()).toBeTruthy();
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
  expect(response.ok()).toBeTruthy();
  // `GET /notes/:noteId` returns a `NoteDetail`, which carries `content` at the
  // TOP level — there is no `note` envelope on this endpoint.
  const body = (await response.json()) as { content: unknown };
  return JSON.stringify(body.content);
}

const images = (page: Page) => page.locator(".notted-editor-content img.notted-image");

/**
 * Picks files through the REAL user path: the toolbar's "Insert image" button
 * opens the native picker, and only then are files supplied.
 *
 * Driving `input[type=file]` directly with `setInputFiles` does NOT work, and
 * should not: `useImageUploads` records the caret position and the insertion
 * controller at the moment the pick is REQUESTED, and deliberately ignores a
 * selection that no request is waiting for. A file that appears on the input
 * without a preceding request has no known insertion point, so dropping it is
 * the correct behaviour — which means the only faithful way to exercise the
 * upload is to open the picker first.
 */
async function pickImages(
  page: Page,
  files: readonly { name: string; mimeType: string; buffer: Buffer }[],
): Promise<void> {
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.getByRole("button", { name: "Insert image" }).click(),
  ]);
  await chooser.setFiles(files.map((file) => ({ ...file })));
}

async function waitForSaved(page: Page): Promise<void> {
  await expect(page.getByTestId("note-save-status")).toHaveText(/Saved\./u, { timeout: UPLOAD_MS });
}

test.describe.serial("Part 42 image insertion in a real browser", () => {
  test.skip(
    !disposable,
    "image verification requires PLAYWRIGHT_DISPOSABLE_TEST_RUN=true and disposable PostgreSQL, Redis, MinIO, and Mailpit",
  );

  test("uploads, renders, persists, and never stores a temporary URL", async ({ browser }) => {
    test.slow();
    const context = await browser.newContext();
    const page = await context.newPage();
    const workspaceName = `Images ${randomUUID().slice(0, 8)}`;
    let workspaceId: string | null = null;

    /*
     * Every PATCH the page sends is captured, because the Verify clause is about
     * what is *sent*, not only about what is finally stored: a document that
     * carried a `blob:` URL for one request and was corrected afterwards would
     * still have persisted one.
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
      const noteId = await createNote(page, workspaceId, "Image note");
      await page.goto(`/workspaces/${workspaceId}/notes/${noteId}`);

      const body = page.getByRole("textbox", { name: /Note content/u });
      await expect(body).toBeVisible({ timeout: ROUTE_COMPILE_MS });
      await body.click();
      await page.keyboard.type("Figures below.");

      // ------------------------------------------------- three files at once
      await pickImages(page, [
        { name: "red.png", mimeType: "image/png", buffer: RED_PNG },
        { name: "blue.png", mimeType: "image/png", buffer: BLUE_PNG },
        { name: "green.png", mimeType: "image/png", buffer: GREEN_PNG },
      ]);

      await expect(images(page)).toHaveCount(3, { timeout: UPLOAD_MS });
      // Placeholders are decorations, so they leave nothing behind.
      await expect(page.locator(".notted-image-upload")).toHaveCount(0, { timeout: UPLOAD_MS });
      await waitForSaved(page);

      /*
       * THE CORP ASSERTION.
       *
       * A blocked image still has a `src`, still has an `alt`, and still lays
       * out — it is simply never decoded. `naturalWidth` is the only property
       * that distinguishes "the browser fetched and decoded these bytes" from
       * "the browser refused them", which is why it is asserted rather than
       * visibility.
       */
      for (let index = 0; index < 3; index += 1) {
        const decoded = await images(page)
          .nth(index)
          .evaluate((element) => {
            const image = element as HTMLImageElement;
            return { natural: image.naturalWidth, src: image.currentSrc || image.src };
          });
        expect(decoded.natural, `image ${index} was not decoded (CORP?)`).toBeGreaterThan(0);
        // Proxied through the API, never a storage URL and never a blob.
        expect(decoded.src).toContain("/api/v1/workspaces/");
        expect(decoded.src).not.toContain("blob:");
      }

      // ------------------------------------------------- survives a reload
      await page.reload();
      await expect(page.getByRole("textbox", { name: /Note content/u })).toBeVisible({
        timeout: ROUTE_COMPILE_MS,
      });
      await expect(images(page)).toHaveCount(3, { timeout: UPLOAD_MS });
      await expect
        .poll(
          async () =>
            images(page)
              .first()
              .evaluate((el) => (el as HTMLImageElement).naturalWidth),
          {
            timeout: UPLOAD_MS,
          },
        )
        .toBeGreaterThan(0);

      // ------------------------------------------ the Verify clause, verbatim
      const stored = await storedDocument(page.request, workspaceId, noteId);
      expect(stored).toContain('"image"');
      expect(stored).toContain('"attachmentId"');
      expect(stored).not.toContain("blob:");
      expect(stored).not.toContain("data:image");
      // The contract has no attribute that could hold one, which is *why*.
      expect(stored).not.toContain('"src"');

      expect(patchBodies.length).toBeGreaterThan(0);
      for (const patch of patchBodies) {
        expect(patch).not.toContain("blob:");
        expect(patch).not.toContain("data:image");
      }
    } finally {
      if (workspaceId !== null) {
        await page.request
          .delete(`${apiUrl}/api/v1/workspaces/${workspaceId}`, {
            headers: { Origin: appUrl },
            data: { confirm: true, expectedName: workspaceName },
          })
          .catch(() => undefined);
      }
      await context.close();
    }
  });

  test("drops an image where the pointer is, at 125% zoom", async ({ browser }) => {
    test.slow();
    const context = await browser.newContext();
    const page = await context.newPage();
    const workspaceName = `Images ${randomUUID().slice(0, 8)}`;
    let workspaceId: string | null = null;

    try {
      await register(page, identity("dropper"));
      workspaceId = await createWorkspace(page, workspaceName);
      const noteId = await createNote(page, workspaceId, "Drop note");
      await page.goto(`/workspaces/${workspaceId}/notes/${noteId}`);

      const body = page.getByRole("textbox", { name: /Note content/u });
      await expect(body).toBeVisible({ timeout: ROUTE_COMPILE_MS });
      await body.click();
      await page.keyboard.type("First paragraph.");
      await page.keyboard.press("Enter");
      await page.keyboard.type("Second paragraph.");
      await page.keyboard.press("Enter");
      await page.keyboard.type("Third paragraph.");
      await waitForSaved(page);

      /*
       * 125 %: the sheet is inside a `transform: scale(1.25)`.
       *
       * The pointer coordinates below come from `boundingBox()`, which — like
       * `getBoundingClientRect()` inside ProseMirror's `posAtCoords` — is
       * ALREADY reported in scaled viewport space. Both sides carry the same
       * scale, so nothing is divided by 1.25 anywhere. If the implementation
       * ever "corrects" for zoom, this test lands the image in the wrong
       * paragraph and fails, which is exactly what it is here to catch.
       */
      // `exact: true` is required: "Zoom controls", "Zoom out", and "Zoom in"
      // all start with "Zoom", so a substring match is a strict-mode violation.
      // Selected by VALUE, matching the proven helper in `page-layout.spec.ts`.
      await page.getByLabel("Zoom", { exact: true }).selectOption("1.25");
      await expect(page.getByTestId("notted-page-paper")).toBeVisible();

      const target = page.locator(".notted-editor-content p", { hasText: "Second paragraph." });
      const box = await target.boundingBox();
      expect(box).not.toBeNull();
      if (box === null) throw new Error("the target paragraph has no layout box");

      await page.evaluate(
        async ({ base64, x, y }) => {
          const binary = atob(base64);
          const bytes = new Uint8Array(binary.length);
          for (let index = 0; index < binary.length; index += 1) {
            bytes[index] = binary.charCodeAt(index);
          }
          const file = new File([bytes], "dropped.png", { type: "image/png" });
          const transfer = new DataTransfer();
          transfer.items.add(file);
          const surface = document.querySelector(".notted-editor-content");
          if (surface === null) throw new Error("the editing surface is missing");
          for (const type of ["dragenter", "dragover", "drop"]) {
            surface.dispatchEvent(
              new DragEvent(type, {
                bubbles: true,
                cancelable: true,
                clientX: x,
                clientY: y,
                dataTransfer: transfer,
              }),
            );
          }
        },
        {
          base64: BLUE_PNG.toString("base64"),
          // Mid-height of the middle paragraph, a little in from its left edge.
          x: box.x + Math.min(24, box.width / 2),
          y: box.y + box.height / 2,
        },
      );

      await expect(images(page)).toHaveCount(1, { timeout: UPLOAD_MS });
      await waitForSaved(page);

      // Landed between the paragraph it was dropped into and the one after it —
      // never at the start or the end of the document.
      const order = await page.evaluate(() => {
        const surface = document.querySelector(".notted-editor-content");
        return [...(surface?.children ?? [])].map((child) =>
          child.querySelector("img.notted-image") !== null || child.matches(".notted-image-figure")
            ? "image"
            : (child.textContent ?? "").trim(),
        );
      });
      const imageIndex = order.indexOf("image");
      expect(imageIndex).toBeGreaterThan(0);
      expect(imageIndex).toBeLessThan(order.length - 1);
      expect(order[0]).toBe("First paragraph.");
      expect(order.at(-1)).toBe("Third paragraph.");

      const decoded = await images(page)
        .first()
        .evaluate((element) => (element as HTMLImageElement).naturalWidth);
      expect(decoded).toBeGreaterThan(0);

      const stored = await storedDocument(page.request, workspaceId, noteId);
      expect(stored).not.toContain("blob:");
      expect(stored).not.toContain("data:image");
    } finally {
      if (workspaceId !== null) {
        await page.request
          .delete(`${apiUrl}/api/v1/workspaces/${workspaceId}`, {
            headers: { Origin: appUrl },
            data: { confirm: true, expectedName: workspaceName },
          })
          .catch(() => undefined);
      }
      await context.close();
    }
  });

  test("cancelling an upload leaves the document exactly as it was", async ({ browser }) => {
    test.slow();
    const context = await browser.newContext();
    const page = await context.newPage();
    const workspaceName = `Images ${randomUUID().slice(0, 8)}`;
    let workspaceId: string | null = null;

    try {
      await register(page, identity("canceller"));
      workspaceId = await createWorkspace(page, workspaceName);
      const noteId = await createNote(page, workspaceId, "Cancel note");
      await page.goto(`/workspaces/${workspaceId}/notes/${noteId}`);

      const body = page.getByRole("textbox", { name: /Note content/u });
      await expect(body).toBeVisible({ timeout: ROUTE_COMPILE_MS });
      await body.click();
      await page.keyboard.type("Untouched paragraph.");
      await waitForSaved(page);
      const before = await storedDocument(page.request, workspaceId, noteId);

      // Hold the upload open so Cancel is reachable, then cancel it.
      await page.route(`${apiUrl}/api/v1/workspaces/*/notes/*/attachments`, async (route) => {
        if (route.request().method() !== "POST") {
          await route.continue();
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 20_000));
        await route.abort();
      });

      await pickImages(page, [{ name: "slow.png", mimeType: "image/png", buffer: RED_PNG }]);

      const placeholder = page.locator(".notted-image-upload");
      await expect(placeholder).toHaveCount(1);
      await expect(placeholder.getByRole("progressbar")).toBeVisible();
      await placeholder.getByRole("button", { name: "Cancel" }).click();

      await expect(placeholder).toHaveCount(0);
      await expect(images(page)).toHaveCount(0);

      // The strongest statement of "no document change": the stored document is
      // byte-identical, so autosave never even had anything to send.
      expect(await storedDocument(page.request, workspaceId, noteId)).toBe(before);
      await expect(body).toContainText("Untouched paragraph.");
    } finally {
      if (workspaceId !== null) {
        await page.request
          .delete(`${apiUrl}/api/v1/workspaces/${workspaceId}`, {
            headers: { Origin: appUrl },
            data: { confirm: true, expectedName: workspaceName },
          })
          .catch(() => undefined);
      }
      await context.close();
    }
  });
});

/**
 * Part 43 browser verification.
 *
 * Everything below needs a real layout engine and cannot be proved in jsdom:
 *
 * 1. **Resize.** jsdom reports every rect as zero, so a drag has no measurable
 *    result there. Only a browser can show that the committed width is the width
 *    the pointer produced, that it is clamped to the printable column, and that
 *    it survives a reload.
 * 2. **Keyboard operation of the floating toolbar.** The toolbar is portalled
 *    past the paper's `transform`, and its roving tab index is only meaningful
 *    against real focus.
 * 3. **Print rendering.** `emulateMedia({ media: "print" })` is the only way to
 *    apply `print.css` and see that alignment, wrap, and the caption survive —
 *    which is Part 43's explicit acceptance criterion.
 */
test.describe.serial("Part 43 image manipulation in a real browser", () => {
  test.skip(
    !disposable,
    "image verification requires PLAYWRIGHT_DISPOSABLE_TEST_RUN=true and disposable PostgreSQL, Redis, MinIO, and Mailpit",
  );

  const figure = (page: Page) => page.locator(".notted-editor-content .notted-image-figure");

  /** Registers, creates a workspace and note, opens it, and uploads one image. */
  async function noteWithOneImage(
    page: Page,
    role: string,
    title: string,
    buffer: Buffer = RED_PNG,
  ): Promise<{ workspaceId: string; workspaceName: string; noteId: string }> {
    const workspaceName = `Images ${randomUUID().slice(0, 8)}`;
    await register(page, identity(role));
    const workspaceId = await createWorkspace(page, workspaceName);
    const noteId = await createNote(page, workspaceId, title);
    await page.goto(`/workspaces/${workspaceId}/notes/${noteId}`);

    const body = page.getByRole("textbox", { name: /Note content/u });
    await expect(body).toBeVisible({ timeout: ROUTE_COMPILE_MS });
    await body.click();
    await page.keyboard.type("Surrounding paragraph.");
    await pickImages(page, [{ name: "figure.png", mimeType: "image/png", buffer }]);
    await expect(images(page)).toHaveCount(1, { timeout: UPLOAD_MS });
    await waitForSaved(page);
    return { workspaceId, workspaceName, noteId };
  }

  async function deleteWorkspace(page: Page, workspaceId: string, name: string): Promise<void> {
    await page.request
      .delete(`${apiUrl}/api/v1/workspaces/${workspaceId}`, {
        headers: { Origin: appUrl },
        data: { confirm: true, expectedName: name },
      })
      .catch(() => undefined);
  }

  /** The stored image node's attributes, read straight from the API. */
  async function storedImageAttrs(
    request: APIRequestContext,
    workspaceId: string,
    noteId: string,
  ): Promise<Record<string, unknown>> {
    const raw = await storedDocument(request, workspaceId, noteId);
    const parsed = JSON.parse(raw) as { content?: { type?: string; attrs?: unknown }[] };
    const image = (parsed.content ?? []).find((node) => node.type === "image");
    expect(image, "the stored document has no image node").toBeTruthy();
    return (image?.attrs ?? {}) as Record<string, unknown>;
  }

  test("a resized image keeps its size across a reload", async ({ browser }) => {
    test.slow();
    const context = await browser.newContext();
    const page = await context.newPage();
    let created: { workspaceId: string; workspaceName: string; noteId: string } | null = null;

    try {
      created = await noteWithOneImage(page, "resizer", "Resize note", WIDE_PNG);

      // Selecting the figure is what reveals the handles; they are hidden for an
      // unselected image so an unselected note is never covered in chrome.
      await images(page).first().click();
      const handle = page.locator('.notted-image-handle[data-image-handle="se"]');
      await expect(handle).toBeVisible();

      const before = await figure(page).evaluate(
        (element) => element.getBoundingClientRect().width,
      );
      const box = await handle.boundingBox();
      expect(box).not.toBeNull();
      if (box === null) throw new Error("the resize handle has no layout box");

      // Drag the corner 120 px to the left. The deltas and the element's rect are
      // both in scaled viewport space; nothing is divided by the zoom anywhere.
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 - 60, box.y + box.height / 2, { steps: 5 });
      await page.mouse.move(box.x + box.width / 2 - 120, box.y + box.height / 2, { steps: 5 });
      await page.mouse.up();

      const after = await figure(page).evaluate((element) => element.getBoundingClientRect().width);
      expect(after).toBeLessThan(before - 50);
      await waitForSaved(page);

      const attrs = await storedImageAttrs(page.request, created.workspaceId, created.noteId);
      const storedWidth = attrs.width;
      expect(typeof storedWidth).toBe("number");
      expect(storedWidth as number).toBeGreaterThan(0);
      // The stored value is the layout width, so it must match what is on screen.
      expect(Math.abs((storedWidth as number) - after)).toBeLessThan(4);
      // Ratio-locked by default: the height moved with the width.
      expect(typeof attrs.height).toBe("number");

      // One gesture, one history step: undo restores the original size.
      //
      // This has to run *before* the reload. A reloaded editor is constructed
      // fresh with an empty history stack, so Ctrl+Z there asserts nothing about
      // how the resize was committed.
      await page.getByRole("textbox", { name: /Note content/u }).click();
      await images(page).first().click();
      await page.keyboard.press("Control+z");
      await expect
        .poll(async () => figure(page).evaluate((element) => element.getBoundingClientRect().width))
        .toBeGreaterThan(after + 50);

      // Redo, so the reload below is checking the resized width that was saved.
      await page.keyboard.press("Control+Shift+z");
      await expect
        .poll(async () => figure(page).evaluate((element) => element.getBoundingClientRect().width))
        .toBeLessThan(before - 50);
      // Not `waitForSaved`: undo-then-redo lands on the document that was already
      // persisted above, so autosave correctly reports no unsaved changes rather
      // than announcing a second save. Settling back to idle is the real property
      // — it proves redo restored the saved state exactly, not merely something
      // narrower than `before`.
      await expect(page.getByTestId("note-save-status")).toHaveText(/No unsaved changes\./u, {
        timeout: UPLOAD_MS,
      });

      // ------------------------------------------------- survives a reload
      await page.reload();
      await expect(page.getByRole("textbox", { name: /Note content/u })).toBeVisible({
        timeout: ROUTE_COMPILE_MS,
      });
      await expect(images(page)).toHaveCount(1, { timeout: UPLOAD_MS });
      const reloaded = await figure(page).evaluate(
        (element) => element.getBoundingClientRect().width,
      );
      expect(Math.abs(reloaded - after)).toBeLessThan(4);
    } finally {
      if (created !== null) await deleteWorkspace(page, created.workspaceId, created.workspaceName);
      await context.close();
    }
  });

  test("a keyboard alignment change persists and prints the same way", async ({ browser }) => {
    test.slow();
    const context = await browser.newContext();
    const page = await context.newPage();
    let created: { workspaceId: string; workspaceName: string; noteId: string } | null = null;

    try {
      created = await noteWithOneImage(page, "aligner", "Alignment note");
      await images(page).first().click();

      const toolbar = page.getByRole("toolbar", { name: "Image options" });
      await expect(toolbar).toBeVisible();

      // Keyboard only from here: focus the first control, walk the roving tab
      // index with the arrow keys, and activate with Enter.
      await toolbar.getByRole("button", { name: "Align image left" }).focus();
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("ArrowRight");
      await expect(toolbar.getByRole("button", { name: "Align image right" })).toBeFocused();
      await page.keyboard.press("Enter");

      await expect(toolbar.getByRole("button", { name: "Align image right" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await expect(figure(page)).toHaveAttribute("data-align", "right");

      // Wrap the text beside it, still from the keyboard.
      await toolbar.getByRole("button", { name: "Wrap text beside the image" }).focus();
      await page.keyboard.press("Enter");
      await expect(figure(page)).toHaveAttribute("data-wrap", "inline");
      await waitForSaved(page);

      const attrs = await storedImageAttrs(page.request, created.workspaceId, created.noteId);
      expect(attrs).toMatchObject({ align: "right", wrap: "inline", fullWidth: false });

      // ------------------------------------------------- survives a reload
      await page.reload();
      await expect(page.getByRole("textbox", { name: /Note content/u })).toBeVisible({
        timeout: ROUTE_COMPILE_MS,
      });
      await expect(figure(page)).toHaveAttribute("data-align", "right");
      await expect(figure(page)).toHaveAttribute("data-wrap", "inline");

      // ------------------------------------------- renders the same in print
      await page.emulateMedia({ media: "print" });
      const printed = await figure(page).evaluate((element) => {
        const style = window.getComputedStyle(element);
        const handles = element.querySelector(".notted-image-handles");
        return {
          float: style.float,
          handles: handles === null ? "none" : window.getComputedStyle(handles).display,
        };
      });
      expect(printed.float).toBe("right");
      // Editing chrome never prints.
      expect(printed.handles).toBe("none");
      await page.emulateMedia({ media: "screen" });
    } finally {
      if (created !== null) await deleteWorkspace(page, created.workspaceId, created.workspaceName);
      await context.close();
    }
  });

  test("a caption survives a reload and prints as text", async ({ browser }) => {
    test.slow();
    const context = await browser.newContext();
    const page = await context.newPage();
    let created: { workspaceId: string; workspaceName: string; noteId: string } | null = null;

    try {
      created = await noteWithOneImage(page, "captioner", "Caption note");

      const caption = page.getByRole("textbox", { name: "Image caption" });
      await expect(caption).toBeVisible();
      await caption.click();
      await caption.fill("Figure 1 — quarterly revenue");
      // Enter commits immediately; the 500 ms debounce is a safety net, not the
      // only path, and typing must never write once per keystroke.
      await page.keyboard.press("Enter");
      await waitForSaved(page);

      const attrs = await storedImageAttrs(page.request, created.workspaceId, created.noteId);
      expect(attrs.caption).toBe("Figure 1 — quarterly revenue");

      // ------------------------------------------------- survives a reload
      await page.reload();
      await expect(page.getByRole("textbox", { name: /Note content/u })).toBeVisible({
        timeout: ROUTE_COMPILE_MS,
      });
      await expect(page.getByRole("textbox", { name: "Image caption" })).toHaveValue(
        "Figure 1 — quarterly revenue",
      );

      // ------------------------------------------- renders the same in print
      await page.emulateMedia({ media: "print" });
      const printed = await figure(page).evaluate((element) => {
        const field = element.querySelector(".notted-image-caption__input");
        const text = element.querySelector(".notted-image-caption__text");
        return {
          field: field === null ? "missing" : window.getComputedStyle(field).display,
          text: text === null ? "missing" : window.getComputedStyle(text).display,
          content: text?.textContent ?? "",
        };
      });
      // A text field's typed value does not print in any engine, so the caption
      // is printed from the committed text instead.
      expect(printed.field).toBe("none");
      expect(printed.text).not.toBe("none");
      expect(printed.content).toBe("Figure 1 — quarterly revenue");
      await page.emulateMedia({ media: "screen" });
    } finally {
      if (created !== null) await deleteWorkspace(page, created.workspaceId, created.workspaceName);
      await context.close();
    }
  });
});
