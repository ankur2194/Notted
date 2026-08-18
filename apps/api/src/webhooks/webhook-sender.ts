// Part 66 — the outbound webhook HTTP client.
//
// WHY `node:http(s).request` AND NOT `fetch`:
//
//   * Pinning the address we validated while keeping TLS SNI and certificate
//     validation correct is impossible with `fetch` without reaching into
//     `undici`, and rewriting the URL to an IP literal breaks certificate
//     validation outright. `request` takes a `lookup` callback, so the address
//     guard runs at socket-connect time against the real hostname.
//   * `request` NEVER follows a redirect. A 3xx is data, not a second request,
//     and no `maxRedirects`-style option may ever be added here: following a
//     redirect would re-open the SSRF hole every layer of the guard closes.
//   * `req.setTimeout` and `res.on("data")` + `res.destroy()` give us the
//     inactivity budget and the byte cap without a wrapper library.
//
// `apps/api` has no HTTP client dependency and must not gain one for this.
//
// RESPONSE SIZE POLICY (the worker's classification table must match this):
//
//   * A body larger than `WEBHOOK_RESPONSE_READ_LIMIT_BYTES` is NOT a failure.
//     A 200 is a successful delivery however chatty the receiver is, and
//     failing it would retry a working endpoint forever. We stop reading at the
//     cap, destroy the response, and keep the status with a capped snippet.
//   * A DECLARED `content-length` above the cap short-circuits the same way and
//     we never read the body at all, so the snippet is `null`.
//   * The sender therefore never emits `"response_too_large"`. That code stays
//     in the shared vocabulary for the service and worker layer; every size
//     decision made here ends in a `response` outcome.
//
// Node's `error.message` is NEVER returned or logged from here: it quotes the
// endpoint URL, which is admin-supplied and routinely carries a bearer token in
// its path or query. Only the closed `WebhookDeliveryErrorCode` set escapes.

import { request as httpRequest, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";

import {
  guardedLookup,
  inspectWebhookUrl,
  resolveWebhookHost,
  WEBHOOK_BLOCKED_ERROR_CODE,
  type WebhookDnsLookup,
  type WebhookUrlGuardOptions,
} from "./webhook-url-guard";
import {
  WEBHOOK_RESPONSE_READ_LIMIT_BYTES,
  WEBHOOK_SNIPPET_MAX_LENGTH,
} from "./webhooks.constants";

import type { WebhookDeliveryErrorCode } from "@notted/shared-types";

export interface WebhookSendRequest {
  readonly url: string;
  /** The EXACT bytes that were signed. Never re-serialized here. */
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly guard: WebhookUrlGuardOptions;
  readonly signal?: AbortSignal;
}

export type WebhookSendResult =
  | {
      readonly outcome: "response";
      readonly status: number;
      readonly snippet: string | null;
      readonly durationMs: number;
    }
  | {
      readonly outcome: "error";
      readonly errorCode: WebhookDeliveryErrorCode;
      readonly durationMs: number;
    };

/**
 * ANSI sequences go first — dropping the ESC alone would leave `[31m` behind.
 * The ESC is composed rather than written literally so the pattern carries no
 * raw control character in source.
 */
const ANSI_SEQUENCE = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "gu");
const CONTROL_CHARACTERS = /[\p{Cc}\p{Cf}]/gu;

/**
 * TLS and certificate failures are kept apart from ordinary connection
 * failures: an admin needs to see "your certificate is wrong" rather than
 * "unreachable", because the two need completely different fixes.
 */
const TLS_ERROR_CODES = new Set([
  "EPROTO",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "ERR_SSL_WRONG_VERSION_NUMBER",
]);

function classifySocketError(code: string | undefined): WebhookDeliveryErrorCode {
  if (code === WEBHOOK_BLOCKED_ERROR_CODE) return "dns_blocked";
  if (code !== undefined && (TLS_ERROR_CODES.has(code) || code.startsWith("ERR_TLS_"))) {
    return "tls_failed";
  }
  // ENOTFOUND / EAI_AGAIN (DNS), ECONNREFUSED, ECONNRESET, EHOSTUNREACH and
  // EPIPE all mean one thing to an admin: we could not talk to the endpoint.
  return "connection_failed";
}

/**
 * A snippet is produced ONLY for a textual content type. A binary body would
 * otherwise land in the delivery log as mojibake — and that log is rendered in
 * the UI, so control characters and ANSI escapes are stripped as well.
 */
function buildSnippet(contentType: string | undefined, raw: string): string | null {
  const type = (contentType ?? "").toLowerCase();
  if (!type.startsWith("text/") && !type.includes("json")) return null;
  return raw
    .replace(ANSI_SEQUENCE, "")
    .replace(CONTROL_CHARACTERS, "")
    .trim()
    .slice(0, WEBHOOK_SNIPPET_MAX_LENGTH);
}

