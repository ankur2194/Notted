import { describe, expect, it } from "vitest";

import { ATTACHMENT_API_PATHS } from "./attachment";
import { SEARCH_API_PATHS } from "./search";
import { TAG_API_PATHS } from "./tag";
import { TASK_API_PATHS, TASK_STATUS_API_PATHS } from "./task";

const workspaceId = "30000000-0000-4000-8000-000000000001";
const resourceId = "30000000-0000-4000-8000-000000000002";

describe("shared API path builders", () => {
  it("builds attachment paths with and without an authorized variant", () => {
    expect(ATTACHMENT_API_PATHS.noteCollection(workspaceId, resourceId)).toContain(workspaceId);
    expect(ATTACHMENT_API_PATHS.detail(workspaceId, resourceId)).toContain(resourceId);
    expect(ATTACHMENT_API_PATHS.content(workspaceId, resourceId).endsWith("/content")).toBe(true);
    expect(
      ATTACHMENT_API_PATHS.content(workspaceId, resourceId, "thumbnail").endsWith(
        "/content?variant=thumbnail",
      ),
    ).toBe(true);
  });

  it("builds search and tag paths", () => {
    expect(SEARCH_API_PATHS.collection(workspaceId).endsWith("/search")).toBe(true);
    expect(SEARCH_API_PATHS.suggestions(workspaceId).endsWith("/search/suggestions")).toBe(true);
    expect(TAG_API_PATHS.collection(workspaceId).endsWith("/tags")).toBe(true);
    expect(TAG_API_PATHS.detail(workspaceId, resourceId).endsWith(`/tags/${resourceId}`)).toBe(
      true,
    );
  });

  it("builds task and custom-status paths", () => {
    expect(TASK_API_PATHS.collection(workspaceId).endsWith("/tasks")).toBe(true);
    expect(TASK_API_PATHS.bulk(workspaceId).endsWith("/tasks/bulk")).toBe(true);
    expect(TASK_API_PATHS.detail(workspaceId, resourceId).endsWith(`/tasks/${resourceId}`)).toBe(
      true,
    );
    expect(
      TASK_API_PATHS.reorder(workspaceId, resourceId).endsWith(`/tasks/${resourceId}/reorder`),
    ).toBe(true);
    expect(TASK_STATUS_API_PATHS.collection(workspaceId).endsWith("/task-statuses")).toBe(true);
    expect(
      TASK_STATUS_API_PATHS.detail(workspaceId, resourceId).endsWith(
        `/task-statuses/${resourceId}`,
      ),
    ).toBe(true);
  });
});
