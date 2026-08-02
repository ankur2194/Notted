import { HttpStatus } from "@nestjs/common";
import { initTRPC, TRPCError, type TRPC_ERROR_CODE_KEY } from "@trpc/server";

import { AuthorizationDeniedError } from "../authorization/authorization.errors";
import { ApiHttpException } from "../common/errors/api-http.exception";

import type { TrpcContext } from "./trpc.context";

export const TRPC_PATH = "/api/v1/trpc" as const;
export const trpc = initTRPC.context<TrpcContext>().create({ isDev: false });

function codeForStatus(status: number): TRPC_ERROR_CODE_KEY {
  switch (status) {
    case HttpStatus.BAD_REQUEST:
      return "BAD_REQUEST";
    case HttpStatus.UNAUTHORIZED:
      return "UNAUTHORIZED";
    case HttpStatus.FORBIDDEN:
      return "FORBIDDEN";
    case HttpStatus.NOT_FOUND:
      return "NOT_FOUND";
    case HttpStatus.CONFLICT:
      return "CONFLICT";
    case HttpStatus.TOO_MANY_REQUESTS:
      return "TOO_MANY_REQUESTS";
    default:
      return "INTERNAL_SERVER_ERROR";
  }
}

export function safeTrpcError(error: unknown): TRPCError {
  if (error instanceof TRPCError) return error;
  if (error instanceof ApiHttpException) {
    return new TRPCError({
      code: codeForStatus(error.getStatus()),
      message: error.safeResponse.message,
    });
  }
  if (error instanceof AuthorizationDeniedError) {
    return new TRPCError({
      code: codeForStatus(error.decision.httpStatus),
      message: error.decision.safeMessage,
    });
  }
  return new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message: "The request could not be completed.",
  });
}

export async function executeTrpc<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error: unknown) {
    throw safeTrpcError(error);
  }
}
