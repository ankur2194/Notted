import { describe, expect, it } from "vitest";

import {
  signatureHeader,
  verifyWebhookSignature,
  webhookBody,
  webhookSignature,
} from "./webhook-signature";
import { WEBHOOK_SIGNATURE_TOLERANCE_SECONDS } from "./webhooks.constants";

const SECRET = "whsec_fixture-secret";
const OTHER_SECRET = "whsec_other-secret";
const FIXTURE_TIMESTAMP = 1_700_000_000;

const FIXTURE_INPUT = {
  id: "evt_00000000-0000-4000-8000-000000000001",
  event: "note.created",
  occurredAt: "2026-01-01T00:00:00.000+00:00",
  workspaceId: "00000000-0000-4000-8000-0000000000a0",
  actorId: null,
  data: { noteId: "note-1" },
} as const;

const FIXTURE_BODY =
  '{"id":"evt_00000000-0000-4000-8000-000000000001","event":"note.created","occurredAt":"2026-01-01T00:00:00.000+00:00","workspaceId":"00000000-0000-4000-8000-0000000000a0","actorId":null,"data":{"noteId":"note-1"}}';

// Computed out of band (`node -e` with node:crypto), NOT with the helper under
// test: a fixture recomputed by its own implementation would happily follow the
// implementation into a breaking change and never fail.
const FIXTURE_DIGEST = "f4dd80539cae7aa4fd0da5bf957993d972646c9509300fb4f2fc196b1960e468";

describe("webhookBody", () => {
  it("emits the six envelope keys in the signed contract order", () => {
    // Asserted on the exact string: the key order IS the wire format, so a
    // reordering must fail here rather than in every receiver's signature check.
    expect(webhookBody(FIXTURE_INPUT)).toBe(FIXTURE_BODY);
  });
});

describe("webhookSignature", () => {
  it("matches the published fixture digest", () => {
    expect(webhookSignature(SECRET, FIXTURE_TIMESTAMP, FIXTURE_BODY)).toBe(FIXTURE_DIGEST);
  });

  it("is deterministic for the same secret, timestamp and body", () => {
    expect(webhookSignature(SECRET, FIXTURE_TIMESTAMP, FIXTURE_BODY)).toBe(
      webhookSignature(SECRET, FIXTURE_TIMESTAMP, FIXTURE_BODY),
    );
  });

  it("changes completely for a one-byte body change", () => {
    const tampered = FIXTURE_BODY.replace('"note-1"', '"note-2"');
    expect(tampered).not.toBe(FIXTURE_BODY);
    expect(webhookSignature(SECRET, FIXTURE_TIMESTAMP, tampered)).not.toBe(FIXTURE_DIGEST);
  });

  it("binds the timestamp, so a captured delivery cannot be replayed with a fresher t=", () => {
    expect(webhookSignature(SECRET, FIXTURE_TIMESTAMP + 1, FIXTURE_BODY)).not.toBe(FIXTURE_DIGEST);
  });
});

describe("signatureHeader", () => {
  it("emits t=<seconds>,v1=<lowercase hex>", () => {
    expect(signatureHeader(SECRET, FIXTURE_TIMESTAMP, FIXTURE_BODY)).toBe(
      `t=${FIXTURE_TIMESTAMP},v1=${FIXTURE_DIGEST}`,
    );
  });
});

describe("verifyWebhookSignature", () => {
  const header = signatureHeader(SECRET, FIXTURE_TIMESTAMP, FIXTURE_BODY);

  it("accepts a freshly signed header", () => {
    expect(verifyWebhookSignature(SECRET, header, FIXTURE_BODY, FIXTURE_TIMESTAMP)).toBe(true);
  });

  it("rejects a wrong secret", () => {
    expect(verifyWebhookSignature(OTHER_SECRET, header, FIXTURE_BODY, FIXTURE_TIMESTAMP)).toBe(
      false,
    );
  });

  it("rejects a tampered body", () => {
    expect(verifyWebhookSignature(SECRET, header, `${FIXTURE_BODY} `, FIXTURE_TIMESTAMP)).toBe(
      false,
    );
  });

  it.each([
    ["empty", ""],
    ["no version field", `t=${FIXTURE_TIMESTAMP}`],
    ["unknown version", `t=${FIXTURE_TIMESTAMP},v2=${FIXTURE_DIGEST}`],
    ["non-numeric timestamp", `t=now,v1=${FIXTURE_DIGEST}`],
    ["short digest", `t=${FIXTURE_TIMESTAMP},v1=abcdef`],
    ["upper-case digest", `t=${FIXTURE_TIMESTAMP},v1=${FIXTURE_DIGEST.toUpperCase()}`],
    ["reordered fields", `v1=${FIXTURE_DIGEST},t=${FIXTURE_TIMESTAMP}`],
  ])("rejects a malformed header (%s)", (_label, malformed) => {
    expect(verifyWebhookSignature(SECRET, malformed, FIXTURE_BODY, FIXTURE_TIMESTAMP)).toBe(false);
  });

  it("rejects a timestamp outside tolerance in both directions", () => {
    const past = FIXTURE_TIMESTAMP + WEBHOOK_SIGNATURE_TOLERANCE_SECONDS + 1;
    const future = FIXTURE_TIMESTAMP - WEBHOOK_SIGNATURE_TOLERANCE_SECONDS - 1;
    expect(verifyWebhookSignature(SECRET, header, FIXTURE_BODY, past)).toBe(false);
    expect(verifyWebhookSignature(SECRET, header, FIXTURE_BODY, future)).toBe(false);
    // The edge of the window is still inside it.
    expect(
      verifyWebhookSignature(
        SECRET,
        header,
        FIXTURE_BODY,
        FIXTURE_TIMESTAMP + WEBHOOK_SIGNATURE_TOLERANCE_SECONDS,
      ),
    ).toBe(true);
  });

  it("honours an explicit tolerance", () => {
    expect(verifyWebhookSignature(SECRET, header, FIXTURE_BODY, FIXTURE_TIMESTAMP + 10, 5)).toBe(
      false,
    );
    expect(verifyWebhookSignature(SECRET, header, FIXTURE_BODY, FIXTURE_TIMESTAMP + 10, 30)).toBe(
      true,
    );
  });
});
