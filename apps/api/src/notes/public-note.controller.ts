// Part 82 — the one route in this codebase with NO `@RequireAuthorization`.
// That is deliberate, not an oversight: this endpoint IS the public link
// feature. `RateLimitGuard` (global) still applies at the unauthenticated
// per-IP tier automatically, since no session is attached to the request.

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
