import { Controller, Get, HttpStatus, Query, Req, UseGuards } from "@nestjs/common";
import { shellBootstrapQuerySchema } from "@notted/shared-validators";

import { getAuthPrincipal } from "../auth/auth-principal";
import { AuthGuard } from "../auth/auth.guard";
import { ApiHttpException } from "../common/errors/api-http.exception";

import { ShellService } from "./shell.service";

import type { ShellBootstrap } from "@notted/shared-types";
import type { Request } from "express";

@Controller("shell")
export class ShellController {
  constructor(private readonly shell: ShellService) {}

  @Get("bootstrap")
  @UseGuards(AuthGuard)
  bootstrap(@Req() request: Request, @Query() rawQuery: unknown): Promise<ShellBootstrap> {
    const query = shellBootstrapQuerySchema.safeParse(rawQuery);
    if (!query.success) {
      throw new ApiHttpException(HttpStatus.BAD_REQUEST, {
        code: "VALIDATION_ERROR",
        message: "The request is invalid.",
      });
    }
    const principal = getAuthPrincipal(request);
    if (principal === undefined) throw new Error("Auth guard did not attach a principal");
    return this.shell.bootstrap(principal, query.data.workspaceId);
  }
}
