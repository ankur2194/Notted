import { describe, expect, it } from "vitest";

import { parseRetentionConfig } from "./retention.config";

describe("parseRetentionConfig", () => {
  it("provides the documented development defaults", () => {
    const config = parseRetentionConfig({});

    expect(config.deletedNoteRetentionDaysFree).toBe(30);
    expect(config.deletedNoteRetentionDaysPro).toBeNull();
    expect(config.deletedNoteRetentionDaysEnterprise).toBeNull();
    expect(config.noteVersionRetentionDaysFree).toBe(30);
    expect(config.noteVersionRetentionDaysPro).toBeNull();
    expect(config.noteVersionRetentionDaysEnterprise).toBeNull();
    expect(config.auditLogRetentionDays).toBe(365);
    expect(config.exportObjectRetentionDays).toBe(7);
    expect(config.sessionShortLivedHours).toBe(24);
    expect(config.sessionRememberMeDays).toBe(30);
    expect(config.orphanedObjectCleanupDays).toBe(7);
  });

  it("parses every overridable integer window", () => {
    const config = parseRetentionConfig({
      RETENTION_DELETED_NOTE_DAYS_FREE: "14",
      RETENTION_DELETED_NOTE_DAYS_PRO: "730",
      RETENTION_DELETED_NOTE_DAYS_ENTERPRISE: "1095",
      RETENTION_NOTE_VERSION_DAYS_FREE: "60",
      RETENTION_NOTE_VERSION_DAYS_PRO: "365",
      RETENTION_NOTE_VERSION_DAYS_ENTERPRISE: "730",
      RETENTION_AUDIT_LOG_DAYS: "90",
      RETENTION_EXPORT_OBJECT_DAYS: "3",
      SESSION_SHORT_LIVED_HOURS: "24",
      SESSION_REMEMBER_ME_DAYS: "14",
      RETENTION_ORPHANED_OBJECT_DAYS: "5",
    });

    expect(config.deletedNoteRetentionDaysFree).toBe(14);
    expect(config.deletedNoteRetentionDaysPro).toBe(730);
    expect(config.deletedNoteRetentionDaysEnterprise).toBe(1095);
    expect(config.noteVersionRetentionDaysFree).toBe(60);
    expect(config.noteVersionRetentionDaysPro).toBe(365);
    expect(config.noteVersionRetentionDaysEnterprise).toBe(730);
    expect(config.auditLogRetentionDays).toBe(90);
    expect(config.exportObjectRetentionDays).toBe(3);
    expect(config.sessionShortLivedHours).toBe(24);
    expect(config.sessionRememberMeDays).toBe(14);
    expect(config.orphanedObjectCleanupDays).toBe(5);
  });

  it('treats "unlimited" as null for every paid-tier note and version window', () => {
    const config = parseRetentionConfig({
      RETENTION_DELETED_NOTE_DAYS_PRO: "unlimited",
      RETENTION_DELETED_NOTE_DAYS_ENTERPRISE: "unlimited",
      RETENTION_NOTE_VERSION_DAYS_PRO: "unlimited",
      RETENTION_NOTE_VERSION_DAYS_ENTERPRISE: "unlimited",
    });

    expect(config.deletedNoteRetentionDaysPro).toBeNull();
    expect(config.deletedNoteRetentionDaysEnterprise).toBeNull();
    expect(config.noteVersionRetentionDaysPro).toBeNull();
    expect(config.noteVersionRetentionDaysEnterprise).toBeNull();
  });

  it('treats "UNLIMITED" case-insensitively', () => {
    const config = parseRetentionConfig({
      RETENTION_NOTE_VERSION_DAYS_PRO: "  Unlimited  ",
    });

    expect(config.noteVersionRetentionDaysPro).toBeNull();
  });

  it.each([
    [{ RETENTION_DELETED_NOTE_DAYS_FREE: "0" }, "must be an integer between 1 and"],
    [{ RETENTION_DELETED_NOTE_DAYS_FREE: "abc" }, "must be an integer between 1 and"],
    [{ RETENTION_AUDIT_LOG_DAYS: "-1" }, "must be an integer between 1 and"],
    [{ SESSION_SHORT_LIVED_HOURS: "12" }, "must be an integer between 24 and 24"],
    [{ SESSION_REMEMBER_ME_DAYS: "0" }, "must be an integer between 1 and"],
    [{ RETENTION_EXPORT_OBJECT_DAYS: "0" }, "must be an integer between 1 and"],
    [{ RETENTION_DELETED_NOTE_DAYS_PRO: "0" }, "must be an integer between 1 and"],
    [{ RETENTION_NOTE_VERSION_DAYS_ENTERPRISE: "36501" }, "must be an integer between 1 and"],
    [{ RETENTION_AUDIT_LOG_DAYS: "unlimited" }, "must be an integer between 1 and"],
  ])("rejects out-of-range or non-integer values %#", (environment, expectedMessage) => {
    expect(() => parseRetentionConfig(environment)).toThrowError(expectedMessage);
  });

  it("returns a frozen object", () => {
    const config = parseRetentionConfig({});

    expect(Object.isFrozen(config)).toBe(true);
  });
});
