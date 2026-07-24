import type { Request } from "express";

const REQUEST_ID = Symbol("notted.requestId");

type RequestWithContext = Request & {
  [REQUEST_ID]?: string;
};

export function getRequestId(request: Request): string | undefined {
  return (request as RequestWithContext)[REQUEST_ID];
}

export function setRequestId(request: Request, requestId: string): void {
  (request as RequestWithContext)[REQUEST_ID] = requestId;
}
