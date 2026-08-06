import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IMAGE_UPLOAD_FILE_FIELD, uploadNoteImage } from "./upload-request";

const workspaceId = "30000000-0000-4000-8000-000000000001";
const noteId = "30000000-0000-4000-8000-000000000002";
const attachmentId = "30000000-0000-4000-8000-000000000003";

function attachmentPayload() {
  return {
    attachment: {
      id: attachmentId,
      workspaceId,
      noteId,
      displayName: "chart.png",
      mimeType: "image/png",
      sizeBytes: 1024,
      status: "ready",
      width: 1200,
      height: 800,
      createdAt: "2026-08-06T00:00:00.000Z",
      mediaType: "image",
      variants: {
        full: { width: 1200, height: 800, bytes: 900, mimeType: "image/png" },
        blur: { dataUri: "data:image/webp;base64,AAAA", width: 16, height: 11 },
      },
      contentPath: `/api/v1/workspaces/${workspaceId}/attachments/${attachmentId}/content`,
    },
  };
}

/**
 * A minimal `XMLHttpRequest` double.
 *
 * jsdom ships an XHR implementation, but it cannot be pointed at a server here,
 * and the behaviour under test is entirely in how this module reads a response —
 * status mapping, header parsing, progress plumbing, and abort. Replacing the
 * constructor keeps every one of those observable without a network.
 */
class FakeXhr {
  static instances: FakeXhr[] = [];

  public status = 0;
  public response = "";
  public timeout = 0;
  public withCredentials = false;
  public responseType = "";
  public readonly headers = new Map<string, string>();
  public readonly upload = new EventTarget();
  public sentBody: FormData | null = null;
  public aborted = false;
  public method = "";
  public url = "";
  private responseHeaders: Record<string, string> = {};
  private readonly listeners = new Map<string, Array<() => void>>();

  constructor() {
    FakeXhr.instances.push(this);
  }

  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(name: string, value: string): void {
    this.headers.set(name, value);
  }

  addEventListener(type: string, listener: () => void): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  removeEventListener(): void {
    /* not exercised */
  }

  getResponseHeader(name: string): string | null {
    return this.responseHeaders[name] ?? null;
  }

  send(body: FormData): void {
    this.sentBody = body;
  }

  abort(): void {
    this.aborted = true;
    this.fire("abort");
  }

  fire(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }

  respond(status: number, body: string, headers: Record<string, string> = {}): void {
    this.status = status;
    this.response = body;
    this.responseHeaders = headers;
    this.fire("load");
  }

  emitProgress(loaded: number, total: number, lengthComputable = true): void {
    this.upload.dispatchEvent(
      Object.assign(new Event("progress"), { loaded, total, lengthComputable }),
    );
  }
}

function pngFile(size = 2048): File {
  const file = new File([new Uint8Array([1, 2, 3])], "chart.png", { type: "image/png" });
  Object.defineProperty(file, "size", { value: size });
  return file;
}

function upload(overrides: Record<string, unknown> = {}) {
  return uploadNoteImage({
    workspaceId,
    noteId,
    file: pngFile(),
    idempotencyKey: "idem-key-0001",
    ...overrides,
  });
}

function latest(): FakeXhr {
  const instance = FakeXhr.instances.at(-1);
  if (instance === undefined) throw new Error("no XMLHttpRequest was constructed");
  return instance;
}

