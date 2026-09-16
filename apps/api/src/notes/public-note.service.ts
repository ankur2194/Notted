// Part 82 — the one unauthenticated read in this codebase that returns note
// content. Deliberately does NOT use `TenantContextService`/`whereWorkspace`:
// an anonymous visitor has no session and therefore no tenant context to
// read. Tenancy is proved by the row data itself (`note_public_links`'s
// composite FK already guarantees `workspace_id` matches the note's own),
// not by an ambient context. See `VerifiedHostsService` for the same
// pattern applied to hostname routing.

import { Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";

import { AUTH_CONFIG, type AuthConfig } from "../config/auth.config";
import { DatabaseService } from "../database/database.service";
import { notePublicLinks, notes } from "../database/schema";

import { hashPublicLinkToken, PUBLIC_LINK_TOKEN_PATTERN } from "./note-public-link-token";

import type { NoteDocument, PublicNote } from "@notted/shared-types";

@Injectable()
export class PublicNoteService {
  constructor(
    private readonly database: DatabaseService,
    @Inject(AUTH_CONFIG) private readonly authConfig: AuthConfig,
  ) {}

  async resolve(rawToken: string): Promise<PublicNote | null> {
    if (!PUBLIC_LINK_TOKEN_PATTERN.test(rawToken)) return null;
    const tokenHash = hashPublicLinkToken(rawToken, this.authConfig.secret);
    const [row] = await this.database.db
      .select({
        title: notes.title,
        content: notes.content,
        pageSize: notes.pageSize,
        updatedAt: notes.updatedAt,
        isDeleted: notes.isDeleted,
      })
      .from(notePublicLinks)
      .innerJoin(notes, eq(notes.id, notePublicLinks.noteId))
      .where(eq(notePublicLinks.tokenHash, tokenHash))
      .limit(1);
    if (row === undefined || row.isDeleted) return null;
    return Object.freeze({
      title: row.title,
      content: row.content as NoteDocument,
      // `notes.page_size` is a plain `varchar`, not a narrowed literal union
      // (same reason `NotesService.toSummary` casts it this way rather than
      // `as PageSize`).
      pageSize: row.pageSize === "letter" ? "letter" : "a4",
      updatedAt: row.updatedAt.toISOString(),
    });
  }
}
