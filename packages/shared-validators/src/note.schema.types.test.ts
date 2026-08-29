/*
 * Compile-time parity between the note enums declared twice.
 *
 * Seven unions live as hand-written TypeScript in `@notted/shared-types` and as
 * `z.enum` literals here, with no link between them. Add `"archived"` to
 * `noteListViewSchema` and forget `NoteListView`, and the API accepts the value
 * while the typed client's exhaustive `switch` has no arm for it — nothing fails
 * until runtime, in the client.
 *
 * These are `expectTypeOf` assertions, so `pnpm type-check` is what actually
 * enforces them; the vitest run only proves the file loads. Both directions
 * matter, which is why this uses `toEqualTypeOf` rather than assignability: a
 * member added to either side alone is an error.
 *
 * The audit filed this as six enums. There are seven —
 * `NoteShareMutationPermission` was missed, and it is the one that decides which
 * permissions a share may be *set* to.
 */

import { describe, expectTypeOf, it } from "vitest";

import {
  noteListViewSchema,
  noteLocationSchema,
  noteShareMutationPermissionSchema,
  noteSharePermissionSchema,
  noteSortFieldSchema,
  noteTypeSchema,
  pageSizeSchema,
} from "./note.schema";

import type {
  NoteListView,
  NoteLocation,
  NoteSharePermission,
  NoteShareMutationPermission,
  NoteSortField,
  NoteType,
  PageSize,
} from "@notted/shared-types";
import type { z } from "zod";

describe("note enum parity across the two packages", () => {
  it("keeps every note union identical to its z.enum", () => {
    expectTypeOf<z.infer<typeof noteTypeSchema>>().toEqualTypeOf<NoteType>();
    expectTypeOf<z.infer<typeof pageSizeSchema>>().toEqualTypeOf<PageSize>();
    expectTypeOf<z.infer<typeof noteLocationSchema>>().toEqualTypeOf<NoteLocation>();
    expectTypeOf<z.infer<typeof noteListViewSchema>>().toEqualTypeOf<NoteListView>();
    expectTypeOf<z.infer<typeof noteSortFieldSchema>>().toEqualTypeOf<NoteSortField>();
    expectTypeOf<z.infer<typeof noteSharePermissionSchema>>().toEqualTypeOf<NoteSharePermission>();
    expectTypeOf<
      z.infer<typeof noteShareMutationPermissionSchema>
    >().toEqualTypeOf<NoteShareMutationPermission>();
  });
});
