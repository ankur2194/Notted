import { describe, expect, it } from "vitest";

import {
  COMMENT_ANCHOR_QUOTE_MAX_LENGTH,
  COMMENT_ANCHOR_SCHEME_ABSOLUTE,
  COMMENT_ANCHOR_SCHEME_YJS,
  COMMENT_CONTENT_MAX_LENGTH,
  commentAnchorSchema,
  commentListQuerySchema,
  createCommentSchema,
} from "./comment.schema";
import { collectNoteDocumentMentionIds } from "./document.schema";

const ada = "30000000-0000-4000-8000-000000000001";
const grace = "30000000-0000-4000-8000-000000000002";

const yjsAnchor = {
  scheme: COMMENT_ANCHOR_SCHEME_YJS,
  from: 4,
  to: 12,
  quote: "anchored words",
  relFrom: "AQIDBA",
  relTo: "BQYHCA",
  schemaVersion: 1,
};

describe("commentAnchorSchema", () => {
  it("accepts a collaborative anchor carrying both relative positions", () => {
    expect(commentAnchorSchema.safeParse(yjsAnchor).success).toBe(true);
  });

  it("accepts a solo anchor with absolute positions only", () => {
    const parsed = commentAnchorSchema.safeParse({
      scheme: COMMENT_ANCHOR_SCHEME_ABSOLUTE,
      from: 0,
      to: 0,
      quote: "",
      schemaVersion: 1,
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a collaborative anchor missing a relative position", () => {
    const { relTo, ...withoutRelTo } = yjsAnchor;
    // Asserted rather than discarded: a fixture that stopped carrying `relTo`
    // would make the rejection below pass for the wrong reason.
    expect(relTo).toBeDefined();
    expect(commentAnchorSchema.safeParse(withoutRelTo).success).toBe(false);
  });

  it("rejects an absolute anchor that smuggles relative positions", () => {
    expect(
      commentAnchorSchema.safeParse({ ...yjsAnchor, scheme: COMMENT_ANCHOR_SCHEME_ABSOLUTE })
        .success,
    ).toBe(false);
  });

  it("rejects an inverted range and an over-long quote", () => {
    expect(commentAnchorSchema.safeParse({ ...yjsAnchor, from: 12, to: 4 }).success).toBe(false);
    expect(
      commentAnchorSchema.safeParse({
        ...yjsAnchor,
        quote: "x".repeat(COMMENT_ANCHOR_QUOTE_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
  });

  it("rejects a relative position that is not base64url", () => {
    expect(commentAnchorSchema.safeParse({ ...yjsAnchor, relFrom: "not base64!" }).success).toBe(
      false,
    );
  });
});

describe("createCommentSchema", () => {
  it("treats an absent parent and anchor as a whole-note thread", () => {
    const parsed = createCommentSchema.safeParse({ content: "  Looks good  " });
    expect(parsed.success && parsed.data.content).toBe("Looks good");
  });

  it("rejects empty and over-long bodies, and unknown keys", () => {
    expect(createCommentSchema.safeParse({ content: "   " }).success).toBe(false);
    expect(
      createCommentSchema.safeParse({ content: "x".repeat(COMMENT_CONTENT_MAX_LENGTH + 1) })
        .success,
    ).toBe(false);
    expect(createCommentSchema.safeParse({ content: "hi", mentionUserIds: [ada] }).success).toBe(
      false,
    );
  });
});

describe("commentListQuerySchema", () => {
  it("defaults and bounds the page window", () => {
    const parsed = commentListQuerySchema.safeParse({});
    expect(parsed.success && parsed.data).toEqual({ page: 1, limit: 50, status: "all" });
    expect(commentListQuerySchema.safeParse({ limit: "101" }).success).toBe(false);
    expect(commentListQuerySchema.safeParse({ page: "3", status: "open" }).success).toBe(true);
  });
});

describe("collectNoteDocumentMentionIds", () => {
  const mention = (id: string, label: string) => ({ type: "mention", attrs: { id, label } });

  it("collects distinct well-formed mention ids in first-seen order", () => {
    const document = {
      type: "doc",
      content: [
        { type: "paragraph", content: [mention(grace, "Grace"), { type: "text", text: " hi" }] },
        { type: "paragraph", content: [mention(ada, "Ada"), mention(grace, "Grace")] },
      ],
    };
    expect(collectNoteDocumentMentionIds(document)).toEqual([grace, ada]);
  });

  it("skips mentions that cannot address a user", () => {
    const document = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [mention("not-a-uuid", "Ghost"), mention(ada, ""), mention(ada, "Ada")],
        },
      ],
    };
    expect(collectNoteDocumentMentionIds(document)).toEqual([ada]);
  });

  it("returns an empty list for a document with no mentions and for junk input", () => {
    expect(collectNoteDocumentMentionIds({ type: "doc", content: [] })).toEqual([]);
    expect(collectNoteDocumentMentionIds(null)).toEqual([]);
    expect(collectNoteDocumentMentionIds("nonsense")).toEqual([]);
  });
});
