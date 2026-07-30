import { type CanActivate, type ExecutionContext, HttpStatus, Injectable } from "@nestjs/common";

import { ApiHttpException } from "../common/errors/api-http.exception";

import { AuthService } from "./auth.service";

import type { Request } from "express";

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const principal = await this.auth.authenticate(context.switchToHttp().getRequest<Request>());
    if (principal === null) {
      throw new ApiHttpException(HttpStatus.UNAUTHORIZED, {
        code: "UNAUTHENTICATED",
        message: "Authentication is required.",
      });
    }
    return true;
  }
}
