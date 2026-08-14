import { randomUUID } from "node:crypto";
import { deflateSync } from "node:zlib";

import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
  type Page,
} from "@playwright/test";

import { latestActionLink } from "./mailpit";

const disposable = process.env.PLAYWRIGHT_DISPOSABLE_TEST_RUN === "true";
const apiUrl = process.env.PLAYWRIGHT_API_URL ?? "http://localhost:3001";
const appUrl = process.env.PLAYWRIGHT_APP_URL ?? "http://localhost:3000";
const password = "Fresh1!Password";

interface Account {
  readonly name: string;
  readonly email: string;
  readonly password: string;
}

function identity(role: string): Account {
  const suffix = randomUUID();
  const emailRole = role.toLowerCase().replaceAll(/[^a-z0-9]+/gu, "-");
  return {
    name: `History ${role}`,
    email: `history.${emailRole}.${suffix}@example.test`,
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

async function addViewer(
  owner: Page,
  viewer: Page,
  workspaceId: string,
  workspaceName: string,
): Promise<void> {
  const account = identity("viewer");
  await provisionAccount(viewer, account);
  await apiPost(owner.request, `/api/v1/workspaces/${workspaceId}/invitations`, {
    email: account.email,
    role: "viewer",
  });
  const invitation = new URL(
    await latestActionLink(owner.request, account.email, `Join ${workspaceName}`),
  );
  const token = invitation.searchParams.get("token");
  expect(token).not.toBeNull();
  await apiPost(viewer.request, "/api/v1/invitations/accept", { token });
}

function crc32(buffer: Buffer): number {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (0xedb88320 & -(value & 1));
  }
  return (value ^ 0xffffffff) >>> 0;
}

function pngBytes(): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const inner = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(inner));
    return Buffer.concat([length, inner, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(32, 0);
  header.writeUInt32BE(16, 4);
  header[8] = 8;
  header[9] = 6;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(32 * 4, 120)]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: 16 }, () => row)))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

async function upload(
  page: Page,
  workspaceId: string,
  noteId: string,
  file: { name: string; mimeType: string; buffer: Buffer },
): Promise<{ id: string; width: number | null; height: number | null }> {
  const response = await page.request.post(
    `${apiUrl}/api/v1/workspaces/${workspaceId}/notes/${noteId}/attachments`,
    {
      headers: { Origin: appUrl, "Idempotency-Key": randomUUID() },
      multipart: { file },
    },
  );
  await expectOk(response);
  return (
    (await response.json()) as {
      attachment: { id: string; width: number | null; height: number | null };
    }
  ).attachment;
}

