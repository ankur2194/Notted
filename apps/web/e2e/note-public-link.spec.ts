import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { deflateSync } from "node:zlib";

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import { latestActionLink } from "./mailpit";

/*
 * Task 13 — the note public link journey, driven through the real
 * `ShareModal` "Public link" section and the real unauthenticated `/p/:token`
 * page.
 *
 * WHAT ONLY A BROWSER CAN PROVE HERE: the public link is genuinely
 * unauthenticated. A unit or API test can assert the create/revoke endpoints
 * return the right payloads, but only a *fresh browser context with no
 * cookies* proves that a stranger who received the URL can read the note
 * without ever having signed in, and that revoking it really locks that
 * stranger out on their very next request for the same URL rather than only
 * updating the owner's own management UI.
 */

const disposable = process.env.PLAYWRIGHT_DISPOSABLE_TEST_RUN === "true";
const apiUrl = process.env.PLAYWRIGHT_API_URL ?? "http://localhost:3001";
const appUrl = process.env.PLAYWRIGHT_APP_URL ?? "http://localhost:3000";
const password = "Fresh1!Password";
const FILE_BYTES = Buffer.from("Public file content: 2026-09-17\n", "utf8");
const FILE_NAME = "public-report.txt";
// Decodable image bytes, not a filename masquerading as a PNG. The image must
// still render on the public page after a generic file has been added.
function pngBytes(): Buffer {
  const crcTable = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1)
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    crcTable[index] = value >>> 0;
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const inner = Buffer.concat([Buffer.from(type, "latin1"), data]);
    let crc = 0xffffffff;
    for (const byte of inner) crc = (crcTable[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, inner, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(8, 0);
  header.writeUInt32BE(8, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.alloc(8 * (1 + 8 * 3)))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function storedReferences(content: unknown): {
  readonly fileId: string | null;
  readonly hasImage: boolean;
} {
  if (typeof content !== "object" || content === null || !("content" in content))
    return { fileId: null, hasImage: false };
  const root = content as { content: unknown };
  if (!Array.isArray(root.content)) return { fileId: null, hasImage: false };
  const file = root.content.find(
    (node: unknown) =>
      typeof node === "object" &&
      node !== null &&
      "type" in node &&
      node.type === "attachment" &&
      "attrs" in node &&
      typeof node.attrs === "object" &&
      node.attrs !== null &&
      "name" in node.attrs &&
      node.attrs.name === FILE_NAME,
  ) as { attrs?: { attachmentId?: unknown } } | undefined;
  return {
    fileId: typeof file?.attrs?.attachmentId === "string" ? file.attrs.attachmentId : null,
    hasImage: root.content.some(
      (node: unknown) =>
        typeof node === "object" && node !== null && "type" in node && node.type === "image",
    ),
  };
}

function identity(role: string) {
  const suffix = randomUUID();
  return { name: `Notes ${role}`, email: `notes.${role}.${suffix}@example.test`, password };
}

async function register(page: Page, account: ReturnType<typeof identity>): Promise<void> {
  await page.goto("/register");
  await page.getByLabel("Name").fill(account.name);
  await page.getByLabel("Email").fill(account.email);
  await page.getByLabel("Password", { exact: true }).fill(account.password);
  await page.getByLabel("Confirm password").fill(account.password);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.goto(await latestActionLink(page.request, account.email, "Verify your Notted email"));
  await expect(page.getByRole("heading", { name: "Email verified" })).toBeVisible();
  await page.goto("/login?redirect=%2Fworkspaces");
  await page.getByLabel("Email", { exact: true }).first().fill(account.email);
  await page.getByLabel("Password").fill(account.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/workspaces$/u);
}

async function createWorkspace(page: Page, name: string): Promise<string> {
  await page.getByRole("button", { name: "Create workspace", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Create a workspace" });
  await dialog.getByLabel("Workspace name").fill(name);
  await dialog.getByRole("button", { name: "Create workspace", exact: true }).click();
  await expect(page).toHaveURL(/\/workspaces\/[0-9a-f-]+$/u);
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

test.describe.serial("Task 13 note public link journey", () => {
  test.skip(
    !disposable,
    "note public link journey requires PLAYWRIGHT_DISPOSABLE_TEST_RUN=true and disposable PostgreSQL, Redis, MinIO, and Mailpit",
  );

  test("create, view anonymously, then revoke", async ({ page, browser }) => {
    test.slow();
    const workspaceName = `Notes Public ${randomUUID().slice(0, 8)}`;
    const noteTitle = `Public link note ${randomUUID().slice(0, 8)}`;
    let workspaceId: string | null = null;
    try {
      await register(page, identity("owner"));
      workspaceId = await createWorkspace(page, workspaceName);

      const noteResult = await apiPost(
        page.request,
        `/api/v1/workspaces/${workspaceId}/notes`,
        { title: noteTitle, projectId: null, folderId: null, parentId: null },
        randomUUID(),
      );
      const note = noteResult.note as { id: string };

      await page.goto(`/workspaces/${workspaceId}/notes/${note.id}`);
      // Drive the actual editor upload path. The file card is only trustworthy
      // once the server-side Yjs projection has written it to the note row.
      const body = page.getByRole("textbox", { name: /Note content/u });
      await expect(body).toBeVisible({ timeout: 45_000 });
      await body.click();
      const [chooser] = await Promise.all([
        page.waitForEvent("filechooser"),
        page.getByRole("button", { name: "Attach file" }).click(),
      ]);
      await chooser.setFiles([{ name: FILE_NAME, mimeType: "text/plain", buffer: FILE_BYTES }]);
      await expect(
        page.locator(".notted-editor-content .notted-attachment").filter({ hasText: FILE_NAME }),
      ).toHaveCount(1, { timeout: 30_000 });
      const [imageChooser] = await Promise.all([
        page.waitForEvent("filechooser"),
        page.getByRole("button", { name: "Insert image" }).click(),
      ]);
      await imageChooser.setFiles([
        { name: "public-photo.png", mimeType: "image/png", buffer: pngBytes() },
      ]);
      await expect
        .poll(
          async () => {
            const response = await page.request.get(
              `${apiUrl}/api/v1/workspaces/${workspaceId}/notes/${note.id}`,
              { headers: { Origin: appUrl } },
            );
            if (!response.ok()) return false;
            const stored = (await response.json()) as { content: unknown };
            const references = storedReferences(stored.content);
            return (
              references.fileId !== null &&
              references.hasImage &&
              !JSON.stringify(stored.content).includes('"src"') &&
              !JSON.stringify(stored.content).includes('"href"')
            );
          },
          { timeout: 60_000 },
        )
        .toBe(true);

      await page.getByRole("button", { name: "Share" }).click();
      const shareDialog = page.getByRole("dialog", { name: "Share note" });
      await shareDialog.getByRole("button", { name: "Create link" }).click();
      await expect(shareDialog.getByText("Public link created.", { exact: true })).toBeVisible();
      const publicUrl = await shareDialog.getByLabel("Public note link").inputValue();
      expect(publicUrl).not.toBe("");

      // A fresh, unauthenticated browser context — no cookies from `page` at
      // all — is the only honest way to prove a stranger with just the URL
      // can read the note without ever signing in.
      const publicContext = await browser.newContext({ acceptDownloads: true });
      try {
        const publicPage = await publicContext.newPage();
        const initial = await publicPage.goto(publicUrl);
        expect(initial?.status()).toBe(200);
        await expect(publicPage.getByRole("heading", { name: noteTitle })).toBeVisible();
        expect(await publicContext.cookies()).toEqual([]);
        const publicImage = publicPage.locator(".notted-public-note img.notted-image");
        await expect(publicImage).toHaveCount(1);
        await expect
          .poll(() => publicImage.evaluate((image: HTMLImageElement) => image.naturalWidth))
          .toBeGreaterThan(0);
        const link = publicPage.getByRole("link", { name: `Download ${FILE_NAME}` });
        await expect(link).toBeVisible();
        await expect(link).toHaveAttribute("rel", "noreferrer");
        await expect(link).toHaveAttribute("referrerpolicy", "no-referrer");
        await expect(publicPage.locator('meta[name="referrer"]')).toHaveAttribute(
          "content",
          "no-referrer",
        );
        await expect(link).toHaveAttribute("data-notted-print-hide", "");
        const fileUrl = (await link.getAttribute("href")) ?? "";
        expect(new URL(fileUrl).pathname).toMatch(
          /\/api\/v1\/public\/notes\/[^/]+\/attachments\/[^/]+\/content$/u,
        );
        const stored = await page.request.get(
          `${apiUrl}/api/v1/workspaces/${workspaceId}/notes/${note.id}`,
          { headers: { Origin: appUrl } },
        );
        await expect(stored).toBeOK();
        const fileId = storedReferences(
          ((await stored.json()) as { content: unknown }).content,
        ).fileId;
        expect(fileId).not.toBeNull();
        expect(new URL(fileUrl).pathname).toContain(`/attachments/${fileId}/content`);
        await expect(
          publicPage.getByRole("button", { name: /Attach file|Delete|Preview|Share|Export/iu }),
        ).toHaveCount(0);
        await expect(publicPage.getByRole("textbox", { name: /Note content/u })).toHaveCount(0);

        const [download] = await Promise.all([
          publicPage.waitForEvent("download", { timeout: 30_000 }),
          link.click(),
        ]);
        expect(download.suggestedFilename()).toBe(FILE_NAME);
        expect(await download.failure()).toBeNull();
        expect(await readFile(await download.path())).toEqual(FILE_BYTES);
        const downloadUrl = download.url();
        expect(downloadUrl).toBe(fileUrl);
        const downloadedResponse = await publicContext.request.get(downloadUrl);
        expect(downloadedResponse.status()).toBe(200);
        expect(downloadedResponse.headers()["content-disposition"]).toContain("attachment");
        expect(downloadedResponse.headers()["x-content-type-options"]).toBe("nosniff");
        expect(await downloadedResponse.body()).toEqual(FILE_BYTES);

        await shareDialog.getByRole("button", { name: "Revoke public link" }).click();
        await expect(
          shareDialog.getByText("Public link revoked. It no longer works for anyone who had it."),
        ).toBeVisible();
        const revokedFile = await publicContext.request.get(downloadUrl);
        expect(revokedFile.status()).toBe(404);

        // Re-request the exact same public URL in the same unauthenticated
        // context; the management UI updating is not proof the link itself
        // stopped working for whoever already had it.
        // Next may start streaming its layout with HTTP 200 before the Server
        // Component's notFound() runs. Assert the API's 404 separately and the
        // actual not-found page state rather than a streaming transport status.
        const revokedNote = await publicContext.request.get(
          `${apiUrl}/api/v1/public/notes/${new URL(publicUrl).pathname.split("/").at(-1)}`,
        );
        expect(revokedNote.status()).toBe(404);
        await publicPage.reload();
        await expect(publicPage.getByRole("heading", { name: /doesn't work/iu })).toBeVisible();
      } finally {
        await publicContext.close();
      }
    } finally {
      if (workspaceId !== null)
        await page.request
          .delete(`${apiUrl}/api/v1/workspaces/${workspaceId}`, {
            headers: { Origin: appUrl },
            data: { confirm: true, expectedName: workspaceName },
          })
          .catch(() => undefined);
    }
  });
});
