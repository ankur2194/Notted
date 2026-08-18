import { Controller, Get } from "@nestjs/common";

import { buildOpenApiDocument, type OpenApiDocument } from "./openapi.builder";

/**
 * Serves the OpenAPI document for the public `/api/v1` REST surface.
 *
 * The document is built from live Nest route metadata rather than read from a
 * file, so it cannot drift from the code and no artifact has to ship in the
 * container image. `docs/openapi.json` is the same bytes, committed for review.
 *
 * The route is deliberately public and read-only: it carries no
 * `@RequireAuthorization`, exactly like `ApiController` and the health probes,
 * and it stays under the normal rate limit. The Part 65 default-deny guard
 * therefore rejects API-key requests here, which is intended — an integration
 * reads the spec unauthenticated, it does not need to spend a key on it.
 */
@Controller()
export class OpenApiController {
  private document: OpenApiDocument | undefined;

  @Get("openapi.json")
  read(): OpenApiDocument {
    // Memoized: the document is a pure function of the compiled code.
    this.document ??= buildOpenApiDocument();
    return this.document;
  }
}
