import { Module } from "@nestjs/common";

import { OpenApiController } from "./openapi.controller";

/** Part 65. Publishes the generated OpenAPI document for `/api/v1`. */
@Module({ controllers: [OpenApiController] })
export class OpenApiModule {}
