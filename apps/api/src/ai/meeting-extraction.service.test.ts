// Part 69 — the two JSON features, and the three things that must hold.
//
// 1. AT MOST TWO PROVIDER CALLS. Every test here counts `complete()` calls,
//    because that count is what a workspace is billed.
// 2. THE CAPS ARE THE SERVER'S. A model can return four hundred action items;
//    the reviewer must never be shown four hundred.
// 3. A TAG ID CAN ONLY COME FROM THIS WORKSPACE'S POOL. The model contributes
//    names; the server contributes ids, and only ids it read under an explicit
//    `workspace_id` predicate.
//
// Plain object stubs, no Nest testing module — the house style for a service
// whose behaviour is a pipeline rather than a wiring diagram.

import { HttpStatus } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import { MeetingExtractionService } from "./meeting-extraction.service";

import type { AuthenticatedPrincipal } from "@notted/shared-types";

const USER_ID = "a0000000-0000-4000-8000-000000000001";
const WORKSPACE_ID = "a0000000-0000-4000-8100-000000000001";
const OTHER_WORKSPACE_ID = "a0000000-0000-4000-8100-000000000002";
const NOTE_ID = "a0000000-0000-4000-8200-000000000001";
const TAG_ROADMAP = "a0000000-0000-4000-8300-000000000001";
const TAG_INFRA = "a0000000-0000-4000-8300-000000000002";
const FOREIGN_TAG = "a0000000-0000-4000-8300-0000000000ff";

const principal: AuthenticatedPrincipal = Object.freeze({
  userId: USER_ID,
  sessionId: "session",
  method: "opaque-session",
  assurance: "single-factor",
  authenticatedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  isFresh: true,
});

interface PoolRow {
  readonly id: string;
  readonly name: string;
}

/**
 * Pulls the bound value out of a Drizzle `eq(column, value)` condition, so a
 * test can assert which workspace the pool query was actually scoped to rather
 * than trusting that it was scoped at all.
 */
function boundWorkspaceId(condition: unknown): string | undefined {
  const chunks = (condition as { readonly queryChunks?: readonly unknown[] }).queryChunks ?? [];
  for (const chunk of chunks) {
    const value = (chunk as { readonly value?: unknown }).value;
    if (typeof value === "string") return value;
  }
  return undefined;
}

/** A tag table spanning two workspaces; the stub only ever serves the one asked for. */
function databaseStub(byWorkspace: Readonly<Record<string, readonly PoolRow[]>>) {
  const conditions: unknown[] = [];
  const limits: number[] = [];

  const db = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn((condition: unknown) => {
          conditions.push(condition);
          const workspaceId = boundWorkspaceId(condition) ?? "";
          return {
            limit: vi.fn((limit: number) => {
              limits.push(limit);
              return Promise.resolve([...(byWorkspace[workspaceId] ?? [])]);
            }),
          };
        }),
      })),
    })),
  };

  return { database: { db } as never, conditions, limits };
}

/** Replays the given model replies, one per `complete()` call. */
function streamStub(...replies: readonly string[]) {
  const complete = vi.fn();
  for (const reply of replies) {
    complete.mockResolvedValueOnce({ text: reply, promptTokens: 10, completionTokens: 5 });
  }
  return { stream: { complete } as never, complete };
}

function scope() {
  return { principal, workspaceId: WORKSPACE_ID, requestId: null };
}

const FULL_EXTRACTION = JSON.stringify({
  attendees: ["Ana", "Ben"],
  agenda: ["Ship date"],
  discussionPoints: ["The migration is the long pole."],
  decisions: ["Ship on Friday."],
  actionItems: [{ text: "Write the migration", assignee: "Ben", dueDate: "2026-09-04" }],
});

