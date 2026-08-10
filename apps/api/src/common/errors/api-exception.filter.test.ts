import { describe, expect, it, vi } from "vitest";

import { AuthorizationDeniedError } from "../../authorization/authorization.errors";

import { ApiExceptionFilter } from "./api-exception.filter";

import type { AuthorizationDecision } from "../../authorization/authorization.contracts";
import type { StructuredLogger } from "../logging/structured-logger.service";
import type { ArgumentsHost } from "@nestjs/common";

type Denial = Extract<AuthorizationDecision, { readonly allowed: false }>;

function denial(
  code: Denial["code"],
  httpStatus: Denial["httpStatus"],
  safeMessage: string,
): AuthorizationDeniedError {
  return new AuthorizationDeniedError({
    allowed: false,
    code,
    httpStatus,
    safeMessage,
    audit: {
      action: "note.read",
      actorKind: "user",
      resourceKind: "note",
      outcome: "deny",
      reason: code,
    },
  });
}

function host() {
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  return {
    json,
    status,
    host: {
      switchToHttp: () => ({
        getRequest: () => ({}),
        getResponse: () => ({ status }),
      }),
    } as unknown as ArgumentsHost,
  };
}

/**
 * The regression this file exists for: a denial raised inside a HANDLER — a
 * service authorizing a nested resource it only learns about from the request,
 * such as a task list scoped to a foreign note id — used to reach the filter
 * untranslated and answer 500. That both paged an on-call engineer for a
 * working access check and told the caller that *something* exists behind the
 * identifier they were not allowed to name.
 */
describe("ApiExceptionFilter authorization denials", () => {
  it("conceals a denied cross-tenant resource as 404, never 500", () => {
    const { status, json, host: arguments_ } = host();
    const failure = vi.fn();
    new ApiExceptionFilter({ failure } as unknown as StructuredLogger).catch(
      denial("authorization.concealed", 404, "The requested resource was not found."),
      arguments_,
    );

    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: expect.objectContaining({ code: "NOT_FOUND" }),
      }),
    );
    // A denial is an answer, not a fault: logging it as a 5xx failure would
    // bury real outages in expected cross-tenant probes.
    expect(failure).not.toHaveBeenCalled();
  });

  it("keeps a genuine forbidden denial a 403", () => {
    const { status, json, host: arguments_ } = host();
    new ApiExceptionFilter({ failure: vi.fn() } as unknown as StructuredLogger).catch(
      denial("authorization.forbidden", 403, "You are not allowed to do that."),
      arguments_,
    );

    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ code: "FORBIDDEN" }) }),
    );
  });

  it("still reports an unrecognized failure as 500", () => {
    const { status, json, host: arguments_ } = host();
    new ApiExceptionFilter({ failure: vi.fn() } as unknown as StructuredLogger).catch(
      new Error("connection reset"),
      arguments_,
    );

    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({ code: "INTERNAL_SERVER_ERROR" }),
      }),
    );
  });
});
