// Part 70 — the grammar check, and the three things that must hold.
//
// 1. AT MOST TWO PROVIDER CALLS. Every test counts `complete()`, because that
//    count is what a workspace is billed.
// 2. EVERY OFFSET IS RE-CHECKED AGAINST THE TEXT THAT WAS SENT. A model that
//    points past the end of a paragraph, points backwards, or points at another
//    workspace's segment id must not have that reach the writer.
// 3. A DROP IS SILENT AND PARTIAL. One bad suggestion loses that suggestion, not
//    the whole answer — the good ones in the same reply still come back.
//
// Plain object stubs, no Nest testing module — the house style for a service
// whose behaviour is a pipeline rather than a wiring diagram.

import { HttpStatus } from "@nestjs/common";
import { aiGrammarCheckRequestSchema } from "@notted/shared-validators";
import { describe, expect, it, vi } from "vitest";

import { GrammarService } from "./grammar.service";

import type { AuthenticatedPrincipal, GrammarSegment } from "@notted/shared-types";

const USER_ID = "a0000000-0000-4000-8000-000000000001";
const WORKSPACE_ID = "a0000000-0000-4000-8100-000000000001";

const principal: AuthenticatedPrincipal = Object.freeze({
  userId: USER_ID,
  sessionId: "session",
  method: "opaque-session",
  assurance: "single-factor",
  authenticatedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  isFresh: true,
});

/** Replays the given model replies, one per `complete()` call. */
function streamStub(...replies: readonly string[]) {
  const complete = vi.fn();
  for (const reply of replies) {
    complete.mockResolvedValueOnce({ text: reply, promptTokens: 10, completionTokens: 5 });
  }
  return { stream: { complete } as never, complete };
}

// "Their going to the store" — offsets 0..5 are "Their".
const SEGMENT_TEXT = "Their going to the store";
const segments: readonly GrammarSegment[] = Object.freeze([
  Object.freeze({ id: "seg-1", text: SEGMENT_TEXT }),
  Object.freeze({ id: "seg-2", text: "It was very very good." }),
]);

function scope() {
  return { principal, workspaceId: WORKSPACE_ID, requestId: null, segments };
}

function reply(...suggestions: unknown[]): string {
  return JSON.stringify({ suggestions });
}

const THEIR_FIX = {
  segmentId: "seg-1",
  start: 0,
  end: 5,
  replacement: "They're",
  message: "Use the contraction of “they are”.",
  category: "grammar",
};

