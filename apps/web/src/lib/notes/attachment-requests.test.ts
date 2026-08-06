import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_IMAGE_VARIANT,
  attachmentContentUrl,
  attachmentEntries,
  attachmentEntry,
  deleteAttachment,
  requestNoteAttachments,
} from "./attachment-requests";

import type { AttachmentMedia } from "@notted/shared-types";

const workspaceId = "30000000-0000-4000-8000-000000000001";
const noteId = "30000000-0000-4000-8000-000000000002";
const attachmentId = "30000000-0000-4000-8000-000000000003";

function media(overrides: Partial<AttachmentMedia> = {}): AttachmentMedia {
  return {
    id: attachmentId,
    workspaceId,
    noteId,
    displayName: "chart.png",
    mimeType: "image/png",
    sizeBytes: 4096,
    status: "ready",
    width: 2400,
    height: 1600,
    createdAt: "2026-08-06T00:00:00.000Z",
    mediaType: "image",
    variants: {
      full: { width: 2000, height: 1333, bytes: 900, mimeType: "image/jpeg" },
      medium: { width: 800, height: 533, bytes: 200, mimeType: "image/webp" },
      thumbnail: { width: 200, height: 133, bytes: 40, mimeType: "image/webp" },
      blur: { dataUri: "data:image/webp;base64,AAAA", width: 16, height: 11 },
    },
    contentPath: `/api/v1/workspaces/${workspaceId}/attachments/${attachmentId}/content`,
    ...overrides,
  };
}

describe("attachment content URLs", () => {
  it("always addresses the authorized proxy, never a storage host", () => {
    const url = attachmentContentUrl(workspaceId, attachmentId);
    expect(url).toContain(`/api/v1/workspaces/${workspaceId}/attachments/${attachmentId}/content`);
    expect(url).toContain(`variant=${DEFAULT_IMAGE_VARIANT}`);
    // No presigned URLs anywhere in the frontend: MinIO is unreachable from a
    // browser and every read is re-authorized.
    expect(url).not.toContain("X-Amz-Signature");
    expect(url).not.toContain(":9000");
  });

  it("addresses each servable variant explicitly", () => {
    expect(attachmentContentUrl(workspaceId, attachmentId, "thumbnail")).toContain(
      "variant=thumbnail",
    );
    expect(attachmentContentUrl(workspaceId, attachmentId, "medium")).toContain("variant=medium");
  });
});

describe("attachmentEntry", () => {
  it("projects the metadata the node view needs and nothing else", () => {
    const entry = attachmentEntry(media());
    expect(entry).toEqual({
      attachmentId,
      displayName: "chart.png",
      status: "ready",
      // The `full` rendition's own measurements, not the original upload's.
      width: 2000,
      height: 1333,
      blurDataUri: "data:image/webp;base64,AAAA",
      sources: {
        full: attachmentContentUrl(workspaceId, attachmentId, "full"),
        medium: attachmentContentUrl(workspaceId, attachmentId, "medium"),
        thumbnail: attachmentContentUrl(workspaceId, attachmentId, "thumbnail"),
      },
    });
    // An object key must never reach a client (ADR 0005).
    expect(JSON.stringify(entry)).not.toContain("key");
  });

  it("falls back through the variants and tolerates a missing blur", () => {
    const entry = attachmentEntry(
      media({
        variants: { medium: { width: 800, height: 533, bytes: 1, mimeType: "image/webp" } },
      }),
    );
    expect(entry.width).toBe(800);
    // A missing placeholder is never an error; the frame simply has no blur.
    expect(entry.blurDataUri).toBeNull();
  });

  it("falls back to the attachment's own dimensions when no variant is measured", () => {
    const entry = attachmentEntry(media({ variants: {} }));
    expect(entry.width).toBe(2400);
    expect(entry.height).toBe(1600);
  });

  it("maps a whole listing", () => {
    expect(attachmentEntries({ items: [media()] })).toHaveLength(1);
  });
});

describe("attachment requests", () => {
  const fetchMock = vi.fn<typeof fetch>();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("lists a note's attachments with credentials", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ items: [media()] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const result = await requestNoteAttachments(workspaceId, noteId);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.items).toHaveLength(1);

    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.credentials).toBe("include");
    expect(init?.cache).toBe("no-store");
  });

  it("rejects a body the shared schema does not accept", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ items: [{ id: "nope" }] }), { status: 200 }),
    );
    const result = await requestNoteAttachments(workspaceId, noteId);
    expect(result.ok === false && result.kind).toBe("invalid");
  });

  it.each([
    [403, "forbidden-or-not-found"],
    [404, "forbidden-or-not-found"],
    [400, "invalid"],
    [503, "unavailable"],
  ])("maps HTTP %s onto the shared failure vocabulary", async (status, kind) => {
    fetchMock.mockResolvedValue(new Response("{}", { status }));
    const result = await requestNoteAttachments(workspaceId, noteId);
    expect(result.ok === false && result.kind).toBe(kind);
  });

  it("treats a transport failure as retryable", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));
    const result = await requestNoteAttachments(workspaceId, noteId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.retryable).toBe(true);
  });

  it("validates identifiers before issuing a request", async () => {
    expect((await requestNoteAttachments("nope", noteId)).ok).toBe(false);
    expect((await deleteAttachment(workspaceId, "nope")).ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("deletes an attachment through the workspace-scoped route", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ id: attachmentId, deleted: true }), { status: 200 }),
    );
    const result = await deleteAttachment(workspaceId, attachmentId);
    expect(result.ok).toBe(true);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      `/api/v1/workspaces/${workspaceId}/attachments/${attachmentId}`,
    );
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("DELETE");
  });
});
