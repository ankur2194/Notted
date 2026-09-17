// The one route in this codebase with NO `@RequireAuthorization`. That is
// deliberate, not an oversight: this endpoint IS the public link feature.
// `RateLimitGuard` (global) still applies at the unauthenticated per-IP tier,
// since no session is attached to the request — but "per IP" is only as good
// as the IP it sees. `apps/web/src/lib/notes/server-public-note.ts` now
// forwards the visitor's address via `X-Forwarded-For` on its server-side
// fetch (instead of every anonymous view arriving from the Next.js server's
// one IP), and `RequestContextMiddleware`'s `request.ip` honours that only if
// `TRUST_PROXY_HOPS` (`app.config.ts`) is set to match the real number of
// proxy hops in front of this service in the deployed environment. That hop
// count is infrastructure this repo does not fix or verify — get it wrong and
// the per-IP tier silently degrades back to one shared bucket.

import { Controller, Get, Req } from "@nestjs/common";

import { ApiHttpException } from "../common/errors/api-http.exception";

import { PublicNoteService } from "./public-note.service";

import type { PublicNote } from "@notted/shared-types";
import type { Request } from "express";

@Controller("public/notes")
export class PublicNoteController {
  constructor(private readonly publicNote: PublicNoteService) {}

  @Get(":token")
  async get(@Req() request: Request): Promise<PublicNote> {
    // Reads the raw route param directly rather than through a Zod-parsed
    // helper: an out-of-pattern token is exactly what
    // `PublicNoteService.resolve` already short-circuits to `null` via
    // `PUBLIC_LINK_TOKEN_PATTERN`, so a second validation layer here would
    // only duplicate that check.
    const note = await this.publicNote.resolve(String(request.params.token ?? ""));
    if (note === null) {
      throw new ApiHttpException(404, {
        code: "NOT_FOUND",
        message: "The requested resource was not found.",
      });
    }
    return note;
  }
}