test.describe.serial("Part 56 version history", () => {
  test.skip(
    !disposable,
    "Requires the real disposable app, PostgreSQL, Redis, MinIO, and Meilisearch.",
  );

  test("previews a semantic diff, restores complex content, and refreshes owner/viewer UI", async ({
    browser,
  }) => {
    const ownerContext = await browser.newContext();
    const viewerContext = await browser.newContext();
    const foreignContext = await browser.newContext();
    const owner = await ownerContext.newPage();
    const viewer = await viewerContext.newPage();
    const foreign = await foreignContext.newPage();
    const workspaceName = `History ${randomUUID().slice(0, 8)}`;

    try {
      await provisionAccount(owner, identity("owner"));
      const createdWorkspace = await apiPost<{ workspace: { id: string } }>(
        owner.request,
        "/api/v1/workspaces",
        {
          name: workspaceName,
          slug: `history-${randomUUID().slice(0, 8)}`,
          description: null,
          settings: { defaultPageSize: "a4" },
        },
        randomUUID(),
      );
      const workspaceId = createdWorkspace.workspace.id;
      const created = await apiPost<{ note: { id: string; version: number } }>(
        owner.request,
        `/api/v1/workspaces/${workspaceId}/notes`,
        { title: "Attachment shell", projectId: null, folderId: null, parentId: null },
        randomUUID(),
      );
      const noteId = created.note.id;
      const image = await upload(owner, workspaceId, noteId, {
        name: "history.png",
        mimeType: "image/png",
        buffer: pngBytes(),
      });
      const fileBytes = Buffer.from("retained history bytes\n");
      const file = await upload(owner, workspaceId, noteId, {
        name: "history.txt",
        mimeType: "text/plain",
        buffer: fileBytes,
      });
      const original = {
        type: "doc",
        content: [
          {
            type: "heading",
            attrs: { level: 2 },
            content: [{ type: "text", text: "Before heading", marks: [{ type: "bold" }] }],
          },
          {
            type: "table",
            content: [
              {
                type: "tableRow",
                content: [
                  {
                    type: "tableHeader",
                    attrs: { colspan: 1, rowspan: 1, colwidth: null },
                    content: [{ type: "paragraph", content: [{ type: "text", text: "Header" }] }],
                  },
                ],
              },
            ],
          },
          {
            type: "image",
            attrs: {
              attachmentId: image.id,
              alt: "Historical diagram",
              caption: "Original caption",
              width: image.width,
              height: image.height,
              align: "right",
              wrap: "inline",
              fullWidth: false,
            },
          },
          {
            type: "attachment",
            attrs: {
              attachmentId: file.id,
              name: "history.txt",
              mimeType: "text/plain",
              sizeBytes: fileBytes.byteLength,
            },
          },
        ],
      };
      const checkpoint = await apiPatch<{ note: { version: number } }>(
        owner.request,
        `/api/v1/workspaces/${workspaceId}/notes/${noteId}`,
        { expectedVersion: created.note.version, title: "History original", content: original },
      );
      const current = await apiPatch<{ note: { version: number } }>(
        owner.request,
        `/api/v1/workspaces/${workspaceId}/notes/${noteId}`,
        {
          expectedVersion: checkpoint.note.version,
          title: "History changed",
          content: {
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: "Changed current paragraph" }],
              },
            ],
          },
        },
      );
      const versions = await apiGet<{ items: readonly { id: string; version: number }[] }>(
        owner.request,
        `/api/v1/workspaces/${workspaceId}/notes/${noteId}/versions?limit=20`,
      );
      const sourceVersionId = versions.items.find(
        (version) => version.version === checkpoint.note.version,
      )?.id;
      expect(sourceVersionId).toBeDefined();
      await addViewer(owner, viewer, workspaceId, workspaceName);

      await provisionAccount(foreign, identity("foreign tenant"));
      const foreignWorkspace = await apiPost<{ workspace: { id: string } }>(
        foreign.request,
        "/api/v1/workspaces",
        {
          name: `Foreign ${randomUUID().slice(0, 8)}`,
          slug: `foreign-${randomUUID().slice(0, 8)}`,
          description: null,
          settings: { defaultPageSize: "a4" },
        },
        randomUUID(),
      );
      const foreignDetail = await foreign.request.get(
        `${apiUrl}/api/v1/workspaces/${foreignWorkspace.workspace.id}/notes/${noteId}/versions/${sourceVersionId}`,
      );
      expect(foreignDetail.status()).toBe(404);
      const foreignRestore = await foreign.request.post(
        `${apiUrl}/api/v1/workspaces/${foreignWorkspace.workspace.id}/notes/${noteId}/versions/${sourceVersionId}/restore`,
        {
          headers: { Origin: appUrl },
          data: { expectedVersion: current.note.version },
        },
      );
      expect(foreignRestore.status()).toBe(404);

      const notePath = `/workspaces/${workspaceId}/notes/${noteId}`;
      await Promise.all([owner.goto(notePath), viewer.goto(notePath)]);
      await expect(owner.getByRole("heading", { name: "History changed" })).toBeVisible();
      await expect(viewer.getByRole("heading", { name: "History changed" })).toBeVisible();

      // A real navigation has hydrated the client trigger when it can open the dialog.
      const trigger = owner.getByRole("button", { name: "Version history" });
      await trigger.click();
      const history = owner.getByRole("dialog", { name: "Version history" });
      await expect(history).toBeVisible();
      await history.getByRole("button", { name: /Version 2/u }).click();

      const before = history.getByRole("region", { name: "Before — selected version" });
      const after = history.getByRole("region", { name: "After — current version" });
      await expect(before).toContainText(/Before[\s\S]*heading/u);
      await expect(before.getByText("Deleted:", { exact: true }).first()).toBeAttached();
      await expect(after).toContainText(/Changed[\s\S]*current[\s\S]*paragraph/u);
      await expect(after.getByText("Added:", { exact: true }).first()).toBeAttached();

      const historicalImage = history.getByRole("img", { name: "Historical diagram" });
      await expect(historicalImage).toBeVisible();
      await expect
        .poll(
          () => historicalImage.evaluate((element) => (element as HTMLImageElement).naturalWidth),
          { timeout: 15_000 },
        )
        .toBeGreaterThan(0);
      const downloadLink = history.getByRole("link", { name: "Download history.txt" });
      await expect(downloadLink).toBeVisible();
      const [download] = await Promise.all([owner.waitForEvent("download"), downloadLink.click()]);
      expect(download.suggestedFilename()).toBe("history.txt");
      const downloadStream = await download.createReadStream();
      const downloadedChunks: Buffer[] = [];
      for await (const chunk of downloadStream) downloadedChunks.push(Buffer.from(chunk));
      expect(Buffer.concat(downloadedChunks)).toEqual(fileBytes);

      owner.once("dialog", (confirmation) => confirmation.accept());
      await history.getByRole("button", { name: "Restore this version" }).click();
      const restoredVersion = current.note.version + 1;
      await expect(history).toContainText(
        `Version 2 was restored as new version ${restoredVersion}.`,
      );
      await expect(
        history.getByRole("button", {
          name: new RegExp(`Version ${restoredVersion} · Current`, "u"),
        }),
      ).toBeVisible();

      await history.getByRole("button", { name: "Close" }).click();
      await expect(owner.getByRole("heading", { name: "History original" })).toBeVisible();
      await expect(owner.getByRole("table")).toContainText("Header");
      await expect(owner.getByRole("img", { name: "Historical diagram" })).toBeVisible();

      await expect
        .poll(
          async () => {
            const response = await owner.request.get(
              `${apiUrl}/api/v1/workspaces/${workspaceId}/search/suggestions?query=History%20original&limit=8`,
            );
            return (
              response.ok() && JSON.stringify(await response.json()).includes("History original")
            );
          },
          { timeout: 30_000, intervals: [500, 1_000, 2_000] },
        )
        .toBe(true);

      // This reload now verifies persistence rather than compensating for a
      // failed client invalidation/Server Component refresh above.
      await owner.reload();
      await expect(owner.getByRole("heading", { name: "History original" })).toBeVisible();
      await expect(owner.getByRole("table")).toContainText("Header");
      await expect(owner.getByRole("img", { name: "Historical diagram" })).toBeVisible();
      await expect(owner.getByRole("link", { name: "Download history.txt" })).toBeVisible();

      // Part 56 has no push channel: an authorized collaborator converges on refresh.
      await viewer.reload();
      await expect(viewer.getByRole("heading", { name: "History original" })).toBeVisible();
      await viewer.getByRole("button", { name: "Version history" }).click();
      const viewerHistory = viewer.getByRole("dialog", { name: "Version history" });
      await viewerHistory.getByRole("button", { name: /Version 2/u }).click();
      await expect(
        viewerHistory.getByText("Edit permission is required to restore."),
      ).toBeVisible();
      await expect(viewerHistory.getByRole("button", { name: "Restore this version" })).toHaveCount(
        0,
      );
    } finally {
      await Promise.all([ownerContext.close(), viewerContext.close(), foreignContext.close()]);
    }
  });
});
