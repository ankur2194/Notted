import { describe, expect, it } from "vitest";

import {
  webhookCreateSchema,
  webhookDeliveryListQuerySchema,
  webhookEventSchema,
  webhookUpdateSchema,
  webhookUrlSchema,
} from "./webhook.schema";

describe("webhookUrlSchema", () => {
  it("accepts absolute http(s) URLs", () => {
    for (const value of [
      "https://hooks.example.com/notted",
      "http://hooks.example.com/notted",
      "https://hooks.example.com:8443/a/b?c=1#d",
      // An `@` after the authority is ordinary data, not a credential.
      "https://hooks.example.com/inbox@team",
      "https://hooks.example.com/?to=a@b.example",
    ]) {
      expect(webhookUrlSchema.safeParse(value).success, value).toBe(true);
    }
  });

  it("rejects non-http schemes, relative values, and malformed input", () => {
    for (const value of [
      "ftp://hooks.example.com",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "data:text/plain,hi",
      "/notted",
      "hooks.example.com",
      "",
    ]) {
      expect(webhookUrlSchema.safeParse(value).success, value).toBe(false);
    }
  });

  it("rejects embedded credentials", () => {
    for (const value of [
      "https://user:pass@hooks.example.com/",
      "https://user@hooks.example.com/",
      "http://:pass@hooks.example.com/",
    ]) {
      expect(webhookUrlSchema.safeParse(value).success, value).toBe(false);
    }
  });

  it("rejects a URL beyond the 2048-character ceiling", () => {
    const long = `https://hooks.example.com/${"a".repeat(2_048)}`;
    expect(webhookUrlSchema.safeParse(long).success).toBe(false);
  });

  /**
   * The guard rail this whole schema is subordinate to: syntax acceptance here
   * says nothing about reachability. A private address is well-formed and MUST
   * still parse, because the authoritative SSRF verdict is server-side in
   * `webhook-url-guard.ts` — a client-side rejection is a convenience, never a
   * control.
   */
  it("accepts private and loopback addresses — the SSRF verdict is server-side", () => {
    for (const value of [
      "http://127.0.0.1:3001/hook",
      "http://169.254.169.254/latest/meta-data/",
      "http://10.0.0.1/hook",
    ]) {
      expect(webhookUrlSchema.safeParse(value).success, value).toBe(true);
    }
  });
});

describe("webhookEventSchema", () => {
  it("accepts every subscribable event", () => {
    for (const event of [
      "note.created",
      "note.updated",
      "note.deleted",
      "project.created",
      "member.joined",
    ]) {
      expect(webhookEventSchema.safeParse(event).success, event).toBe(true);
    }
  });

  it("rejects the verification event and unknown names", () => {
    // `webhook.verification` is sent only by the verify route and must never be
    // subscribable, or the producer could fan it out.
    for (const event of ["webhook.verification", "note.moved", "project.archived", "*"]) {
      expect(webhookEventSchema.safeParse(event).success, event).toBe(false);
    }
  });
});

describe("webhookCreateSchema", () => {
  it("requires a non-empty, duplicate-free event list", () => {
    const url = "https://hooks.example.com/notted";
    expect(webhookCreateSchema.safeParse({ url, events: ["note.created"] }).success).toBe(true);
    expect(webhookCreateSchema.safeParse({ url, events: [] }).success).toBe(false);
    expect(
      webhookCreateSchema.safeParse({ url, events: ["note.created", "note.created"] }).success,
    ).toBe(false);
  });

  it("rejects unknown keys", () => {
    const parsed = webhookCreateSchema.safeParse({
      url: "https://hooks.example.com/notted",
      events: ["note.created"],
      isEnabled: true,
    });
    expect(parsed.success).toBe(false);
  });
});

describe("webhookUpdateSchema", () => {
  it("accepts any single field", () => {
    expect(webhookUpdateSchema.safeParse({ isEnabled: true }).success).toBe(true);
    expect(webhookUpdateSchema.safeParse({ events: ["member.joined"] }).success).toBe(true);
    expect(webhookUpdateSchema.safeParse({ url: "https://a.example/h" }).success).toBe(true);
  });

  it("rejects an empty patch", () => {
    expect(webhookUpdateSchema.safeParse({}).success).toBe(false);
  });
});

describe("webhookDeliveryListQuerySchema", () => {
  it("defaults pagination and accepts a status filter", () => {
    const parsed = webhookDeliveryListQuerySchema.safeParse({ status: "failed" });
    expect(parsed.success && parsed.data).toMatchObject({ page: 1, limit: 25, status: "failed" });
  });

  it("rejects an unknown status and an out-of-range page", () => {
    expect(webhookDeliveryListQuerySchema.safeParse({ status: "exploded" }).success).toBe(false);
    expect(webhookDeliveryListQuerySchema.safeParse({ page: "10001" }).success).toBe(false);
  });
});
