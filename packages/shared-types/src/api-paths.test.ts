import { describe, expect, it } from "vitest";

import { API_KEY_API_PATHS } from "./api-key";
import { ATTACHMENT_API_PATHS } from "./attachment";
import { SEARCH_API_PATHS } from "./search";
import { TAG_API_PATHS } from "./tag";
import { TASK_API_PATHS, TASK_STATUS_API_PATHS } from "./task";
import { WEBHOOK_API_PATHS } from "./webhook";

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

  it("builds API key management paths", () => {
    expect(API_KEY_API_PATHS.collection(workspaceId).endsWith("/api-keys")).toBe(true);
    expect(
      API_KEY_API_PATHS.detail(workspaceId, resourceId).endsWith(`/api-keys/${resourceId}`),
    ).toBe(true);
    expect(API_KEY_API_PATHS.collection(workspaceId).startsWith("/api/v1/workspaces/")).toBe(true);
  });

  it("builds webhook management and delivery-log paths", () => {
    const deliveryId = "30000000-0000-4000-8000-000000000003";
    expect(WEBHOOK_API_PATHS.collection(workspaceId).endsWith("/webhooks")).toBe(true);
    expect(WEBHOOK_API_PATHS.collection(workspaceId).startsWith("/api/v1/workspaces/")).toBe(true);
    expect(
      WEBHOOK_API_PATHS.detail(workspaceId, resourceId).endsWith(`/webhooks/${resourceId}`),
    ).toBe(true);
    expect(WEBHOOK_API_PATHS.rotateSecret(workspaceId, resourceId).endsWith("/rotate-secret")).toBe(
      true,
    );
    expect(WEBHOOK_API_PATHS.verify(workspaceId, resourceId).endsWith("/verify")).toBe(true);
    expect(WEBHOOK_API_PATHS.deliveries(workspaceId, resourceId).endsWith("/deliveries")).toBe(
      true,
    );
    expect(
      WEBHOOK_API_PATHS.retryDelivery(workspaceId, resourceId, deliveryId).endsWith(
        `/deliveries/${deliveryId}/retry`,
      ),
    ).toBe(true);
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
