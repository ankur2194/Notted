import { HttpException } from "@nestjs/common";

import type { SafeHttpExceptionResponse } from "./api-error";

export class ApiHttpException extends HttpException {
  readonly safeResponse: SafeHttpExceptionResponse;

  constructor(status: number, response: SafeHttpExceptionResponse) {
    super(response, status);
    this.safeResponse = response;
  }
}
