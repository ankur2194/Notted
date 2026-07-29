# Part 16 — Implement Tags, Attachments, Comments, and Note Versions

## Status

- **State:** Complete
- **Completed on:** 2026-07-29
- **Implemented by:** `backend-platform-engineer` (subagent)
- **Plan reference:** `Plan.md`, Part 16
- **Related records:**
  `part-15-projects-notes-hierarchy-ordering.md`;
  `docs/decisions/0004-collaborative-document-authority.md`;
  `docs/decisions/0005-private-object-storage.md`;
  `docs/decisions/0007-schema-gaps-and-safe-defaults.md`

## Objective

Introduce the four content-adjacent schema families that hang off the Part 15
`notes` entity: workspace-scoped tags and their note/tag junction, file-upload
attachment metadata with processing state and image variants, threaded note
comments with selection anchors for inline commenting, and note version
snapshot rows for history/restore. This is purely structural schema work: no
NestJS services, transports, jobs, or auth wiring are introduced. Per Plan
Part 16 the schema adds unique workspace tag names, composite primary keys for
the junction rows, comment selection anchors, attachment processing status and
variants, and version metadata/title so a restore reproduces the whole note.

## Implemented Work

- Added `apps/api/src/database/schema/tags.ts` defining:
  - `tags` table: `id`, `workspace_id` (→ `workspaces.id` CASCADE, notNull),
    `name` (varchar 50, notNull), `color` (varchar 7, default `#6b7280`),
    `created_at` (timestamptz defaultNow, notNull). Indexes:
    `tags_workspace_name_unique` (UNIQUE `(workspace_id, name)` — Plan Part 16
    "unique workspace tag names"; the same name may exist in another
    workspace), `tags_workspace_id_idx` (workspace list lookup). NO
    `created_by_id` column: tags are workspace-level resources, not personal
    authored entities, per the brief/task column list.
  - `note_tags` junction table: `note_id` (→ `notes.id` CASCADE, notNull),
    `tag_id` (→ `tags.id` CASCADE, notNull). COMPOSITE PRIMARY KEY on
    `(note_id, tag_id)` via `primaryKey({ columns: [t.noteId, t.tagId] })`
    (Plan Part 16 "composite primary keys for junction rows"); NO synthetic
    `id` PK. The composite PK index also enforces `(note, tag)` uniqueness so a
    duplicate assignment is rejected with SQLSTATE 23505 — no separate unique
    index. Index `note_tags_tag_id_idx` on `tag_id` serves the "notes with tag
    X" reverse lookup (the PK's leftmost `note_id` prefix already covers the
    forward "tags on note X" lookup).
  - Forward relations: `tagsRelations` (`workspace`, `noteTags` many) and
    `noteTagsRelations` (`note`, `tag`).
- Added `apps/api/src/database/schema/attachments.ts` defining:
  - `attachmentStatusEnum` = `pgEnum("attachment_status", ["pending",
"processing", "ready", "failed"])` — the cross-system lifecycle from ADR 0005.
  - `attachmentMediaTypeEnum` = `pgEnum("attachment_media_type", ["image",
"file"])` — optional category (documented choice; see Important Decisions).
  - `attachments` table: `id`; `note_id` (→ `notes.id` CASCADE, notNull);
    `workspace_id` (→ `workspaces.id` CASCADE, notNull — denormalized from
    notes for direct quota/cleanup queries); `original_name` and `filename`
    (varchar 255, notNull — sanitized display metadata, NOT the object key);
    `mime_type` (varchar 100, notNull); `size_bytes` (bigint `{ mode: "number"
}`, notNull); `storage_key` (text, notNull — opaque server-generated key
    per ADR 0005); `media_type` (default `file`, notNull); `processing_status`
    (default `pending`, notNull); `processing_error` (text, nullable);
    `variants` (jsonb default `{}` — variant-key references + dimensions);
    `width`/`height` (integer, nullable — primary image dimensions);
    `created_by_id` (→ `users.id` RESTRICT, notNull); `created_at` (timestamptz
    defaultNow, notNull). Indexes: `attachments_note_id_idx`, `
attachments_workspace_id_idx`, `attachments_workspace_status_idx` (orphan/
    cleanup lookup by status), `attachments_created_by_id_idx`.
  - `attachmentsRelations` (`note`, `workspace`, `createdBy` with
    disambiguating `relationName`).
