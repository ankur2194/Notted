import { MAX_IMAGE_UPLOAD_BYTES } from "@notted/shared-validators";
import { describe, expect, it, vi } from "vitest";

import {
  AUTOMATIC_RETRY_LIMIT,
  checkImageFile,
  createImageUploadManager,
  defaultImageAlt,
  uploadFailureMessage,
} from "./image-uploads";

import type { ImageUploadCall, ImageUploadEvent, ImageUploadManager } from "./image-uploads";
import type { NoteRequestResult } from "./requests";
import type { AttachmentMedia } from "@notted/shared-types";

const target = {
  workspaceId: "30000000-0000-4000-8000-000000000001",
  noteId: "30000000-0000-4000-8000-000000000002",
};

function imageFile(name = "chart.png", type = "image/png", size = 2048): File {
  const file = new File([new Uint8Array([1])], name, { type });
  Object.defineProperty(file, "size", { value: size });
  return file;
}

function media(id: string): AttachmentMedia {
  return {
    id,
    workspaceId: target.workspaceId,
    noteId: target.noteId,
    displayName: "chart.png",
    mimeType: "image/png",
    sizeBytes: 2048,
    status: "ready",
    width: 100,
    height: 50,
    createdAt: "2026-08-06T00:00:00.000Z",
    mediaType: "image",
    variants: {},
    contentPath: "/api/v1/x",
  };
}

interface Deferred {
  readonly call: ImageUploadCall;
  readonly resolve: (result: NoteRequestResult<AttachmentMedia>) => void;
}

interface Harness {
  readonly manager: ImageUploadManager;
  readonly events: ImageUploadEvent[];
  readonly pending: Deferred[];
}

