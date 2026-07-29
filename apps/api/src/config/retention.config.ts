// Part 19: retention policy configuration.
//
// ADR 0009 splits "what the retention windows ARE" (this config) from "what
// DELETES the data when those windows elapse" (Parts 45, 55, and 71).
// Part 19 ships the typed config + defaults + bounds validation; owning parts wire
// the scheduled jobs that scan and delete past-expiry rows using these
// windows. No purge logic runs in Part 19.
//
// Windows are environment-overridable, but each finite value has a hard minimum
// (>= 1) and maximum so a typo cannot configure a zero-day or absurd retention.
// Defaults match ADR 0007's safe defaults (export objects 7 days) and the
// Notted.md product brief (free-tier deleted-note/versions 30 days, audit
// retention 365 days, session defaults).
//
// Convention (mirrors `security.config.ts`):
// - `RetentionConfig` interface describes the typed shape.
// - `parseRetentionConfig(environment)` reads + validates env vars, returning a
//   frozen object.
// - `RetentionConfigProvider` is the `@Injectable()` that captures process.env
//   at construction.
// - `retentionConfigProvider` is the Provider that injects the parsed value
//   under the `RETENTION_CONFIG` symbol.

import { Injectable, type Provider } from "@nestjs/common";

import { type Environment, readInteger, wrapConfigError } from "./environment-readers";

export const RETENTION_CONFIG = Symbol("RETENTION_CONFIG");

/**
 * Retention windows for the entities Plan Part 19 names. All values are in
 * DAYS unless the field name says otherwise (`sessionShortLivedHours` is in
 * HOURS to match Better Auth's session-ttl semantics; `sessionRememberMeDays`
 * is in days).
 *
 * `null` means "no automated purge" (treated as unlimited). It is used for
 * Pro/Enterprise note and version retention.
 */
export interface RetentionConfig {
  /**
   * Free-tier: how long a soft-deleted note (notes.is_deleted = true) is
   * retained in the trash before the Part 45 purge hard-deletes it. Default
   * 30 days (Notted.md product brief). After this window, hard delete is final.
   */
  readonly deletedNoteRetentionDaysFree: number;
  /**
   * Pro-tier soft-deleted note retention. `null` means unlimited: Part 45 must
   * skip automated purge for the workspace.
   */
  readonly deletedNoteRetentionDaysPro: number | null;
  /** Enterprise-tier soft-deleted note retention; unlimited by default. */
  readonly deletedNoteRetentionDaysEnterprise: number | null;
  /**
   * Free-tier: how long `note_versions` snapshot rows are retained. Default 30
   * days (Notted.md: "Free tier: 30 days of version history"). Older rows are
   * purged by Part 55.
   */
  readonly noteVersionRetentionDaysFree: number;
  /**
   * Pro-tier: version retention. `null` means UNLIMITED — paid workspaces keep
   * version history forever and Part 55 skips the purge for Pro workspaces.
   * (ADR 0007 / Notted.md: "Pro tier: unlimited version history".)
   */
  readonly noteVersionRetentionDaysPro: number | null;
  /** Enterprise-tier version retention; unlimited by default. */
  readonly noteVersionRetentionDaysEnterprise: number | null;
  /**
   * Audit-log retention. Default 365 days; Part 71 deletes older rows.
   * Applies uniformly across plans (audit trails are compliance-relevant).
   */
  readonly auditLogRetentionDays: number;
  /**
   * Export object retention. Default 7 days (ADR 0007: "retain completed
   * export objects for seven days by default, then delete them
   * asynchronously"). Matches the `exports.object_expires_at` column the
   * export service (Part 62) sets on ready.
   */
  readonly exportObjectRetentionDays: number;
  /**
   * Short-lived (non-remember-me) session TTL in HOURS. Default 24h (ADR 0007:
   * "default to one day unless remember-me explicitly selects 30 days"). The
   * Part 21 auth wiring uses this for Better Auth session configuration.
   */
  readonly sessionShortLivedHours: number;
  /**
   * Remember-me session duration in DAYS. Default 30 days (ADR 0007).
   */
  readonly sessionRememberMeDays: number;
  /**
   * Orphaned-object cleanup window. Default 7 days. The Part 45 cleanup job
   * reaps MinIO objects whose DB record has been gone for longer than this
   * (ADR 0005 reconciliation: the DB is authoritative; an object without a DB
   * row after this grace period is orphaned and is deleted). Also bounds the
   * abandoned-upload cleanup for `attachments.processing_status = pending` and
   * `failed` rows whose object never reached `ready`.
   */
  readonly orphanedObjectCleanupDays: number;
}

