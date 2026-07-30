import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
  notificationKindEnum,
  notifications,
  notificationTargetTypeEnum,
} from "../src/database/schema";

describe("notification storage contract", () => {
  it("contains only scoped safe metadata and persistent read state", () => {
    const config = getTableConfig(notifications);
    const names = new Set(config.columns.map((column) => column.name));
    for (const expected of [
      "workspace_id",
      "recipient_user_id",
      "actor_user_id",
      "kind",
      "target_type",
      "target_id",
      "summary",
      "target_label",
      "created_at",
      "read_at",
    ])
      expect(names.has(expected)).toBe(true);
    expect(
      [...names].some((name) => /body|content|token|secret|signed|url|html|document/iu.test(name)),
    ).toBe(false);
    expect(config.indexes.map((index) => index.config.name)).toEqual(
      expect.arrayContaining([
        "notifications_recipient_recent_idx",
        "notifications_recipient_workspace_recent_idx",
        "notifications_workspace_recent_idx",
        "notifications_recipient_workspace_unread_idx",
      ]),
    );
  });

  it("uses closed, future-extensible kinds and safe target types", () => {
    expect(notificationKindEnum.enumValues).toEqual([
      "system",
      "workspace",
      "mention",
      "comment",
      "export",
    ]);
    expect(notificationTargetTypeEnum.enumValues).toEqual([
      "workspace",
      "note",
      "comment",
      "export",
      "settings",
    ]);
  });
});