- Added `apps/api/src/database/schema/comments.ts` defining:
  - `comments` table: `id`; `note_id` (→ `notes.id` CASCADE, notNull);
    `parent_id` (→ `comments.id` self-ref CASCADE, nullable — threading);
    `content` (text, notNull — markdown/plain, NOT TipTap JSON); `created_by_id`
    (→ `users.id` RESTRICT, notNull); `is_resolved` (bool default false,
    notNull); `resolved_at` (timestamptz, nullable); `resolved_by_id`
    (→ `users.id` SET NULL, nullable); `anchor_key` (text, nullable),
    `anchor_from`/`anchor_to` (integer, nullable — offset hints),
    `anchor_metadata` (jsonb default `{}` — remapping hints) — all anchor
    columns nullable so a comment can be a whole-note comment without a
    selection; `created_at`/`updated_at` (timestamptz defaultNow, notNull).
    Indexes: `comments_note_id_idx`, `comments_note_resolved_idx` on
    `(note_id, is_resolved)`, `comments_parent_id_idx` (thread lookup),
    `comments_created_by_id_idx`.
  - `commentsRelations` (`note`, `parent`/`children` self with `relationName:
"comments_parent"`, `createdBy` and `resolvedBy` to `users` with
    disambiguating `relationName`s).
- Added `apps/api/src/database/schema/note-versions.ts` defining:
  - `note_versions` table: `id`; `note_id` (→ `notes.id` CASCADE, notNull);
    `version` (integer, notNull — the `notes.version` value this snapshot
    captures, NOT an independent counter); `title` (varchar 500, notNull —
    captured at snapshot time so restore reproduces the whole note); `content`
    (jsonb, notNull — TipTap JSON projection snapshot per ADR 0004);
    `content_plain` (text default `""`); `created_by_id` (→ `users.id`
    RESTRICT, notNull); `created_at` (timestamptz defaultNow, notNull).
    Indexes: `note_versions_note_created_idx` on `(note_id, created_at)`
    (ordered newest-first retrieval; btree supports reverse DESC scan),
    `note_versions_note_version_unique` UNIQUE on `(note_id, version)` (one
    snapshot per note/version and restore lookup), `note_versions_created_by_id_idx`.
  - `noteVersionsRelations` (`note`, `createdBy` with disambiguating
    `relationName`).
- Appended every Part 16 table, relation, and enum to the aggregate `schema`
  object in `apps/api/src/database/schema/index.ts` and re-exported each by
  name. The existing Part 12/13/14/15 entries and the `Schema = typeof schema`
  type are preserved; a `// Part 16 — …` comment marks the new block.
- Generated migration `apps/api/src/database/migrations/0004_outgoing_catseye.sql`
  via `pnpm db:generate`, plus its snapshot (`meta/0004_snapshot.json`) and a
  new journal entry (`idx: 4`, `tag: 0004_outgoing_catseye`) in
  `meta/_journal.json` (the journal previously ended at `idx: 3`). Prior
  migrations (`0000_enable_extensions.sql`, `0001_volatile_wiccan.sql`,
  `0002_minor_mad_thinker.sql`, `0003_cute_maria_hill.sql`), their snapshots,
  and the pre-Part-16 journal entries were NOT edited.
- Reviewed the generated SQL (see Verification Evidence): enums, FK
  cascade/restrict/set-null, the `note_tags` composite PK
  (`note_tags_note_id_tag_id_pk` PRIMARY KEY("note_id","tag_id")), the
  `tags_workspace_name_unique` unique index, and all lookup indexes match the
  schema. No review-time reorder was needed: unlike Part 15, this part has no
  composite FOREIGN KEY whose referenced unique constraint must precede the
  `ADD CONSTRAINT` (the only composite is the `note_tags` PRIMARY KEY, declared
  inline in `CREATE TABLE`).
