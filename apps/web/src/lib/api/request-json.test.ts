import { describe, expect, it, vi } from "vitest";

import { requestJson } from "./request-json";

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