describe("GrammarService.check", () => {
  it("passes a well-formed answer through in one provider call", async () => {
    const { stream, complete } = streamStub(
      reply(THEIR_FIX, {
        segmentId: "seg-2",
        start: 7,
        end: 16,
        replacement: "very",
        message: "“very” is repeated.",
        category: "style",
      }),
    );

    const result = await new GrammarService(stream).check(scope());

    expect(result.suggestions).toEqual([
      THEIR_FIX,
      {
        segmentId: "seg-2",
        start: 7,
        end: 16,
        replacement: "very",
        message: "“very” is repeated.",
        category: "style",
      },
    ]);
    expect(complete).toHaveBeenCalledTimes(1);
    // A batch of segments names no note, so nothing note-scoped is authorized.
    expect(complete.mock.calls[0]?.[0]).toMatchObject({
      workspaceId: WORKSPACE_ID,
      prompt: expect.objectContaining({ feature: "grammar.v1", promptVersion: "grammar.v1" }),
    });
    expect(complete.mock.calls[0]?.[0]?.noteId).toBeUndefined();
  });

  it("returns an empty list for a clean reply without inventing anything", async () => {
    const { stream } = streamStub(reply());
    await expect(new GrammarService(stream).check(scope())).resolves.toEqual({ suggestions: [] });
  });

  it.each([
    ["an end past the segment's length", { ...THEIR_FIX, start: 0, end: SEGMENT_TEXT.length + 1 }],
    ["an empty span", { ...THEIR_FIX, start: 5, end: 5 }],
    ["an inverted span", { ...THEIR_FIX, start: 9, end: 4 }],
    ["a span starting past the end", { ...THEIR_FIX, start: 900, end: 905 }],
  ] as const)("drops a suggestion with %s and keeps the rest of the reply", async (_label, bad) => {
    const good = {
      segmentId: "seg-2",
      start: 0,
      end: 2,
      replacement: "They",
      message: "Name the subject.",
      category: "grammar",
    };
    const { stream, complete } = streamStub(reply(bad, good));

    const result = await new GrammarService(stream).check(scope());

    // A drop is partial and silent: no throw, no second call, the good one lives.
    expect(result.suggestions).toEqual([good]);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("lets the schema refuse a negative offset before the service ever sees it", async () => {
    // `start` is `.min(0)`, so a negative offset fails validation outright — the
    // whole reply is unusable, hence the repair pass and then the 422.
    const negative = reply({ ...THEIR_FIX, start: -3, end: 5 });
    const { stream, complete } = streamStub(negative, negative);

    await expect(new GrammarService(stream).check(scope())).rejects.toMatchObject({
      safeResponse: { code: "AI_OUTPUT_INVALID" },
    });
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("drops a suggestion that replaces text with itself", async () => {
    const { stream } = streamStub(
      reply({ ...THEIR_FIX, replacement: SEGMENT_TEXT.slice(0, 5) }, THEIR_FIX),
    );

    const result = await new GrammarService(stream).check(scope());

    expect(result.suggestions).toEqual([THEIR_FIX]);
  });

  it("drops a suggestion addressing a segment id the request never sent", async () => {
    const { stream } = streamStub(
      reply({ ...THEIR_FIX, segmentId: "seg-from-another-document" }, THEIR_FIX),
    );

    const result = await new GrammarService(stream).check(scope());

    // The map is built from the request, so an id the caller did not send
    // addresses nothing and cannot be answered.
    expect(result.suggestions).toEqual([THEIR_FIX]);
  });

  it("repairs once, under the same feature id, and stops there", async () => {
    const { stream, complete } = streamStub("Sure! Here are some corrections.", reply(THEIR_FIX));

    const result = await new GrammarService(stream).check(scope());

    expect(result.suggestions).toEqual([THEIR_FIX]);
    // Two calls, and each one is a full `complete()` — so each is authorized,
    // gated and metered. Two `ai_usage` rows for one request, correctly labelled.
    expect(complete).toHaveBeenCalledTimes(2);
    const repairPrompt = complete.mock.calls[1]?.[0]?.prompt;
    expect(repairPrompt.feature).toBe("grammar.v1");
    expect(repairPrompt.promptVersion).toBe("grammar.v1");
    expect(repairPrompt.messages).toHaveLength(2);
  });

  it("gives up with a 422 after a second unusable reply, never a third call", async () => {
    const { stream, complete } = streamStub("nope", '{"suggestions": 12}');

    await expect(new GrammarService(stream).check(scope())).rejects.toMatchObject({
      status: HttpStatus.UNPROCESSABLE_ENTITY,
      safeResponse: { code: "AI_OUTPUT_INVALID" },
    });

    expect(complete).toHaveBeenCalledTimes(2);
  });
});

/**
 * The request caps, asserted here rather than in the validators package because
 * they are what stops one paste from becoming an unbounded prompt — and because
 * the untrimmed `text` is a correctness property of THIS feature, not a style
 * choice: the answer's offsets are indices into exactly this string.
 */
describe("aiGrammarCheckRequestSchema", () => {
  const segment = { id: "seg-1", text: "some prose" };

  it("accepts a batch at the ceiling and rejects one over it", () => {
    const twenty = Array.from({ length: 20 }, (_, index) => ({ ...segment, id: `seg-${index}` }));
    expect(aiGrammarCheckRequestSchema.safeParse({ segments: twenty }).success).toBe(true);
    expect(
      aiGrammarCheckRequestSchema.safeParse({ segments: [...twenty, { ...segment, id: "seg-20" }] })
        .success,
    ).toBe(false);
  });

  it("rejects a segment longer than the per-segment ceiling", () => {
    expect(
      aiGrammarCheckRequestSchema.safeParse({ segments: [{ ...segment, text: "x".repeat(2_000) }] })
        .success,
    ).toBe(true);
    expect(
      aiGrammarCheckRequestSchema.safeParse({ segments: [{ ...segment, text: "x".repeat(2_001) }] })
        .success,
    ).toBe(false);
  });

  it.each([
    ["an empty segment list", { segments: [] }],
    ["an empty text", { segments: [{ id: "seg-1", text: "" }] }],
    ["an empty id", { segments: [{ id: "", text: "prose" }] }],
    ["an unknown field", { segments: [{ ...segment, extra: 1 }] }],
  ] as const)("rejects %s", (_label, body) => {
    expect(aiGrammarCheckRequestSchema.safeParse(body).success).toBe(false);
  });

  it("PRESERVES leading whitespace instead of trimming it", () => {
    const parsed = aiGrammarCheckRequestSchema.parse({
      segments: [{ id: "seg-1", text: "   indented prose  " }],
    });
    // Trimming here would shift every offset in the answer to the left, moving
    // each correction onto the wrong characters. See the schema's own comment.
    expect(parsed.segments[0]?.text).toBe("   indented prose  ");
  });
});
