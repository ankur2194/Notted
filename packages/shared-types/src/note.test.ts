import { describe, expect, it } from "vitest";

import { NOTE_API_PATHS } from "./note";

const workspaceId = "30000000-0000-4000-8000-000000000001";
const noteId = "30000000-0000-4000-8000-000000000002";
const folderId = "30000000-0000-4000-8000-000000000003";
const userId = "30000000-0000-4000-8000-000000000004";

describe("NOTE_API_PATHS", () => {
  it("builds every documented note and folder route", () => {
    const base = `/api/v1/workspaces/${workspaceId}`;

    expect(NOTE_API_PATHS.collection(workspaceId)).toBe(`${base}/notes`);
    expect(NOTE_API_PATHS.detail(workspaceId, noteId)).toBe(`${base}/notes/${noteId}`);
    expect(NOTE_API_PATHS.move(workspaceId, noteId)).toBe(`${base}/notes/${noteId}/move`);
    expect(NOTE_API_PATHS.restore(workspaceId, noteId)).toBe(`${base}/notes/${noteId}/restore`);
    expect(NOTE_API_PATHS.permanentDelete(workspaceId, noteId)).toBe(
      `${base}/notes/${noteId}/permanent-delete`,
    );
    expect(NOTE_API_PATHS.navigation(workspaceId)).toBe(`${base}/notes/navigation`);
    expect(NOTE_API_PATHS.folders(workspaceId)).toBe(`${base}/folders`);
    expect(NOTE_API_PATHS.folder(workspaceId, folderId)).toBe(`${base}/folders/${folderId}`);
    expect(NOTE_API_PATHS.shares(workspaceId, noteId)).toBe(`${base}/notes/${noteId}/shares`);
    expect(NOTE_API_PATHS.share(workspaceId, noteId, userId)).toBe(
      `${base}/notes/${noteId}/shares/${userId}`,
    );
  });

  /**
   * Tenant scope is a property of the path itself: there is no note or folder
   * route that omits the workspace segment, so a caller cannot accidentally
   * address a note outside the workspace it is working in. Authorization is
   * still enforced server-side; this only keeps the client from constructing a
   * request the policy layer would have to reject.
   */
  it("keeps every route workspace-scoped", () => {
    const prefix = `/api/v1/workspaces/${workspaceId}/`;
    const built = [
      NOTE_API_PATHS.collection(workspaceId),
      NOTE_API_PATHS.detail(workspaceId, noteId),
      NOTE_API_PATHS.move(workspaceId, noteId),
      NOTE_API_PATHS.restore(workspaceId, noteId),
      NOTE_API_PATHS.permanentDelete(workspaceId, noteId),
      NOTE_API_PATHS.navigation(workspaceId),
      NOTE_API_PATHS.folders(workspaceId),
      NOTE_API_PATHS.folder(workspaceId, folderId),
      NOTE_API_PATHS.shares(workspaceId, noteId),
      NOTE_API_PATHS.share(workspaceId, noteId, userId),
      NOTE_API_PATHS.copy(workspaceId, noteId),
    ];

    expect(built).toHaveLength(Object.keys(NOTE_API_PATHS).length);
    for (const path of built) expect(path.startsWith(prefix)).toBe(true);
  });

  /**
   * The builders interpolate their arguments verbatim — they do not encode.
   * That is deliberate and callers depend on it, but it means every caller owns
   * validation: `apps/web/src/lib/notes/requests.ts` checks each id against
   * `uuidSchema` before building a path. If this behaviour ever changes, the
   * change must be deliberate rather than incidental.
   */
  it("interpolates identifiers verbatim so callers must validate them", () => {
    expect(NOTE_API_PATHS.detail(workspaceId, "../folders")).toBe(
      `/api/v1/workspaces/${workspaceId}/notes/../folders`,
    );
  });

  it("is frozen against mutation", () => {
    expect(Object.isFrozen(NOTE_API_PATHS)).toBe(true);
    expect(() => {
      (NOTE_API_PATHS as unknown as Record<string, unknown>).collection = () => "/elsewhere";
    }).toThrow(TypeError);
  });
});