- Added `apps/api/test/tags-attachments-comments-versions-schema.test.ts` with:
  - A no-database unit suite: the barrel exposes the five new tables, five
    relation objects, and two enums; the enums have the expected values;
    `note_tags` has a composite PK `(note_id, tag_id)` with NO synthetic `id`
    and neither column is a single-column PK; `tags` carries the unique
    `(workspace_id, name)` index; all Part 16 columns exist with correct
    nullability (including the nullable comment anchor columns and the
    notNull-with-safe-defaults attachment processing-state/media-type); the
    Plan Part 16 lookup/cleanup indexes exist with correct uniqueness; and
    every foreign key has the intended `onDelete` (cascade on note/workspace/
    self/tag, restrict on all `created_by_id`, set null on `resolved_by_id`).
  - A `DATABASE_URL`-gated live suite (mirroring
    `notes-projects-schema.test.ts` and `database.migration.test.ts`) that
    applies migrations and asserts: the five tables and two enums exist;
    (a) tag assignment via `note_tags` works, a duplicate workspace tag name is
    rejected (23505), a duplicate `(note_id, tag_id)` assignment is rejected by
    the composite PK (23505), the "notes with tag X" lookup returns the
    assigned note, and deleting a tag cascades to its assignments;
    (b) threaded comment cascade — deleting a parent comment removes its
    replies via the self-FK CASCADE, and deleting the note removes all its
    comments via the `note_id` FK CASCADE; (c) the attachment cleanup-by-status
    lookup returns the expected pending/ready/failed breakdown within a
    workspace; (d) ordered version retrieval returns versions newest-first via
    `created_at DESC` and `version DESC`, and deleting the note cascades to its
    version snapshots. Each live test creates deterministic unique fixtures and
    cleans them up via the workspace cascade in a finally block. Uses
    `isDatabaseReachable` + `describe.skipIf(!HAS_DATABASE_URL)` + `skip()`.

## Important Decisions

- **`note_tags` uses a composite PRIMARY KEY `(note_id, tag_id)` with no
  synthetic `id`.** This is the Plan Part 16 "composite primary keys for
  junction rows" requirement. The composite PK index also enforces pair
  uniqueness, so a duplicate assignment is rejected with 23505 — no separate
  unique index is needed. An additional single-column index on `tag_id` serves
  the "notes with tag X" reverse lookup; the PK's leftmost `note_id` prefix
  already covers the forward "tags on note X" lookup, so no separate `note_id`
  index is added.
- **Tags carry NO `created_by_id`.** The brief's `tags` table and the Part 16
  task column list both omit a creator audit. Tags are workspace-level label
  resources, not personal authored entities like notes/projects/comments.
  Reusing the Part 14/15 RESTRICT-on-`created_by_id` audit convention would
  have required inventing a column the brief does not specify; omitted to stay
  minimal and within scope. The general "attachments/tags createdBy → users"
  hint in the task brief is satisfied by attachments (which does have
  `created_by_id` RESTRICT).
- **Cross-workspace tag assignment is service-enforced.** `tags.workspace_id`
  scopes a tag to its workspace, but `note_tags` does NOT carry `workspace_id`
  itself — it reaches the workspace transitively via `note_id →
notes.workspace_id` and `tag_id → tags.workspace_id`. A cross-workspace
  assignment (a tag from workspace A applied to a note in workspace B) is a
  two-hop invariant enforced by the service (Part 24/31) in the assign
  transaction; it is NOT expressible as a single-column DB constraint without
  denormalizing `workspace_id` onto the junction, which the brief deliberately
  omits. This matches the Part 15 `note_shares`/`project_access` precedent.
- **Attachment byte/key split (ADR 0005): PostgreSQL is authoritative, MinIO
  stores bytes only, object keys are opaque/server-generated.** `storage_key`
  is NEVER the raw user filename and NEVER an authorization boundary.
  `original_name`/`filename` are sanitized DISPLAY metadata (Content-
  Disposition). Possession of an object key is NEVER sufficient for access —
  authorization always re-checks the database record within its workspace.
  Deletion is ASYNCHRONOUS: the service marks the DB record unavailable and
  records deletion intent transactionally, then performs idempotent object
  deletion after commit. The DB row is the durable record of "what should
  exist"; the object store follows. This is fully documented in the
  `attachments.ts` module comment.
