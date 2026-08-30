import { getRequestId } from "../request/request-context";

import type { ApiErrorEnvelope } from "./api-error";
import type { ApiError } from "@notted/shared-types";
import type { Request, Response } from "express";

/**
 * The one place the `/api/v1` failure envelope is built.
 *
 * It was built by hand at sixteen sites — ten in `main.ts` and one each in the
 * Bull Board mount, the CSRF origin check, the auth rate limiter, and twice in
 * the trusted-host middleware — plus once, correctly, in
 * `ApiExceptionFilter`. Every hand-written copy is a chance for a client to
 * meet a second envelope shape depending on which layer refused, and they had
 * already drifted: the filter falls back to a `requestId` of `"unavailable"`
 * while all sixteen others said `"unknown"`, so the same deployment answered
 * two different ways for the same missing value.
 *
 * They had also all written `response.getHeader("X-Request-Id")` straight into
 * the envelope. That returns `number | string | string[] | undefined`, so a
 * duplicated header would have serialized `requestId` as an ARRAY against a
 * contract that says string. Normalising here removes that too.
 *
 * These sites cannot use the filter itself: they are raw Express middleware
 * mounted before or outside the Nest pipeline, which is exactly why they had to
 * write the envelope themselves in the first place. What they can share is this.
 */
export const REQUEST_ID_UNAVAILABLE = "unavailable";

/** The header `RequestContextMiddleware` sets on every response. */
const REQUEST_ID_HEADER = "X-Request-Id";

function requestIdFrom(response: Response): string {
  const header = response.getHeader(REQUEST_ID_HEADER);
  if (typeof header === "string" && header !== "") return header;
  if (typeof header === "number") return String(header);
  // A duplicated header arrives as an array; take the first non-empty entry
  // rather than serializing the array into a string-typed field.
  if (Array.isArray(header)) {
    const first = header.find((value) => value !== "");
    if (first !== undefined) return first;
  }
  return REQUEST_ID_UNAVAILABLE;
}

/**
 * Writes one `ApiFailure` response.
 *
 * Pass `request` when the caller has it: `getRequestId` reads the value the
 * middleware stored rather than the header it echoed, so it does not depend on
 * the header having been written yet. Callers that pass a request never consult
 * the response header at all — a caller holding the request and finding no
 * stored id has nothing useful in the header either, and reaching for it would
 * make this function's answer depend on middleware ordering.
 */
export function writeApiFailure(
  response: Response,
  status: number,
  error: ApiError,
  request?: Request,
): void {
  const envelope: ApiErrorEnvelope = {
    success: false,
    error,
    requestId:
      request === undefined
        ? requestIdFrom(response)
        : (getRequestId(request) ?? REQUEST_ID_UNAVAILABLE),
  };
  response.status(status).json(envelope);
}