const ONE_DAY_MIN = 1;
const ONE_DAY_MAX = 365 * 100; // ~100 years; readInteger caps at MAX_SAFE_INTEGER.

/**
 * Read a finite env-overridable retention window in days.
 */
function readRetentionDays(environment: Environment, key: string, fallback: number): number {
  return readInteger(environment, key, fallback, ONE_DAY_MIN, ONE_DAY_MAX);
}

/**
 * Read an env-overridable retention window in days, returning `null` for
 * `"unlimited"`. Used for paid-tier windows where policy specifies unlimited
 * retention (the purge job then skips the workspace).
 */
function readOptionalRetentionDays(
  environment: Environment,
  key: string,
  fallback: number | null,
): number | null {
  const raw = environment[key];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  if (raw.trim().toLowerCase() === "unlimited") {
    return null;
  }
  return readInteger(environment, key, fallback ?? ONE_DAY_MIN, ONE_DAY_MIN, ONE_DAY_MAX);
}

export function parseRetentionConfig(environment: Environment): RetentionConfig {
  try {
    return Object.freeze({
      deletedNoteRetentionDaysFree: readRetentionDays(
        environment,
        "RETENTION_DELETED_NOTE_DAYS_FREE",
        30,
      ),
      deletedNoteRetentionDaysPro: readOptionalRetentionDays(
        environment,
        "RETENTION_DELETED_NOTE_DAYS_PRO",
        null,
      ),
      deletedNoteRetentionDaysEnterprise: readOptionalRetentionDays(
        environment,
        "RETENTION_DELETED_NOTE_DAYS_ENTERPRISE",
        null,
      ),
      noteVersionRetentionDaysFree: readRetentionDays(
        environment,
        "RETENTION_NOTE_VERSION_DAYS_FREE",
        30,
      ),
      noteVersionRetentionDaysPro: readOptionalRetentionDays(
        environment,
        "RETENTION_NOTE_VERSION_DAYS_PRO",
        null, // unlimited for Pro (Notted.md).
      ),
      noteVersionRetentionDaysEnterprise: readOptionalRetentionDays(
        environment,
        "RETENTION_NOTE_VERSION_DAYS_ENTERPRISE",
        null,
      ),
      auditLogRetentionDays: readRetentionDays(environment, "RETENTION_AUDIT_LOG_DAYS", 365),
      exportObjectRetentionDays: readRetentionDays(
        environment,
        "RETENTION_EXPORT_OBJECT_DAYS",
        7, // ADR 0007.
      ),
      sessionShortLivedHours: readInteger(
        environment,
        "SESSION_SHORT_LIVED_HOURS",
        24, // ADR 0007.
        1,
        24 * 365, // up to a year for unusual deployments.
      ),
      sessionRememberMeDays: readInteger(
        environment,
        "SESSION_REMEMBER_ME_DAYS",
        30, // ADR 0007.
        1,
        365, // up to a year for unusual deployments.
      ),
      orphanedObjectCleanupDays: readRetentionDays(
        environment,
        "RETENTION_ORPHANED_OBJECT_DAYS",
        7, // ADR 0005 reconciliation grace period.
      ),
    });
  } catch (error: unknown) {
    wrapConfigError("Invalid retention configuration", error);
  }
}

@Injectable()
export class RetentionConfigProvider {
  readonly value = parseRetentionConfig(process.env);
}

export const retentionConfigProvider: Provider<RetentionConfig> = {
  provide: RETENTION_CONFIG,
  inject: [RetentionConfigProvider],
  useFactory: (provider: RetentionConfigProvider): RetentionConfig => provider.value,
};
