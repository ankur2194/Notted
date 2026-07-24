import { describe, expect, expectTypeOf, it } from "vitest";

import {
  APP_NAME,
  type ApiResponse,
  type AttachmentSummary,
  type NoteSummary,
  type Paginated,
  type ProjectSummary,
  type SearchResultSummary,
  type TaskSummary,
  type UserSummary,
  type WorkspaceSummary,
} from "./index";

describe("@notted/shared-types public barrel", () => {
  it("exposes the application name and discriminated API envelope", () => {
    const response: ApiResponse<{ value: number }> = {
      success: true,
      data: { value: 1 },
      requestId: "request-id",
    };

    expect(APP_NAME).toBe("Notted");
    expect(response.success).toBe(true);
  });

  it("keeps pagination item contracts strongly typed", () => {
    expectTypeOf<Paginated<UserSummary>["items"]>().toEqualTypeOf<UserSummary[]>();
  });

  it("exports the safe domain summaries from the root only", () => {
    expectTypeOf<UserSummary>().toHaveProperty("name");
    expectTypeOf<WorkspaceSummary>().toHaveProperty("currentUserRole");
    expectTypeOf<ProjectSummary>().toHaveProperty("status");
    expectTypeOf<NoteSummary>().toHaveProperty("pageSize");
    expectTypeOf<AttachmentSummary>().toHaveProperty("status");
    expectTypeOf<SearchResultSummary>().toHaveProperty("highlights");
    expectTypeOf<TaskSummary>().toHaveProperty("priority");
  });
});