describe("uploadNoteImage", () => {
  beforeEach(() => {
    FakeXhr.instances = [];
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("posts multipart with credentials and the caller's idempotency key", async () => {
    const promise = upload();
    const xhr = latest();

    expect(xhr.method).toBe("POST");
    expect(xhr.url).toContain(`/api/v1/workspaces/${workspaceId}/notes/${noteId}/attachments`);
    // The session cookie has to reach the API origin.
    expect(xhr.withCredentials).toBe(true);
    expect(xhr.headers.get("Idempotency-Key")).toBe("idem-key-0001");
    // `Origin` is a forbidden header name: the browser sets it and a page cannot
    // forge it, which is exactly what makes the server's check meaningful.
    expect([...xhr.headers.keys()]).not.toContain("Origin");
    expect(xhr.sentBody?.get(IMAGE_UPLOAD_FILE_FIELD)).toBeInstanceOf(File);
    expect(xhr.timeout).toBeGreaterThan(0);

    xhr.respond(201, JSON.stringify(attachmentPayload()));
    const result = await promise;
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.id).toBe(attachmentId);
  });

  it("reports upload progress, which is the entire reason this is not fetch", async () => {
    const onProgress = vi.fn();
    const promise = upload({ onProgress });
    const xhr = latest();

    xhr.emitProgress(512, 2048);
    xhr.emitProgress(2048, 2048);
    expect(onProgress).toHaveBeenNthCalledWith(1, { loaded: 512, total: 2048, ratio: 0.25 });
    expect(onProgress).toHaveBeenNthCalledWith(2, { loaded: 2048, total: 2048, ratio: 1 });

    xhr.respond(201, JSON.stringify(attachmentPayload()));
    await promise;
  });

  it("reports an indeterminate ratio when the length is not computable", async () => {
    const onProgress = vi.fn();
    const promise = upload({ onProgress });
    const xhr = latest();
    xhr.emitProgress(512, 0, false);
    expect(onProgress).toHaveBeenCalledWith({ loaded: 512, total: null, ratio: null });
    xhr.respond(201, JSON.stringify(attachmentPayload()));
    await promise;
  });

  it.each<[number, string, boolean | undefined]>([
    [400, "invalid", undefined],
    [413, "invalid", undefined],
    [415, "invalid", undefined],
    [422, "invalid", undefined],
    [401, "forbidden-or-not-found", undefined],
    [403, "forbidden-or-not-found", undefined],
    [404, "forbidden-or-not-found", undefined],
    [429, "unavailable", true],
    [500, "unavailable", true],
    [503, "unavailable", true],
    [405, "unavailable", false],
  ])("maps HTTP %s onto the shared failure vocabulary", async (status, kind, retryable) => {
    const promise = upload();
    latest().respond(status, "{}");
    const result = await promise;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe(kind);
    expect(result.retryable).toBe(retryable);
  });

  it("distinguishes a version conflict from a generic conflict", async () => {
    const first = upload();
    latest().respond(409, JSON.stringify({ error: { code: "VERSION_CONFLICT" } }));
    const versioned = await first;
    expect(versioned.ok === false && versioned.kind).toBe("version-conflict");

    const second = upload();
    latest().respond(409, "not json");
    const generic = await second;
    expect(generic.ok === false && generic.kind).toBe("conflict");
  });

  it("parses Retry-After so a client never invents its own backoff", async () => {
    const promise = upload();
    latest().respond(503, "{}", { "Retry-After": "12" });
    const result = await promise;
    expect(result.ok === false && result.retryAfterMs).toBe(12_000);
  });

  it.each(["error", "timeout"])("treats a %s as retryable", async (event) => {
    const promise = upload();
    latest().fire(event);
    const result = await promise;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.retryable).toBe(true);
  });

  it("rejects a body the shared schema does not accept, rather than trusting it", async () => {
    const promise = upload();
    latest().respond(201, JSON.stringify({ attachment: { id: "not-a-uuid" } }));
    const result = await promise;
    expect(result.ok === false && result.kind).toBe("invalid");
  });

  it("aborts on signal and settles as a non-retryable failure", async () => {
    const controller = new AbortController();
    const promise = upload({ signal: controller.signal });
    const xhr = latest();
    controller.abort();
    expect(xhr.aborted).toBe(true);
    const result = await promise;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.retryable).toBe(false);
  });

  it("never opens a request for an already-aborted signal or an invalid target", async () => {
    const aborted = AbortSignal.abort();
    expect((await upload({ signal: aborted })).ok).toBe(false);
    expect((await upload({ workspaceId: "nope" })).ok).toBe(false);
    expect((await upload({ idempotencyKey: "short" })).ok).toBe(false);
    expect(FakeXhr.instances).toHaveLength(0);
  });
});
