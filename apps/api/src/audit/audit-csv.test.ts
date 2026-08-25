// Part 71 — the audit CSV encoder.

import { describe, expect, it } from "vitest";

import { auditLogsToCsv } from "./audit-csv";

import type { AuditLogEntry } from "@notted/shared-types";

function entry(overrides: Partial<AuditLogEntry> = {}): AuditLogEntry {
  return Object.freeze({
    id: "10000000-0000-4000-8000-000000000001",
    workspaceId: "20000000-0000-4000-8000-000000000001",
    userId: "30000000-0000-4000-8000-000000000001",
    userName: "Ada Lovelace",
    action: "note.update",
    entityType: "note",
    entityId: "40000000-0000-4000-8000-000000000001",
    metadata: { field: "title" },
    ipAddress: "203.0.113.7",
    userAgent: "Mozilla/5.0",
    requestId: "req-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  });
}

describe("auditLogsToCsv", () => {
  it("emits the fixed, CRLF-terminated header row for an empty page", () => {
    expect(auditLogsToCsv([])).toBe(
      "id,createdAt,action,entityType,entityId,userId,userName,ipAddress,userAgent,requestId,metadata\r\n",
    );
  });

  it("quotes a field containing a comma, a double quote, and a newline, doubling inner quotes", () => {
    const csv = auditLogsToCsv([entry({ userName: 'Ada, "The Enchantress"\nLovelace' })]);
    expect(csv).toContain('"Ada, ""The Enchantress""\nLovelace"');
  });

  it.each(["=", "+", "-", "@", "\t", "\r"])(
    "prefixes a value starting with %j with an apostrophe (formula-injection guard)",
    (leadingChar) => {
      const csv = auditLogsToCsv([entry({ action: `${leadingChar}cmd` })]);
      expect(csv).toContain(`'${leadingChar}cmd`);
    },
  );

  it("does not prefix a value that does not start with a dangerous character", () => {
    const csv = auditLogsToCsv([entry({ action: "note.update" })]);
    expect(csv).not.toContain("'note.update");
    expect(csv).toContain(",note.update,");
  });

  it("renders a null actor (userId and userName) as empty fields", () => {
    const withoutActor = entry({ userId: null, userName: null });
    const csv = auditLogsToCsv([withoutActor]);
    // Header order is ...,entityId,userId,userName,ipAddress,... — two empty
    // fields sit back-to-back between the real entityId and ipAddress values.
    expect(csv).toContain(`${withoutActor.entityId},,,${withoutActor.ipAddress}`);
  });

  it("serialises metadata as JSON", () => {
    const csv = auditLogsToCsv([entry({ metadata: { from: "editor", to: "admin" } })]);
    expect(csv).toContain('"{""from"":""editor"",""to"":""admin""}"');
  });

  it('renders a JSON-null metadata value as an empty field, not the text "null"', () => {
    const csv = auditLogsToCsv([entry({ metadata: null })]);
    expect(csv.endsWith(",req-1,\r\n")).toBe(true);
  });

  it("terminates the header and every data row with CRLF", () => {
    const csv = auditLogsToCsv([entry(), entry()]);
    expect(csv.match(/\r\n/gu)).toHaveLength(3);
    expect(csv.endsWith("\r\n")).toBe(true);
  });
});