- **Attachment processing-state model maps to the ADR 0005 cross-system
  workflow.** `processing_status` `pending → processing → ready`, with
  `failed` as the terminal error state. `processing_error` stores an
  operator/user-facing error (no raw bytes, no signed URLs, no secrets). The
  `attachments_workspace_status_idx` on `(workspace_id, processing_status)`
  is the reconciliation/cleanup hot path: pending/failed rows needing object
  cleanup. Quota reservation/commit/release is service logic (Part 45); this
  table only persists the state.
- **Optional `media_type` enum added (documented choice).** The Part 16 task
  brief offered "Optional mediaType enum or category (image vs file) — document
  choice if added." Added `attachment_media_type` `["image", "file"]` with
  default `file` so the processing pipeline (Part 40+) can decide whether to
  generate image variants at all; generic files default to `file` and may
  receive a preview thumbnail out-of-band. Low-risk, two-value enum; improves
  the "attachment processing status/variants" model the Plan calls out.
- **`size_bytes` uses `bigint` with `mode: "number"`** (matches the Part 14
  `workspaces.storage_limit_bytes` convention). The DB column is bigint so
  files larger than 2 GiB are representable; the JS layer reads a Number,
  which is safe because per-workspace upload limits (Part 45) are far below
  `Number.MAX_SAFE_INTEGER` (~9 PiB). Chosen over the brief's literal
  `integer` because the brief/table column type is `integer` but ADR 0005
  emphasizes byte limits and quota accounting for potentially large uploads;
  `bigint` is the safer, more accurate choice and the task brief explicitly
  permits "bigint/integer".
- **Comment anchor contract (ADR 0004): the DB persists the anchor payload;
  remapping-through-edits is editor/service logic (Part 60).** `anchor_key`
  (ProseMirror/relative-position key) + `anchor_from`/`anchor_to` (offset
  hints) + `anchor_metadata` (jsonb remapping hints) are ALL NULLABLE so a
  comment can be a whole-note comment without a selection. When the document
  changes, the editor reconciles anchors via the Yjs relative-position
  machinery and updates these columns or marks the comment orphaned. This
  table does NOT validate anchor consistency with the current document.
  Comments are PostgreSQL entities (NOT embedded as the sole copy in Yjs), so
  they survive CRDT merges/compaction independently of the document binary.
- **Comment `content` is TEXT (markdown/plain), NOT TipTap JSON.** A
  lightweight text format is deliberate: comment bodies are short and primarily
  textual; rendering them through the full document schema is overkill. If rich
  comment formatting is needed later, a dedicated mini-schema (or TipTap JSON)
  can be introduced via migration; the column TYPE is the contract.
- **Threaded cascade is implemented by two FKs.** `comments.note_id` CASCADE
  removes a note's comments; `comments.parent_id` self-CASCADE removes a
  parent comment's replies. Both are verified by the live test. There is no
  separate "thread" table — a top-level comment has `parent_id NULL`.
- **`note_versions.version` is a SNAPSHOT of `notes.version`, NOT an
  independent counter.** `notes.version` (Part 15) is the optimistic-concurrency
  integer incremented on every content update; `note_versions.version` is the
  snapshot of that value at capture time. The two MUST NOT be confused. The
  snapshot cadence ("when to write a row") is owned by the projection/history
  pipeline (Part 55); this table only persists the snapshot.
- **`note_versions.title` is captured at snapshot time so restore reproduces
  the whole note.** Per Plan Part 16 "version metadata/title if restoration
  should reproduce the whole note". `title` (varchar 500, notNull) + `content`
  (jsonb, notNull) + `content_plain` mean restoring a row reproduces the full
  note state without joining other tables. The Yjs binary snapshot is a
  separate concern (Part 39/55); this row is the deterministic projection
  snapshot.