describe("MeetingExtractionService.extract", () => {
  it("parses a clean reply in one provider call", async () => {
    const { stream, complete } = streamStub(FULL_EXTRACTION);
    const service = new MeetingExtractionService(stream, databaseStub({}).database);

    const result = await service.extract({ ...scope(), transcript: "Ana: we ship Friday." });

    expect(result).toEqual({
      extraction: {
        attendees: ["Ana", "Ben"],
        agenda: ["Ship date"],
        discussionPoints: ["The migration is the long pole."],
        decisions: ["Ship on Friday."],
        actionItems: [{ text: "Write the migration", assignee: "Ben", dueDate: "2026-09-04" }],
      },
    });
    expect(complete).toHaveBeenCalledTimes(1);
    // A pasted transcript names no note, so nothing note-scoped is authorized.
    expect(complete.mock.calls[0]?.[0]).toMatchObject({
      workspaceId: WORKSPACE_ID,
      prompt: expect.objectContaining({ feature: "meeting_extraction.v1" }),
    });
    expect(complete.mock.calls[0]?.[0]?.noteId).toBeUndefined();
  });

  it("parses a fenced reply without spending a repair", async () => {
    const { stream, complete } = streamStub(`\`\`\`json\n${FULL_EXTRACTION}\n\`\`\``);
    const service = new MeetingExtractionService(stream, databaseStub({}).database);

    const result = await service.extract({ ...scope(), transcript: "Ana: hi." });

    expect(result.extraction.attendees).toEqual(["Ana", "Ben"]);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("repairs once, under the same feature id, and stops there", async () => {
    const { stream, complete } = streamStub("Sure! Here are the notes.", FULL_EXTRACTION);
    const service = new MeetingExtractionService(stream, databaseStub({}).database);

    const result = await service.extract({ ...scope(), transcript: "Ana: hi." });

    expect(result.extraction.decisions).toEqual(["Ship on Friday."]);
    // Two calls, and each one is a full `complete()` — so each one is authorized,
    // gated and metered. Two `ai_usage` rows for one request, correctly labelled.
    expect(complete).toHaveBeenCalledTimes(2);
    const repairPrompt = complete.mock.calls[1]?.[0]?.prompt;
    expect(repairPrompt.feature).toBe("meeting_extraction.v1");
    expect(repairPrompt.promptVersion).toBe("meeting_extraction.v1");
    expect(repairPrompt.messages).toHaveLength(2);
  });

  it("gives up with a 422 after a second unusable reply, never a third call", async () => {
    const { stream, complete } = streamStub("nope", '{"attendees": 12}');
    const service = new MeetingExtractionService(stream, databaseStub({}).database);

    await expect(service.extract({ ...scope(), transcript: "Ana: hi." })).rejects.toMatchObject({
      status: HttpStatus.UNPROCESSABLE_ENTITY,
      safeResponse: { code: "AI_OUTPUT_INVALID" },
    });

    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("applies the list caps and the per-item bound the reviewer depends on", async () => {
    const { stream } = streamStub(
      JSON.stringify({
        attendees: Array.from({ length: 400 }, (_, index) => `Person ${index}`),
        agenda: Array.from({ length: 400 }, (_, index) => `Item ${index}`),
        discussionPoints: [],
        decisions: null,
        actionItems: Array.from({ length: 400 }, (_, index) => ({ text: `Do ${index}` })),
      }),
    );
    const service = new MeetingExtractionService(stream, databaseStub({}).database);

    const { extraction } = await service.extract({ ...scope(), transcript: "Ana: hi." });

    expect(extraction.attendees).toHaveLength(100);
    expect(extraction.agenda).toHaveLength(50);
    expect(extraction.actionItems).toHaveLength(100);
    // A missing or null list is an empty section, not a failure.
    expect(extraction.decisions).toEqual([]);
    expect(extraction.discussionPoints).toEqual([]);
  });

  it("refuses an item longer than the per-item ceiling rather than truncating it", async () => {
    // Both attempts oversized: an over-long "attendee" is not a name, and
    // silently clipping one would put invented text in front of a reviewer.
    const oversized = JSON.stringify({ attendees: ["x".repeat(501)] });
    const { stream, complete } = streamStub(oversized, oversized);
    const service = new MeetingExtractionService(stream, databaseStub({}).database);

    await expect(service.extract({ ...scope(), transcript: "Ana: hi." })).rejects.toMatchObject({
      safeResponse: { code: "AI_OUTPUT_INVALID" },
    });
    expect(complete).toHaveBeenCalledTimes(2);
  });
});

describe("MeetingExtractionService.suggestTags", () => {
  const pool: readonly PoolRow[] = [
    { id: TAG_ROADMAP, name: "Roadmap" },
    { id: TAG_INFRA, name: "infra" },
  ];

  function suggest(reply: string, rows: readonly PoolRow[] = pool) {
    const { stream, complete } = streamStub(reply);
    const { database, conditions, limits } = databaseStub({
      [WORKSPACE_ID]: rows,
      [OTHER_WORKSPACE_ID]: [{ id: FOREIGN_TAG, name: "secret-project" }],
    });
    const service = new MeetingExtractionService(stream, database);
    return { service, complete, conditions, limits };
  }

  it("matches the pool case-insensitively and returns the workspace's own id and spelling", async () => {
    const { service, complete } = suggest('{"tags":["roadmap","  INFRA  ","launch plan"]}');

    const result = await service.suggestTags({
      ...scope(),
      noteId: NOTE_ID,
      content: "a note about the roadmap",
    });

    expect(result.existing).toEqual([
      { tagId: TAG_ROADMAP, name: "Roadmap" },
      { tagId: TAG_INFRA, name: "infra" },
    ]);
    expect(result.proposed).toEqual([{ name: "launch plan" }]);
    // `note.read` is the tenancy proof for this route; the service proves it by
    // handing the note id to `complete()`, which authorizes it.
    expect(complete.mock.calls[0]?.[0]).toMatchObject({ noteId: NOTE_ID });
  });

  it("dedupes on both sides and never proposes a name the workspace already has", async () => {
    const { service } = suggest('{"tags":["Roadmap","roadmap","launch","LAUNCH","launch  "]}');

    const result = await service.suggestTags({ ...scope(), noteId: NOTE_ID, content: "note" });

    expect(result.existing).toEqual([{ tagId: TAG_ROADMAP, name: "Roadmap" }]);
    expect(result.proposed).toEqual([{ name: "launch" }]);
  });

  it("caps existing at ten and proposed at five", async () => {
    const big = Array.from({ length: 30 }, (_, index) => ({
      id: `a0000000-0000-4000-8300-${String(index).padStart(12, "0")}`,
      name: `tag-${index}`,
    }));
    const { service } = suggest(
      JSON.stringify({
        tags: [
          ...big.map((tag) => tag.name),
          ...Array.from({ length: 20 }, (_, index) => `brand-new-${index}`),
        ],
      }),
      big,
    );

    const result = await service.suggestTags({ ...scope(), noteId: NOTE_ID, content: "note" });

    expect(result.existing).toHaveLength(10);
    expect(result.proposed).toHaveLength(5);
    expect(result.existing.map((tag) => tag.tagId)).toEqual(big.slice(0, 10).map((tag) => tag.id));
  });

  it("drops a proposed name the tag column could not hold", async () => {
    const { service } = suggest(JSON.stringify({ tags: ["x".repeat(51), "fine", "y".repeat(50)] }));

    const result = await service.suggestTags({ ...scope(), noteId: NOTE_ID, content: "note" });

    expect(result.proposed).toEqual([{ name: "fine" }, { name: "y".repeat(50) }]);
  });

  it("scopes the pool query to the request's workspace, and to nothing else", async () => {
    const { service, conditions, limits } = suggest('{"tags":["secret-project"]}');

    const result = await service.suggestTags({ ...scope(), noteId: NOTE_ID, content: "note" });

    // One query, pinned to this workspace by an explicit `eq(tags.workspaceId, …)`.
    expect(conditions).toHaveLength(1);
    expect(boundWorkspaceId(conditions[0])).toBe(WORKSPACE_ID);
    // TAG_MAX_PER_WORKSPACE: the pool cannot legitimately be larger.
    expect(limits).toEqual([200]);

    // The other workspace HAS a tag by that exact name. It must not be reachable:
    // the suggestion comes back as something the user would have to create here.
    expect(result.existing).toEqual([]);
    expect(result.proposed).toEqual([{ name: "secret-project" }]);
    expect(JSON.stringify(result)).not.toContain(FOREIGN_TAG);
  });

  it("repairs a malformed reply once and still partitions server-side", async () => {
    const { stream, complete } = streamStub("here are some tags", '{"tags":["Roadmap"]}');
    const { database } = databaseStub({ [WORKSPACE_ID]: pool });
    const service = new MeetingExtractionService(stream, database);

    const result = await service.suggestTags({ ...scope(), noteId: NOTE_ID, content: "note" });

    expect(complete).toHaveBeenCalledTimes(2);
    // The repair pass carries the note id too, so it is authorized identically.
    expect(complete.mock.calls[1]?.[0]).toMatchObject({
      noteId: NOTE_ID,
      prompt: expect.objectContaining({ feature: "auto_tag.v1" }),
    });
    expect(result.existing).toEqual([{ tagId: TAG_ROADMAP, name: "Roadmap" }]);
  });
});
