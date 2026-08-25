// Part 71 — the audit CSV encoder.
//
// Pure formatting, no Nest and no I/O: `audit-logs.controller.ts` and this
// module's own test both import it directly.
//
// RFC 4180 QUOTING. A field containing a double quote, a comma, a CR, or an
// LF is wrapped in double quotes, with any inner double quote doubled. Lines
// are CRLF-terminated, including the header and the final row.
//
// FORMULA INJECTION (CWE-1236 / OWASP "CSV injection"). `action`, `entityType`,
// `userName`, and `metadata` all originate from data — a display name a member
// chose, or a polymorphic entity payload — not from a fixed string this module
// controls. Opening the file in a spreadsheet application evaluates a cell
// whose FIRST character is `=`, `+`, `-`, `@`, a tab, or a carriage return as a
// formula, which can exfiltrate other cells or shell out via
// `=WEBSERVICE(...)`/`=cmd|...`. Prefixing such a value with a single
// apostrophe forces the cell to render as text in every major spreadsheet
// application; the apostrophe itself never shows once rendered. The prefix is
// applied BEFORE the quoting decision, since quoting must still trigger if the
// now-prefixed value also contains a comma or a quote.

import type { AuditLogEntry } from "@notted/shared-types";

const CRLF = "\r\n";

const HEADER = [
  "id",
  "createdAt",
  "action",
  "entityType",
  "entityId",
  "userId",
  "userName",
  "ipAddress",
  "userAgent",
  "requestId",
  "metadata",
] as const;

const DANGEROUS_LEADING_CHARS: ReadonlySet<string> = new Set(["=", "+", "-", "@", "\t", "\r"]);

function escapeField(value: string): string {
  const guarded = DANGEROUS_LEADING_CHARS.has(value.charAt(0)) ? `'${value}` : value;
  const needsQuoting = /["\r\n,]/u.test(guarded);
  return needsQuoting ? `"${guarded.replace(/"/gu, '""')}"` : guarded;
}

/** `null` -> an empty field, never the literal text "null". */
function field(value: string | null): string {
  return value === null ? "" : escapeField(value);
}

/**
 * `metadata` is `unknown` (it is `jsonValueSchema`, which allows the JSON
 * value `null` itself, distinct from "no metadata"). Either way it renders as
 * an empty field rather than the four-character string `"null"`.
 */
function metadataField(metadata: unknown): string {
  return field(metadata === null ? null : JSON.stringify(metadata));
}

function rowToCsv(row: AuditLogEntry): string {
  return [
    field(row.id),
    field(row.createdAt),
    field(row.action),
    field(row.entityType),
    field(row.entityId),
    field(row.userId),
    field(row.userName),
    field(row.ipAddress),
    field(row.userAgent),
    field(row.requestId),
    metadataField(row.metadata),
  ].join(",");
}

/** RFC 4180 CSV, CRLF-terminated, with formula-injection guarding on every field. */
export function auditLogsToCsv(rows: readonly AuditLogEntry[]): string {
  return [HEADER.join(","), ...rows.map(rowToCsv)].map((line) => line + CRLF).join("");
}
