import { Controller, Get, Req } from "@nestjs/common";
import { APP_NAME, type ApiSuccess } from "@notted/shared-types";

import { getRequestId } from "./common/request/request-context";

import type { Request } from "express";

interface ApiRootResponse {
  readonly name: string;
  readonly version: "v1";
  readonly status: "ok";
}

@Controller()
export class ApiController {
  @Get()
  root(@Req() request: Request): ApiSuccess<ApiRootResponse> {
    return {
      success: true,
      data: {
        name: `${APP_NAME} API`,
        version: "v1",
        status: "ok",
      },
      requestId: getRequestId(request) ?? "unavailable",
    };
  }
}