- **All Part 16 `created_by_id` columns use `ON DELETE RESTRICT`** (attachments,
  comments, note_versions). Matches the Part 14/15 convention for shared
  tenant entities and audit trails: deleting the creator must not silently drop
  the row or its audit; the service (Part 26) transfers or nullifies before
  account deletion. `comments.resolved_by_id` is nullable and uses SET NULL so
  deleting the resolver preserves the comment and its resolved state (only the
  resolver id is cleared), mirroring `notes.updated_by_id`.
- **Ordered-retrieval indexes are plain btree (no `.desc()` modifier).** A
  btree index on `(note_id, created_at)` supports a reverse scan for "newest
  first", so a per-column `.desc()` is unnecessary and would diverge from the
  Part 15 index style. Both retrieval hot paths (`created_at` for the history
  UI, `version` for restore-by-version) get their own composite index.
- **Forward relations only.** `notesRelations`, `workspacesRelations`, and
  `usersRelations` were intentionally not extended with back-references, to
  keep earlier parts immutable per the handoff rules. Drizzle supports
  one-directional relations.

## Files and Components

| Path                                                              | Purpose                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/api/src/database/schema/tags.ts`                            | `tags`, `note_tags` junction (composite PK, no synthetic id), `tagsRelations`, `noteTagsRelations`. Documents unique workspace tag names, the composite-PK-as-uniqueness contract, and the service-enforced cross-workspace assignment invariant.                                                                                    |
| `apps/api/src/database/schema/attachments.ts`                     | `attachments`, `attachmentStatusEnum`, `attachmentMediaTypeEnum`, `attachmentsRelations`. Documents the ADR 0005 byte/key split, processing-state lifecycle, asynchronous deletion with state transitions, variant model, and the bigint size_bytes choice.                                                                          |
| `apps/api/src/database/schema/comments.ts`                        | `comments` (threaded, with selection anchors), `commentsRelations`. Documents the ADR 0004 anchor contract (DB persists payload; remapping is Part 60), the TEXT-not-TipTap-JSON content choice, and the two-FK threaded cascade.                                                                                                    |
| `apps/api/src/database/schema/note-versions.ts`                   | `note_versions` snapshot rows, `noteVersionsRelations`. Documents the snapshot-vs-`notes.version` distinction, the restore-reproduces-whole-note model, and the retention deferral to Part 19/55.                                                                                                                                    |
| `apps/api/src/database/schema/index.ts`                           | Aggregate `schema` barrel now exposes the Part 16 tables, relations, and enums and re-exports each by name. `Schema = typeof schema` preserved.                                                                                                                                                                                      |
| `apps/api/src/database/migrations/0004_outgoing_catseye.sql`      | Generated forward migration: two enums, five tables, twelve foreign keys (cascade/restrict/set-null), the `note_tags_note_id_tag_id_pk` composite PRIMARY KEY, and fourteen indexes (one unique — `tags_workspace_name_unique`).                                                                                                     |
| `apps/api/src/database/migrations/meta/0004_snapshot.json`        | Generated Drizzle snapshot for migration 0004.                                                                                                                                                                                                                                                                                       |
| `apps/api/src/database/migrations/meta/_journal.json`             | Appended journal entry `idx: 4`, `tag: 0004_outgoing_catseye`.                                                                                                                                                                                                                                                                       |
| `apps/api/src/database/migrations/0007_early_bloodaxe.sql`        | Forward correction adding UNIQUE `(note_id, version)` after dropping the prior non-unique lookup index.                                                                                                                                                                                                                              |
| `apps/api/src/database/migrations/meta/0007_snapshot.json`        | Generated final Phase 3 snapshot containing `note_versions_note_version_unique`.                                                                                                                                                                                                                                                     |
| `apps/api/test/tags-attachments-comments-versions-schema.test.ts` | Unit suite (no DB) + DATABASE_URL-gated live suite asserting tables/enums, the `note_tags` composite PK, `tags` unique constraint, FK cascade behavior, and the four Plan Part 16 verify scenarios (tag assignment + duplicate rejection, threaded comment cascade, attachment cleanup-by-status lookup, ordered version retrieval). |

## Database and Data Changes

Migration `0004_outgoing_catseye.sql` is additive only. It creates two enum
types (`attachment_media_type`, `attachment_status`), five tables
(`attachments`, `comments`, `note_tags`, `note_versions`, `tags`), twelve
foreign keys, one composite PRIMARY KEY (`note_tags_note_id_tag_id_pk` on
`note_tags(note_id, tag_id)`), and fourteen indexes (one unique —
`tags_workspace_name_unique`; thirteen lookup — `attachments_note_id_idx`,
`attachments_workspace_id_idx`, `attachments_workspace_status_idx`,
`attachments_created_by_id_idx`, `comments_note_id_idx`,
`comments_note_resolved_idx`, `comments_parent_id_idx`,
`comments_created_by_id_idx`, `note_tags_tag_id_idx`,
`note_versions_note_created_idx`, `note_versions_note_version_idx`,
`note_versions_created_by_id_idx`, `tags_workspace_id_idx`).
Migration `0007_early_bloodaxe.sql` drops that historical non-unique version
index and creates UNIQUE `note_versions_note_version_unique` on the same pair.
Foreign-key cascade choices: `note_id` CASCADE on attachments/comments/
note_tags/note_versions (note deletion cascades to all dependent rows);
`tags.workspace_id` CASCADE; `attachments.workspace_id` CASCADE;
`comments.parent_id` self-CASCADE (threaded reply cascade); `note_tags.tag_id`
CASCADE (tag deletion cascades to assignments); all `created_by_id` RESTRICT
(attachments, comments, note_versions); `comments.resolved_by_id` SET NULL.
No data, no seed, no destructive statement, no extension change. Defaults use
PostgreSQL built-ins (`gen_random_uuid()`, `now()`, `'{}'::jsonb`, `''`,
enum literals) and require no extension beyond the Part 12 baseline. The
migration is forward-only per project policy; rollback is a separate reviewed
operation. No prior migration, snapshot, or journal entry was edited by hand.

Historical initial-implementation hashes (superseded by forward migration
0007 and the Reviewer #1 source corrections; not current-file hashes):

| File                                                              | SHA-256                                                            |
| ----------------------------------------------------------------- | ------------------------------------------------------------------ |
| `apps/api/src/database/schema/tags.ts`                            | `b153812a841942970479a9203d97bf18b3d273443c8fa8a0c1b546f5dac582b9` |
| `apps/api/src/database/schema/attachments.ts`                     | `2e2f1de32feecd05a4c48564335508275cd94f07ab51651771c5c4f62c592323` |
| `apps/api/src/database/schema/comments.ts`                        | `69040b0f3631b998882299cfe8badcafe550c94aaa45fe1830a49ea3b9823f17` |
| `apps/api/src/database/schema/note-versions.ts`                   | `9238ebf4a30e239ab02570718e0803422e8e8aab47dbee39e17c87729c7e3d85` |
| `apps/api/src/database/schema/index.ts`                           | `8ed79b24f44b83b42b519884ffea7a99e4b023904b0740c8c0547ba0e08efff3` |
| `apps/api/src/database/migrations/0004_outgoing_catseye.sql`      | `93f273c313fc204047a58af6db0b02e0d07a192693766c20e5d1bc6684aee81f` |
| `apps/api/src/database/migrations/meta/0004_snapshot.json`        | `74de2a59d979240c678ea96a6b2af300175ea0f4951a8d1b4a006666b33c1bb7` |
| `apps/api/src/database/migrations/meta/_journal.json`             | `651f8ce684a0c163b51123c2cf3ac4c055839e0002aefa4822efbdc814d3fd3d` |
| `apps/api/test/tags-attachments-comments-versions-schema.test.ts` | `e289b575eb0a442a69045401c939dac7f93d6bb6518a74ff505ca6572ba23305` |

## API, Configuration, and Operational Changes

None. No routes, contracts, queues, environment variables, ports, feature
flags, or deployment steps were added. Defaults are safe: there is no
anonymous or unauthenticated access, no tag/attachment/comment/version is
auto-created, and no transport reads these tables yet. The schema is purely
structural; Parts 21 (auth), 24 (centralized authorization), 40–45
(attachment upload/processing pipeline), 55 (history/restore UI), and 60
(comment anchor remapping) wire behavior on top.

## Security and Tenant-Isolation Notes

- **`tags.workspace_id` scopes tags to their workspace**; the unique
  constraint is `(workspace_id, name)`, so name collisions across workspaces
  are impossible and intra-workspace name uniqueness is enforced at the DB
  layer (verified by the live duplicate-name test).
- **Cross-workspace tag assignment is service-enforced (Part 24/31).** The
  `note_tags` junction does not carry `workspace_id`; a tag from workspace A
  applied to a note in workspace B is a two-hop invariant the service rejects
  in the assign transaction. Same precedent as Part 15 `note_shares`/
  `project_access`. A guessed tag UUID does not grant cross-workspace access
  because the service checks the note's workspace matches the tag's workspace.
- **Attachment object keys are opaque/server-generated and NEVER an
  authorization boundary (ADR 0005).** Possession of a `storage_key` is never
  sufficient for access; authorization re-checks the database record within
  its workspace before issuing storage access. Downloads use authorized
  streaming or short-lived signed URLs; signed URLs are bearer secrets and are
  excluded from logs/persisted content. No anonymous object URL is persisted.
- **`attachments.workspace_id` is denormalized for direct quota/cleanup
  queries** but its consistency with `notes.workspace_id` is enforced at
  insert by the service (same workspace as the note); it is not a separate
  tenant-escape vector because the service scopes inserts.
- **Comment anchors are document positions, not authorization data.** They
  carry no access semantics and never broaden note access. A comment's
  visibility is governed entirely by the note's authorization (Part 24/55).
- **All `created_by_id` columns are `ON DELETE RESTRICT`** to prevent silent
  loss of audit trails; the service (Part 26) reassigns or nullifies before
  account deletion.
- **No public link sharing, no anonymous read.** Comments/attachments/versions
  are reachable only through their note, which inherits workspace/project/
  share authorization (Part 15/24).
- **No secrets, connection strings, tokens, cookies, or signed URLs appear**
  in the schema, migration, tests, or this record. `processing_error` is an
  operator-facing message, not credentials; `variants`/`anchor_metadata`/
  `content`/`content_plain` are user document/metadata, not credentials.

## Verification Evidence

Final verification completed on 2026-07-29.

| Check                   | Result | Notes                                                                                                                              |
| ----------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| Migration chain         | Pass   | `0004_outgoing_catseye.sql` and repair migration `0007_early_bloodaxe.sql` applied; Drizzle consistency passed.                    |
| Focused live suite      | Pass   | Tag uniqueness/assignment, threaded cascades, attachment cleanup lookup, version ordering, and duplicate-version rejection passed. |
| Upgrade preflight       | Pass   | Duplicate `(note_id, version)` rows abort 0007 atomically before index changes; documented remediation then allows upgrade.        |
| Repository quality gate | Pass   | Sequential format, lint, type-check, tests, and build passed.                                                                      |

## Known Limitations and Follow-up Work

- **Cross-workspace tag assignment is service-enforced (Part 24/31).** The
  service must verify the tag and note belong to the same workspace inside
  the assign transaction; the junction has no `workspace_id` column.
- **Attachment upload/processing pipeline is Part 40–45.** This part models
  the state machine and variant metadata only. Quota reservation/commit/
  release, MIME sniffing, byte limits, signed URL issuance, idempotent object
  cleanup, and reconciliation of orphaned objects are service/adapter logic.
  The DB row is the durable record; object deletion is asynchronous with
  explicit state transitions (ADR 0005).
- **Comment anchor remapping-through-edits is Part 60.** The DB persists the
  anchor payload; reconciling anchors after document edits (via Yjs relative
  positions) and marking comments orphaned when their selection disappears is
  editor/service logic.
- **Comment resolution workflow is Part 55.** `is_resolved`/`resolved_at`/
  `resolved_by_id` are persisted; the policy for who may resolve/reopen is
  service logic (Part 24/55).
- **Version snapshot cadence and retention are Part 55 / Part 19.** This table
  stores the rows; WHEN to snapshot is the history pipeline (Part 55). The
  free-tier 30-day / pro-tier unlimited retention PURGE is NOT implemented
  here — it is a Part 19 (retention policies) scheduled job deleting rows
  older than the workspace's plan retention window.
- **Version restore is Part 55.** `title` + `content` + `content_plain` are
  captured so restore reproduces the whole note, but the restore transaction
  (replacing the note's content, bumping `notes.version`, writing a new
  snapshot of the pre-restore state) is service logic.
- **No standalone tasks table yet (Part 17).** `note_versions.version` is
  distinct from any future task versioning; Part 17 will reference these
  tables where needed.
- **`tags.color` and `attachments.media_type` validation is service-side.**
  The schema only constrains length / provides the enum; hex-color shape and
  media-type assignment are validated by the upload/tag service (Part 40+).
- **`note_versions` Yjs binary snapshot is Part 39/55.** This row is the
  deterministic TipTap JSON projection snapshot; the Yjs binary update/
  snapshot is a separate persisted entity.

## Handoff Notes

- Never edit prior migrations `0000_enable_extensions.sql`,
  `0001_volatile_wiccan.sql`, `0002_minor_mad_thinker.sql`,
  `0003_cute_maria_hill.sql`, their snapshots, or the pre-Part-16 journal
  entries. Forward-only corrections use a new migration.
- Migration `0004_outgoing_catseye.sql` and its snapshot are now immutable;
  any later tag/attachment/comment/version schema change must use a new
  generated forward migration and update the schema barrel.
- Later schema parts import `tags`, `noteTags`, `attachments`, `comments`,
  `noteVersions` from the barrel (or via their modules). Part 17 (standalone
  tasks) may reference tags via `note_tags` patterns or add its own tag links.
- The RESTRICT constraint on `attachments.created_by_id`,
  `comments.created_by_id`, and `note_versions.created_by_id` means any
  Part 21/26 user-deletion path must handle creators of attachments,
  comments, and version snapshots (transfer or reassign before account
  deletion), alongside the Part 15 creators.
- `attachments.size_bytes` is `bigint { mode: "number" }`; service code reads
  it as a Number. Values stay within `Number.MAX_SAFE_INTEGER` because upload
  limits (Part 45) are far below ~9 PiB, but do not store arbitrary `bigint`
  values via this column without reconsidering precision.
- `note_tags` has NO `id` column and NO `created_at`; any code expecting a
  synthetic row id must use the composite `(note_id, tag_id)` key instead.
- The `comments.parent_id` self-CASCADE means deleting a parent comment
  destroys its reply subtree. If "soft delete a thread" is later required, a
  soft-delete column must be added in a later part; today the cascade is hard.
- When running the live suite locally, ensure `DATABASE_URL` points at a
  disposable dev PostgreSQL (the dev compose stack from Part 9). The live
  suite applies migrations and creates/cleans up its own deterministic
  fixtures via the workspace cascade, but run it against a fresh database or
  after `infra:reset:dev` for a clean state.

## Revision History

| Date       | Author                      | Change                                                                                                                                                                                                                                                                                                                                              |
| ---------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-07-28 | `backend-platform-engineer` | Initial Part 16 record: added tags + note_tags (composite PK), attachments (processing state + variants, ADR 0005), comments (threaded + selection anchors, ADR 0004), note_versions (snapshot rows) schema, generated migration `0004_outgoing_catseye.sql`, and unit + live test suites. Status left `In progress` pending reviewer verification. |
| 2026-07-29 | `backend-platform-engineer` | Reviewer #1 fix pass: migration `0007_early_bloodaxe.sql` replaces the non-unique note/version lookup with UNIQUE `note_versions_note_version_unique`; shape and live duplicate-rejection coverage were added. Verification remains pending Reviewer #2.                                                                                            |
| 2026-07-29 | Lead                        | Added duplicate-data migration preflight, completed live metadata/cascade/version checks, and marked Part 16 Complete.                                                                                                                                                                                                                              |
