import { describe, expect, it } from "vitest";

import { NOTE_DOCUMENT_LIMITS } from "./document.schema";
import {
  createFolderSchema,
  createNoteSchema,
  deleteFolderSchema,
  extractNoteContentPlain,
  folderDeleteResultSchema,
  moveNoteSchema,
  noteDetailSchema,
  noteDocumentSchema,
  noteListQuerySchema,
  noteNavigationSchema,
  noteShareListSchema,
  permanentDeleteNoteSchema,
  updateFolderSchema,
  updateNoteSchema,
  upsertNoteShareSchema,
} from "./note.schema";

const id = (suffix: string) => `10000000-0000-4000-8000-${suffix.padStart(12, "0")}`;
const document = noteDocumentSchema.parse({
  type: "doc",
  content: [
    { type: "paragraph", content: [{ type: "text", text: "Alpha" }] },
    { type: "paragraph", content: [{ type: "text", text: "beta" }] },
  ],
});

describe("Part 31 note validators with the Part 33 document contract", () => {
  it("accepts a bounded document and joins leaf block text with newlines", () => {
    expect(noteDocumentSchema.parse(document)).toEqual(document);
    expect(extractNoteContentPlain(document)).toBe("Alpha\nbeta");
  });

  it.each([
    { type: "paragraph" },
    { type: "doc", content: [{ type: "text", text: 3 }] },
    { type: "doc", content: [{ type: "text", text: "ok", html: "<script>" }] },
    // The ROOT child bound, not the per-node `maxChildren: 200` this used to
    // pin: `maxRootChildren` was raised to 2 000 so a real long note opens,
    // and `maxNodes` is the same 2 000, so one over the root bound is also
    // one over the node budget. Read the constant rather than restating it.
    {
      type: "doc",
      content: new Array(NOTE_DOCUMENT_LIMITS.maxRootChildren + 1).fill({ type: "paragraph" }),
    },
    { type: "doc", content: [{ type: "text", text: "x".repeat(20_001) }] },
    { type: "doc", attrs: { value: Number.NaN } },
  ])("rejects malformed or over-limit document %#", (value) => {
    expect(noteDocumentSchema.safeParse(value).success).toBe(false);
  });

  it("rejects forged plain text and unknown location fields on create/update", () => {
    expect(
      createNoteSchema.safeParse({ title: "A", content: document, contentPlain: "forged" }).success,
    ).toBe(false);
    expect(updateNoteSchema.safeParse({ expectedVersion: 1, projectId: id("1") }).success).toBe(
      false,
    );
    expect(updateNoteSchema.safeParse({ expectedVersion: 1, parentId: null }).success).toBe(false);
  });

  it("requires expectedVersion and at least one mutable update", () => {
    expect(updateNoteSchema.safeParse({ title: "A" }).success).toBe(false);
    expect(updateNoteSchema.safeParse({ expectedVersion: 1 }).success).toBe(false);
    expect(
      updateNoteSchema.safeParse({ expectedVersion: 2, title: "A", content: document }).success,
    ).toBe(true);
  });

  it("enforces project/root list combinations, explicit booleans, bounds, and stable sorts", () => {
    expect(noteListQuerySchema.safeParse({ scope: "project" }).success).toBe(false);
    expect(
      noteListQuerySchema.safeParse({ scope: "workspace-root", projectId: id("1") }).success,
    ).toBe(false);
    expect(noteListQuerySchema.safeParse({ limit: "101" }).success).toBe(false);
    expect(noteListQuerySchema.safeParse({ isPinned: "yes" }).success).toBe(false);
    expect(
      noteListQuerySchema.parse({ scope: "project", projectId: id("1"), sortBy: "sortOrder" }),
    ).toMatchObject({
      page: 1,
      limit: 25,
      view: "normal",
      sortDirection: "desc",
    });
  });

  it("requires complete move destinations and rejects client sibling arrays", () => {
    expect(
      moveNoteSchema.safeParse({ expectedVersion: 1, projectId: null, folderId: null }).success,
    ).toBe(false);
    expect(
      moveNoteSchema.safeParse({
        expectedVersion: 1,
        projectId: null,
        folderId: null,
        parentId: null,
        siblingIds: [id("1")],
      }).success,
    ).toBe(false);
    expect(
      moveNoteSchema.safeParse({
        expectedVersion: 1,
        projectId: id("1"),
        folderId: null,
        parentId: null,
        beforeNoteId: id("2"),
      }).success,
    ).toBe(true);
  });

  /**
   * The asymmetry is deliberate: the three container fields are one coupled
   * decision and stay required, while `boardColumnId` is an orthogonal axis
   * where "omitted" must mean "keep" — a required echo of a value the caller
   * never read would be a lost-update hazard.
   */
  it("treats the board column as optional-means-keep while containers stay required", () => {
    const destination = {
      expectedVersion: 1,
      projectId: null,
      folderId: null,
      parentId: null,
    } as const;
    expect(moveNoteSchema.safeParse(destination).success).toBe(true);
    expect(moveNoteSchema.safeParse({ ...destination, boardColumnId: null }).success).toBe(true);
    expect(moveNoteSchema.safeParse({ ...destination, boardColumnId: id("3") }).success).toBe(true);
    expect(moveNoteSchema.safeParse({ ...destination, boardColumnId: "not-a-uuid" }).success).toBe(
      false,
    );
  });

  it("requires explicit confirmation for destructive folder and permanent note deletion", () => {
    expect(
      permanentDeleteNoteSchema.safeParse({
        expectedVersion: 1,
        confirm: false,
        expectedTitle: "A",
      }).success,
    ).toBe(false);
    expect(
      permanentDeleteNoteSchema.safeParse({ expectedVersion: 1, confirm: true, expectedTitle: "A" })
        .success,
    ).toBe(true);
    expect(deleteFolderSchema.safeParse({ confirm: true }).success).toBe(true);
    expect(deleteFolderSchema.safeParse({}).success).toBe(false);
  });

  it("keeps folder contracts strict", () => {
    expect(createFolderSchema.safeParse({ name: "Roadmap", depth: 2 }).success).toBe(false);
    expect(updateFolderSchema.safeParse({}).success).toBe(false);
    expect(updateFolderSchema.safeParse({ parentId: null }).success).toBe(true);
  });

  it("accepts existing comment grants but limits new share mutations to view or edit", () => {
    expect(upsertNoteShareSchema.safeParse({ permission: "view" }).success).toBe(true);
    expect(upsertNoteShareSchema.safeParse({ permission: "edit" }).success).toBe(true);
    expect(upsertNoteShareSchema.safeParse({ permission: "comment" }).success).toBe(false);
    expect(
      noteShareListSchema.safeParse({
        items: [
          {
            id: id("7"),
            noteId: id("1"),
            userId: id("8"),
            permission: "comment",
            createdAt: "2026-08-01T00:00:00.000Z",
          },
        ],
        limit: 1_000,
        returned: 1,
        truncated: false,
      }).success,
    ).toBe(true);
  });

  it("validates content-bearing detail and content-free bounded navigation outputs", () => {
    const summary = {
      id: id("1"),
      workspaceId: id("2"),
      location: "workspace-root",
      projectId: null,
      folderId: null,
      parentId: null,
      boardColumnId: null,
      title: "A",
      type: "task-list",
      pageSize: "a4",
      sortOrder: 1,
      isTemplate: false,
      isPinned: true,
      isArchived: false,
      isDeleted: false,
      tagIds: [id("3")],
      progress: { checklist: { done: 1, total: 2 }, tasks: { done: 0, total: 0 } },
      version: 2,
      deletedAt: null,
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    } as const;
    expect(
      noteDetailSchema.safeParse({
        ...summary,
        content: document,
        contentPlain: "Alpha\nbeta",
        createdById: id("4"),
        updatedById: null,
        currentActorId: id("4"),
        capabilities: { canUpdate: true, canDelete: true, canShare: true, canExport: true },
      }).success,
    ).toBe(true);
    expect(
      noteNavigationSchema.safeParse({
        items: [
          {
            id: summary.id,
            projectId: null,
            folderId: null,
            parentId: null,
            title: "A",
            type: "task-list",
            sortOrder: 1,
            isTemplate: false,
            isPinned: true,
            isArchived: false,
            version: 2,
            updatedAt: summary.updatedAt,
          },
        ],
        limit: 500,
        returned: 1,
        truncated: false,
      }).success,
    ).toBe(true);
    expect(
      folderDeleteResultSchema.safeParse({
        id: id("1"),
        deleted: true,
        removedFolders: 2,
        unfiledNotes: 3,
      }).success,
    ).toBe(true);
  });
});

