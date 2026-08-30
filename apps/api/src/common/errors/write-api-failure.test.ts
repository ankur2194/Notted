import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import process from "node:process";

import { describe, expect, it, vi } from "vitest";

import { REQUEST_ID_UNAVAILABLE, writeApiFailure } from "./write-api-failure";

import type { Request, Response } from "express";

function responseDouble(header?: number | string | readonly string[]): {
  readonly response: Response;
  readonly status: ReturnType<typeof vi.fn>;
  readonly json: ReturnType<typeof vi.fn>;
} {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  const response = {
    status,
    getHeader: () => header,
  } as unknown as Response;
  return { response, status, json };
}

describe("writeApiFailure", () => {
  it("writes the ApiFailure envelope with the request id from the response header", () => {
    const { response, status, json } = responseDouble("request-1");
    writeApiFailure(response, 413, { code: "PAYLOAD_TOO_LARGE", message: "Too large." });

    expect(status).toHaveBeenCalledWith(413);
    expect(json).toHaveBeenCalledWith({
      success: false,
      error: { code: "PAYLOAD_TOO_LARGE", message: "Too large." },
      requestId: "request-1",
    });
  });

  /*
   * `getHeader` answers `number | string | string[] | undefined`, and every one
   * of the sixteen hand-written envelopes assigned it straight into a field the
   * contract types as a string. A duplicated `X-Request-Id` would have
   * serialized `requestId` as an array.
   */
  it.each([
    [["request-a", "request-b"], "request-a"],
    [["", "request-b"], "request-b"],
    [7, "7"],
    [undefined, REQUEST_ID_UNAVAILABLE],
    ["", REQUEST_ID_UNAVAILABLE],
  ])("normalises the %o header to a string request id", (header, expected) => {
    const { json } = (() => {
      const double = responseDouble(header as number | string | readonly string[] | undefined);
      writeApiFailure(double.response, 500, { code: "INTERNAL_SERVER_ERROR", message: "Boom." });
      return double;
    })();

    expect(json.mock.calls[0]?.[0]).toMatchObject({ requestId: expected });
  });

  /*
   * The drift this helper exists to remove: `ApiExceptionFilter` fell back to
   * "unavailable" and all sixteen inline copies said "unknown", so one
   * deployment answered two ways for the same missing value. Nothing asserted
   * either string, which is why it survived.
   */
  it("uses one fallback string whether or not a request is supplied", () => {
    const withoutRequest = responseDouble(undefined);
    writeApiFailure(withoutRequest.response, 503, { code: "SERVICE_UNAVAILABLE", message: "No." });

    const withRequest = responseDouble("ignored-header");
    writeApiFailure(
      withRequest.response,
      503,
      { code: "SERVICE_UNAVAILABLE", message: "No." },
      {} as Request,
    );

    expect(withoutRequest.json.mock.calls[0]?.[0]).toMatchObject({
      requestId: REQUEST_ID_UNAVAILABLE,
    });
    // A caller holding the request does not fall back to the header: doing so
    // would make the answer depend on middleware ordering.
    expect(withRequest.json.mock.calls[0]?.[0]).toMatchObject({
      requestId: REQUEST_ID_UNAVAILABLE,
    });
  });
});

/*
 * The seventeenth site is the one this cannot stop by construction, so it is
 * stopped here instead. `main.ts` alone held ten hand-built envelopes, and five
 * more lived in middleware; the next one would be written the same way, by
 * copying a neighbour.
 *
 * A source predicate rather than a lint rule: the shape is a repository
 * convention about one envelope, not a general pattern ESLint knows about, and
 * this is the same idiom `scripts/security-scan.test.mjs` uses over
 * `compose.yaml`. Comment lines are skipped — `openapi.builder.ts` documents
 * the envelope in prose, which is not a second implementation of it.
 */
it("builds the failure envelope in exactly one place", () => {
  // `process.cwd()`, the idiom every other test in this package uses to reach
  // the package root (`apps/api`); `import.meta` is unavailable here because
  // this package compiles as CommonJS.
  const apiRoot = resolve(process.cwd());
  // `readdirSync(..., { recursive: true })` rather than a glob dependency:
  // `src/` and `scripts/` are the only trees, and neither contains a symlink.
  const files = ["src", "scripts"].flatMap((tree) =>
    readdirSync(join(apiRoot, tree), { recursive: true, encoding: "utf8" })
      .filter((entry) => entry.endsWith(".ts") && !entry.endsWith(".test.ts"))
      .map((entry) => join(apiRoot, tree, entry)),
  );

  const offenders = files
    .filter((file) => !file.endsWith("write-api-failure.ts"))
    .flatMap((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .map((line, index) => ({ line: line.trim(), number: index + 1, file }))
        .filter(({ line }) => line.startsWith("success: false"))
        .map(({ file: path, number }) => `${relative(apiRoot, path)}:${number}`),
    );

  expect(offenders).toEqual([]);
  // The helper is genuinely reachable from the places that used to inline it.
  for (const caller of [
    "src/main.ts",
    "src/queue/bull-board.service.ts",
    "src/domains/trusted-host.middleware.ts",
    "src/auth/csrf-origin.middleware.ts",
    "src/auth/auth-rate-limit.middleware.ts",
    "src/common/errors/api-exception.filter.ts",
  ]) {
    expect(readFileSync(join(apiRoot, caller), "utf8")).toContain("writeApiFailure");
  }
});