function harness(concurrency?: number): Harness {
  const events: ImageUploadEvent[] = [];
  const pending: Deferred[] = [];
  let nextId = 0;
  const manager = createImageUploadManager({
    concurrency,
    createId: () => `id-${(nextId += 1)}`,
    onEvent: (event) => events.push(event),
    upload: (call) =>
      new Promise<NoteRequestResult<AttachmentMedia>>((resolve) => {
        pending.push({ call, resolve });
      }),
  });
  return { manager, events, pending };
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("client pre-flight", () => {
  it("uses the shared bounds, so client and server cannot drift", () => {
    expect(checkImageFile(imageFile()).ok).toBe(true);
    expect(checkImageFile(imageFile("doc.pdf", "application/pdf")).ok).toBe(false);
    expect(checkImageFile(imageFile("empty.png", "image/png", 0)).ok).toBe(false);
    const tooBig = checkImageFile(imageFile("big.png", "image/png", MAX_IMAGE_UPLOAD_BYTES + 1));
    if (tooBig.ok) throw new Error("expected the oversized image to be refused");
    expect(tooBig.reason).toBe("size");
    expect(tooBig.message).toContain("15 MB");
  });
});

describe("default alt text", () => {
  it("reads the filename as words, without the extension", () => {
    expect(defaultImageAlt("holiday_photo.png")).toBe("holiday photo");
    expect(defaultImageAlt("Quarterly-Results-2026.JPEG")).toBe("Quarterly Results 2026");
    expect(defaultImageAlt("no-extension")).toBe("no extension");
  });

  it("bounds the value and strips control characters from an untrusted name", () => {
    expect(defaultImageAlt(`${"a".repeat(600)}.png`, 500)).toHaveLength(500);
    expect(defaultImageAlt("a\u0000b.png")).toBe("a b");
  });
});

describe("failure copy", () => {
  it("says something actionable for every stable failure kind", () => {
    expect(uploadFailureMessage("a.png", { ok: false, kind: "invalid" })).toContain("rejected");
    expect(uploadFailureMessage("a.png", { ok: false, kind: "forbidden-or-not-found" })).toContain(
      "permission",
    );
    expect(
      uploadFailureMessage("a.png", { ok: false, kind: "unavailable", retryable: true }),
    ).toContain("offline");
    expect(uploadFailureMessage("a.png", { ok: false, kind: "version-conflict" })).toContain(
      "changed elsewhere",
    );
  });
});

describe("the upload queue", () => {
  it("bounds concurrency and starts queued work as slots free up", async () => {
    const { manager, pending } = harness(2);
    manager.enqueue(target, [imageFile("a.png"), imageFile("b.png"), imageFile("c.png")]);
    await flush();

    // Three files, two sockets.
    expect(pending).toHaveLength(2);
    expect(manager.snapshot().map((item) => item.status)).toEqual([
      "uploading",
      "uploading",
      "queued",
    ]);

    pending[0]?.resolve({ ok: true, data: media("30000000-0000-4000-8000-00000000000a") });
    await flush();
    expect(pending).toHaveLength(3);
  });

  it("reuses one idempotency key across every attempt of the same file", async () => {
    const { manager, pending } = harness();
    const [item] = manager.enqueue(target, [imageFile()]);
    await flush();
    const firstKey = pending[0]?.call.idempotencyKey;
    expect(firstKey).toBeDefined();

    // A retryable failure retries automatically once…
    pending[0]?.resolve({ ok: false, kind: "unavailable", retryable: true });
    await flush();
    expect(pending[1]?.call.idempotencyKey).toBe(firstKey);

    // …and the manual retry after that uses the same key again, so a retry after
    // a timeout can never create a second attachment for bytes already stored.
    pending[1]?.resolve({ ok: false, kind: "unavailable", retryable: true });
    await flush();
    manager.retry(item?.id ?? "");
    await flush();
    expect(pending[2]?.call.idempotencyKey).toBe(firstKey);
  });

  it("retries a retryable failure automatically exactly once", async () => {
    const { manager, pending, events } = harness();
    manager.enqueue(target, [imageFile()]);
    await flush();

    for (let attempt = 0; attempt <= AUTOMATIC_RETRY_LIMIT; attempt += 1) {
      pending[attempt]?.resolve({ ok: false, kind: "unavailable", retryable: true });
      await flush();
    }

    expect(pending).toHaveLength(AUTOMATIC_RETRY_LIMIT + 1);
    const failed = events.filter((event) => event.kind === "failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]?.kind === "failed" && failed[0].item.retryable).toBe(true);
  });

  it("never retries a permanent rejection, and offers no Retry for one", async () => {
    const { manager, pending, events } = harness();
    manager.enqueue(target, [imageFile()]);
    await flush();
    pending[0]?.resolve({ ok: false, kind: "invalid" });
    await flush();

    expect(pending).toHaveLength(1);
    const failed = events.find((event) => event.kind === "failed");
    expect(failed?.kind === "failed" && failed.item.retryable).toBe(false);
  });

  it("rejects an unsupported file before any request is made", async () => {
    const { manager, pending, events } = harness();
    const [item] = manager.enqueue(target, [imageFile("notes.pdf", "application/pdf")]);
    await flush();

    expect(pending).toHaveLength(0);
    expect(item?.status).toBe("error");
    // A file the shared bounds already reject would be rejected identically
    // forever, so no Retry button is offered for it.
    expect(item?.retryable).toBe(false);
    expect(events[0]?.kind).toBe("failed");
  });

  it("reports progress as a ratio", async () => {
    const { manager, pending, events } = harness();
    manager.enqueue(target, [imageFile()]);
    await flush();
    pending[0]?.call.onProgress({ loaded: 512, total: 2048, ratio: 0.25 });

    const progress = events.filter((event) => event.kind === "progress");
    expect(progress).toHaveLength(1);
    expect(progress[0]?.kind === "progress" && progress[0].item.progress).toBe(0.25);
  });

  it("emits the attachment on success and forgets the task", async () => {
    const { manager, pending, events } = harness();
    manager.enqueue(target, [imageFile()]);
    await flush();
    pending[0]?.resolve({ ok: true, data: media("30000000-0000-4000-8000-00000000000a") });
    await flush();

    const uploaded = events.find((event) => event.kind === "uploaded");
    expect(uploaded?.kind === "uploaded" && uploaded.attachment.id).toBe(
      "30000000-0000-4000-8000-00000000000a",
    );
    expect(manager.snapshot()).toHaveLength(0);
  });

  it("aborts the transfer on cancel and removes the item", async () => {
    const { manager, pending, events } = harness();
    const [item] = manager.enqueue(target, [imageFile()]);
    await flush();
    const aborted = vi.fn();
    pending[0]?.call.signal.addEventListener("abort", aborted);

    manager.cancel(item?.id ?? "");
    expect(aborted).toHaveBeenCalledTimes(1);
    expect(events.at(-1)?.kind).toBe("removed");
    expect(manager.snapshot()).toHaveLength(0);
  });

  it("deletes an attachment that lands after the writer already cancelled", async () => {
    const { manager, pending, events } = harness();
    const [item] = manager.enqueue(target, [imageFile()]);
    await flush();
    manager.cancel(item?.id ?? "");

    // The server had no way to know: the bytes were already stored.
    pending[0]?.resolve({ ok: true, data: media("30000000-0000-4000-8000-00000000000a") });
    await flush();

    const orphaned = events.find((event) => event.kind === "orphaned");
    expect(orphaned?.kind === "orphaned" && orphaned.attachment.id).toBe(
      "30000000-0000-4000-8000-00000000000a",
    );
    // Nothing was ever inserted for it.
    expect(events.some((event) => event.kind === "uploaded")).toBe(false);
  });

  it("dismisses a failed item without retrying it", async () => {
    const { manager, pending, events } = harness();
    const [item] = manager.enqueue(target, [imageFile()]);
    await flush();
    pending[0]?.resolve({ ok: false, kind: "invalid" });
    await flush();

    manager.dismiss(item?.id ?? "");
    expect(events.at(-1)?.kind).toBe("removed");
    expect(manager.snapshot()).toHaveLength(0);
  });

  it("refuses to retry something that is not a retryable error", async () => {
    const { manager, pending } = harness();
    const [item] = manager.enqueue(target, [imageFile()]);
    await flush();
    pending[0]?.resolve({ ok: false, kind: "invalid" });
    await flush();

    manager.retry(item?.id ?? "");
    await flush();
    expect(pending).toHaveLength(1);
  });

  it("cancels everything on teardown", async () => {
    const { manager, pending } = harness(3);
    manager.enqueue(target, [imageFile("a.png"), imageFile("b.png")]);
    await flush();
    const aborts = pending.map((entry) => {
      const spy = vi.fn();
      entry.call.signal.addEventListener("abort", spy);
      return spy;
    });

    manager.cancelAll();
    for (const spy of aborts) expect(spy).toHaveBeenCalledTimes(1);
    expect(manager.snapshot()).toHaveLength(0);
  });

  it("notifies subscribers with the current list", async () => {
    const { manager, pending } = harness();
    const listener = vi.fn();
    manager.subscribe(listener);
    manager.enqueue(target, [imageFile()]);
    await flush();
    expect(listener).toHaveBeenCalled();

    pending[0]?.resolve({ ok: true, data: media("30000000-0000-4000-8000-00000000000a") });
    await flush();
    expect(listener.mock.calls.at(-1)?.[0]).toEqual([]);
  });

  it("survives an upload implementation that throws", async () => {
    const events: ImageUploadEvent[] = [];
    const manager = createImageUploadManager({
      onEvent: (event) => events.push(event),
      upload: () => {
        throw new Error("boom");
      },
    });
    manager.enqueue(target, [imageFile()]);
    await flush();
    await flush();
    // Treated as transient rather than losing the task in limbo; the automatic
    // retry runs, then it surfaces as a retryable error.
    expect(events.some((event) => event.kind === "failed")).toBe(true);
  });
});