describe("title and folder-name character safety", () => {
  const RLO = "\u202E";
  const ZWSP = "\u200B";

  /*
   * A title STRIPS rather than rejects. `photo<RLO>gnp.exe` reads to a human as
   * `photoexe.png`, and the author cannot see the character that would be
   * blocking their save — so refusing here is a support ticket with no
   * diagnosis, and unlike a document node a stored title has no migration path
   * to salvage it later.
   */
  it("strips bidirectional overrides and zero-width characters from a title", () => {
    const parsed = createNoteSchema.parse({ title: `Report${RLO}fdp.exe` });
    expect(parsed.title).toBe("Reportfdp.exe");
    expect(parsed.title).not.toContain(RLO);

    expect(createNoteSchema.parse({ title: `Plan${ZWSP}ning` }).title).toBe("Planning");
    // Ordinary text is untouched.
    expect(createNoteSchema.parse({ title: "Café résumé 🎉" }).title).toBe("Café résumé 🎉");
  });

  /*
   * The strip runs BEFORE the length check, so a title made only of invisible
   * characters fails rather than passing on the strength of characters that
   * were about to be removed.
   */
  it("refuses a title that is nothing but invisible characters", () => {
    expect(() => createNoteSchema.parse({ title: `${ZWSP}${RLO}${ZWSP}` })).toThrow();
  });
});
