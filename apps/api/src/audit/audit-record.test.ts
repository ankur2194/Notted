import { describe, expect, it, vi } from "vitest";

import { runWithRequestContext } from "../common/request/request-context";
import { auditLogs } from "../database/schema";

import {
  AUDIT_REDACTED,
  AUDIT_TRUNCATED,
  allowAuditDelete,
  recordAudit,
  redactAuditMetadata,
  type AuditWriter,
} from "./audit-record";

const WORKSPACE_ID = "70000000-0000-4000-8000-000000000001";
const USER_ID = "70000000-0000-4000-8000-000000000002";
const ENTITY_ID = "70000000-0000-4000-8000-000000000003";

function writer() {
  const inserted: { table: unknown; values: Record<string, unknown> }[] = [];
  const db = {
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        inserted.push({ table, values });
        return Promise.resolve();
      },
    }),
  } as unknown as AuditWriter;
  return { db, inserted };
}

const event = {
  workspaceId: WORKSPACE_ID,
  userId: USER_ID,
  action: "apiKey.created",
  entityType: "api_key",
  entityId: ENTITY_ID,
};

describe("redactAuditMetadata", () => {
  it("blanks credential-shaped keys by exact name and by suffix", () => {
    expect(
      redactAuditMetadata({
        token: "t",
        Secret: "s",
        webhookSecret: "w",
        downloadUrl: "https://example.test/x",
        payload_hash: "abc",
        URL: "https://example.test",
      }),
    ).toEqual({
      token: AUDIT_REDACTED,
      Secret: AUDIT_REDACTED,
      webhookSecret: AUDIT_REDACTED,
      downloadUrl: AUDIT_REDACTED,
      payload_hash: AUDIT_REDACTED,
      URL: AUDIT_REDACTED,
    });
  });

  it("leaves every key the existing thirteen writers already pass untouched", () => {
    const existing = {
      keyPrefix: "ntd_pk_a",
      scopes: ["read", "write"],
      host: "hooks.example.test",
      events: ["note.created"],
      isEnabled: true,
      isVerified: false,
      encryptionKeyVersion: 2,
      eventId: ENTITY_ID,
      deliveryId: ENTITY_ID,
      fields: ["name", "slug"],
      from: "editor",
      to: "admin",
      role: "admin",
      status: "pending",
      invitationId: ENTITY_ID,
      provider: "openai",
      model: "gpt-4o-mini",
      dailyTokenQuota: 1_000,
      rateLimitPerMinute: 10,
      contentConsent: true,
      credentialChanged: false,
      dryRun: true,
      sweeps: [{ sweep: "orphans", selected: 3 }],
    };

    expect(redactAuditMetadata(existing)).toEqual(existing);
  });

  it("redacts nested keys and truncates beyond the depth cap", () => {
    expect(
      redactAuditMetadata({ a: { b: { c: { d: { e: 1 } } } }, outer: { secret: "s" } }),
    ).toEqual({ a: { b: { c: { d: AUDIT_TRUNCATED } } }, outer: { secret: AUDIT_REDACTED } });
  });

  it("does not mutate the caller's frozen literal", () => {
    const original = Object.freeze({ token: "t", role: "admin" });

    expect(() => redactAuditMetadata(original)).not.toThrow();
    expect(original.token).toBe("t");
  });
});

describe("recordAudit", () => {
  it("writes exactly one row carrying the ambient request facts", async () => {
    const { db, inserted } = writer();

    await runWithRequestContext(
      { requestId: "request-1", ipAddress: "203.0.113.9", userAgent: "curl/8" },
      () => recordAudit(db, { ...event, metadata: { keyPrefix: "ntd_pk_a" } }),
    );

    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.table).toBe(auditLogs);
    expect(inserted[0]?.values).toEqual({
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      action: "apiKey.created",
      entityType: "api_key",
      entityId: ENTITY_ID,
      metadata: { keyPrefix: "ntd_pk_a" },
      ipAddress: "203.0.113.9",
      userAgent: "curl/8",
      requestId: "request-1",
    });
  });

  it("records nulls outside a request rather than refusing to audit", async () => {
    const { db, inserted } = writer();

    await recordAudit(db, event);

    expect(inserted[0]?.values).toMatchObject({
      metadata: {},
      ipAddress: null,
      userAgent: null,
      requestId: null,
    });
  });

  it("prefers an explicit correlation id over the ambient one", async () => {
    const { db, inserted } = writer();

    await runWithRequestContext({ requestId: "ambient", ipAddress: null, userAgent: null }, () =>
      recordAudit(db, { ...event, requestId: "explicit" }),
    );

    expect(inserted[0]?.values.requestId).toBe("explicit");
  });

  it("redacts credential-shaped metadata before it reaches the column", async () => {
    const { db, inserted } = writer();

    await recordAudit(db, { ...event, metadata: { secret: "ntd_wh_live", host: "a.test" } });

    expect(JSON.stringify(inserted[0]?.values)).not.toContain("ntd_wh_live");
    expect(inserted[0]?.values.metadata).toEqual({ secret: AUDIT_REDACTED, host: "a.test" });
  });
});

describe("allowAuditDelete", () => {
  it("sets the purge flag transaction-locally", async () => {
    const execute = vi.fn().mockResolvedValue(undefined);

    await allowAuditDelete({ execute } as never);

    const statement = execute.mock.calls[0]?.[0] as { queryChunks?: unknown[] };
    expect(JSON.stringify(statement)).toContain("notted.audit_purge");
    // The third `set_config` argument is `true` — local to the transaction, so
    // the permission cannot survive onto a pooled connection.
    expect(JSON.stringify(statement)).toContain("true");
  });
});