export async function sendWebhook(
  request: WebhookSendRequest,
  lookup?: WebhookDnsLookup,
): Promise<WebhookSendResult> {
  const startedAt = performance.now();
  const elapsed = (): number => Math.max(0, Math.round(performance.now() - startedAt));

  // L1–L3, then L5. A rejection here never opens a socket.
  const inspected = inspectWebhookUrl(request.url, request.guard);
  if (!inspected.ok) {
    return { outcome: "error", errorCode: "url_rejected", durationMs: elapsed() };
  }
  const resolution = await resolveWebhookHost(inspected.url.hostname, request.guard, lookup);
  if (resolution === "dns_blocked") {
    return { outcome: "error", errorCode: "dns_blocked", durationMs: elapsed() };
  }
  const url = inspected.url;

  return new Promise<WebhookSendResult>((resolve) => {
    // SETTLE-ONCE LATCH. Several listeners legitimately race to finish this
    // attempt — the response's "end"/"close"/"error", the socket's "error", the
    // inactivity timeout, the wall clock, an abort — and every one of them can
    // fire after another has already won. Exactly one outcome is recorded,
    // which is what keeps the delivery log at one row per attempt.
    let settled = false;

    const send = (result: WebhookSendResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(wallClock);
      request.signal?.removeEventListener("abort", timedOut);
      resolve(result);
    };

    const client = url.protocol === "https:" ? httpsRequest : httpRequest;
    // `autoSelectFamily` is a `net.connect` option that `http.request` forwards
    // but does not declare, hence the widened type rather than a cast.
    const options: RequestOptions & { autoSelectFamily: boolean } = {
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port === "" ? undefined : url.port,
      path: `${url.pathname}${url.search}`,
      method: "POST",
      headers: {
        ...request.headers,
        // Always derived from the bytes we actually write, so a caller can
        // never desynchronise the framing from the signed payload.
        "content-length": Buffer.byteLength(request.body).toString(),
      },
      // L6: the same address filter, re-run at socket-connect time.
      lookup: guardedLookup(request.guard, lookup),
      // ONE CONNECTION ATTEMPT PER SEND. Node's Happy Eyeballs default opens a
      // socket per address family in parallel, so a dual-stack endpoint
      // produced two races to the same `send` and the recorded error code
      // depended on which socket lost first. One attempt, one outcome.
      autoSelectFamily: false,
    };
    const outbound = client(options, (response) => {
      const status = response.statusCode ?? 0;

      const declaredLength = Number(response.headers["content-length"]);
      if (Number.isFinite(declaredLength) && declaredLength > WEBHOOK_RESPONSE_READ_LIMIT_BYTES) {
        response.destroy();
        send({ outcome: "response", status, snippet: null, durationMs: elapsed() });
        return;
      }

      const chunks: Buffer[] = [];
      let read = 0;
      response.on("data", (chunk: Buffer) => {
        const remaining = WEBHOOK_RESPONSE_READ_LIMIT_BYTES - read;
        if (remaining > 0) {
          chunks.push(chunk.subarray(0, remaining));
          read += Math.min(chunk.byteLength, remaining);
        }
        if (read >= WEBHOOK_RESPONSE_READ_LIMIT_BYTES) response.destroy();
      });

      const finish = (): void => {
        send({
          outcome: "response",
          status,
          snippet: buildSnippet(
            response.headers["content-type"],
            Buffer.concat(chunks).toString("utf8"),
          ),
          durationMs: elapsed(),
        });
      };
      response.on("end", finish);
      // Hitting the byte cap destroys the stream, which closes it without an
      // "end" event; `send` is idempotent, so both paths can be wired.
      response.on("close", finish);
      response.on("error", finish);
    });

    // LATCH BEFORE DESTROYING. `destroy()` tears the socket down, and the
    // request emits ECONNRESET for a response that never arrived. Settling
    // first makes the classification deterministic: a receiver that accepts the
    // connection and never answers is ALWAYS `timeout`, never the
    // `connection_failed` its own teardown would otherwise report.
    const timedOut = (): void => {
      send({ outcome: "error", errorCode: "timeout", durationMs: elapsed() });
      outbound.destroy();
    };

    // Two clocks on purpose. `setTimeout` on the request is socket INACTIVITY;
    // the wall clock covers DNS, TLS, headers and body together, so a receiver
    // that dribbles one byte just inside the inactivity budget forever still
    // terminates.
    const wallClock = setTimeout(timedOut, request.timeoutMs);
    wallClock.unref();
    outbound.setTimeout(request.timeoutMs, timedOut);

    outbound.on("error", (error: NodeJS.ErrnoException) => {
      send({ outcome: "error", errorCode: classifySocketError(error.code), durationMs: elapsed() });
    });

    // An abort is a timeout by another name: the caller stopped waiting.
    if (request.signal?.aborted === true) {
      timedOut();
      return;
    }
    request.signal?.addEventListener("abort", timedOut, { once: true });

    outbound.end(request.body);
  });
}
