import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_TIMEOUT_MS, requestJson } from "./request-json";

const parser = (value: unknown) => ({ success: true as const, data: value });

function respond(status: number, body?: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      body === undefined
        ? new Response("not json", { status })
        : new Response(JSON.stringify(body), {
            status,
            headers: { "Content-Type": "application/json" },
          }),
    ),
  );
}

describe("requestJson error bucketing", () => {
  it('surfaces the envelope code on a 422 so the UI can say more than "invalid"', async () => {
    // Part 66's webhook rejections are 422. Without the code every one of them
    // reads as a generic validation failure, and "this URL resolves to a
    // private address" and "the endpoint did not echo the challenge" have
    // entirely different fixes.
    respond(422, { error: { code: "WEBHOOK_URL_REJECTED" } });
    expect(await requestJson("/x", {}, parser)).toEqual({
      ok: false,
      kind: "invalid",
      code: "WEBHOOK_URL_REJECTED",
    });
  });

  it("keeps the 409 vocabulary unchanged", async () => {
    respond(409, { code: "VERSION_CONFLICT" });
    expect(await requestJson("/x", {}, parser)).toEqual({
      ok: false,
      kind: "version-conflict",
      code: "VERSION_CONFLICT",
    });

    respond(409, { code: "TAG_NAME_TAKEN" });
    expect(await requestJson("/x", {}, parser)).toEqual({
      ok: false,
      kind: "conflict",
      code: "TAG_NAME_TAKEN",
    });
  });

  it("promotes VERSION_CONFLICT only on a 409", async () => {
    // The code has no meaning on a validation status, so it must not create a
    // second path into the autosave conflict UI.
    respond(422, { code: "VERSION_CONFLICT" });
    expect(await requestJson("/x", {}, parser)).toMatchObject({ kind: "invalid" });
  });

  it("falls back to the bare kind when the envelope is missing or unparsable", async () => {
    respond(422);
    expect(await requestJson("/x", {}, parser)).toEqual({ ok: false, kind: "invalid" });
    respond(409, { detail: "no code here" });
    expect(await requestJson("/x", {}, parser)).toEqual({ ok: false, kind: "conflict" });
  });
});

/**
 * Answers 200 and records the `RequestInit` the caller actually handed `fetch`,
 * honouring an already-aborted signal the way a real `fetch` does — that
 * rejection is exactly what the `unavailable` bucket is asserted on below.
 */
function captureInit(): { readonly calls: RequestInit[] } {
  const calls: RequestInit[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: unknown, init: RequestInit = {}) => {
      calls.push(init);
      if (init.signal?.aborted === true) throw new DOMException("Aborted", "AbortError");
      return new Response(JSON.stringify({ ok: 1 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
  return { calls };
}

describe("requestJson cancellation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("applies the house default when no timeout is asked for", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    captureInit();

    await requestJson("/x", {}, parser);

    expect(timeout).toHaveBeenCalledWith(DEFAULT_TIMEOUT_MS);
  });

  it("uses a caller's timeout instead", async () => {
    // Part 69's meeting extraction: a model reading a 100 000-character
    // transcript runs well past eight seconds, and aborting it would report a
    // working request as a network fault.
    const timeout = vi.spyOn(AbortSignal, "timeout");
    captureInit();

    await requestJson("/x", {}, parser, { timeoutMs: 120_000 });

    expect(timeout).toHaveBeenCalledWith(120_000);
    expect(timeout).not.toHaveBeenCalledWith(DEFAULT_TIMEOUT_MS);
  });

  it("fails as a retryable outage when the caller's signal is already aborted", async () => {
    captureInit();

    expect(await requestJson("/x", {}, parser, { signal: AbortSignal.abort() })).toEqual({
      ok: false,
      kind: "unavailable",
      retryable: true,
    });
  });

  it("still gives a keepalive request no abort timer", async () => {
    // A timer on a page that is going away either never fires or kills the very
    // flush it was scheduled for, so the keepalive rule is unconditional.
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const { calls } = captureInit();

    await requestJson("/x", { method: "POST", body: "{}" }, parser, {
      keepalive: true,
      timeoutMs: 500,
    });

    expect(timeout).not.toHaveBeenCalled();
    expect(calls[0]?.keepalive).toBe(true);
    expect(calls[0]?.signal).toBeUndefined();
  });

  it("honours a caller's signal alone on a keepalive request", async () => {
    const { calls } = captureInit();

    const result = await requestJson("/x", { method: "POST", body: "{}" }, parser, {
      keepalive: true,
      signal: AbortSignal.abort(),
    });

    expect(calls[0]?.signal).toBeDefined();
    expect(result).toEqual({ ok: false, kind: "unavailable", retryable: true });
  });
});
