import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from "@nestjs/common";
import { defer, type Observable } from "rxjs";

import { ApiHttpException } from "../common/errors/api-http.exception";

import { AuthorizationAdaptersService } from "./authorization-adapters.service";
import { getAuthorizedOperation } from "./authorization-http.context";

import type { Request } from "express";

@Injectable()
export class AuthorizationHttpInterceptor implements NestInterceptor {
  constructor(private readonly adapters: AuthorizationAdaptersService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request>();
    const operation = getAuthorizedOperation(request);
    if (operation === undefined) {
      throw new ApiHttpException(403, {
        code: "FORBIDDEN",
        message: "You are not allowed to do that.",
      });
    }
    // `defer` establishes ALS at subscription time, covering the complete
    // controller/service/repository Observable rather than only its creation.
    return defer(() => this.adapters.run(operation, () => next.handle()));
  }
}
