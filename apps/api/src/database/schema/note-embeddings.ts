// Part 18: note embeddings for semantic search (pgvector).
//
// Per Plan Part 18: "Create note embeddings ...". Per Notted.md "Semantic
// Search (pgvector)": embeddings are generated on note create/update by a
// background job (Part 53) and power natural-language similarity queries
// ranked by cosine distance (`<=>`).
//
// pgvector is enabled by the Part 12 baseline migration `0000_enable_extensions`
// (`create extension if not exists vector`). The Drizzle `vector` column helper
// is built into `drizzle-orm/pg-core` (re-exported from
// `pg-core/columns/vector_extension/vector`); no separate npm package is
// required, and the `vector` extension is NOT re-enabled here.
//
// DESIGN: ONE row per note (UNIQUE `note_id`). This is sufficient for the
// initial semantic-search surface where each note has a single current
// embedding derived from its title + extracted plain text. A multi-embedding /
// chunked design (one vector per block or per chunk, plus per-field vectors)
// is deferred to Part 53; the UNIQUE constraint here gives a clean single-row
// upsert path (`on conflict (note_id) do update`) for the indexer until then.
//
// `model`, `dimensions`, and `content_hash` support reindex correctness:
// - `model` records which embedding model produced the vector so the indexer
//   (Part 53) can detect a model change and recompute the whole workspace.
// - `dimensions` mirrors the vector's dimensionality so the query path can
//   detect a dimension mismatch BEFORE issuing a `<=>` query (which errors at
//   runtime if the stored vectors and the query vector disagree).
// - `content_hash` is a stable hash of the source text used to generate the
//   vector; when the note's extracted text changes, the hash changes and the
//   indexer knows the vector is stale without recomputing similarity.
//
// Indexing: HNSW with cosine ops (`vector_cosine_ops`) is the recommended
// pgvector access method for approximate nearest-neighbor similarity at scale.
// `vector_cosine_ops` matches the `<=>` (cosine distance) operator used by the
// query path. IVFFlat was considered and rejected: HNSW has better recall and
// incremental-upsert performance (embeddings are upserted per-note-edit) and
// does not require a separate clustering/centers step. The index is rebuildable
// from `notes.content_plain`, so it is operational state, not relational source
// of truth.
//
// Conventions (copied from Part 13–17): camelCase keys, snake_case columns,
// uuid PKs with `defaultRandom()`, timezone-aware timestamps, array-callback
// table config `(t) => [ ... ]`. The `vector` column helper and
// `index().using(...)` with `.op(...)` come from `"drizzle-orm/pg-core"`;
// `relations` comes from `"drizzle-orm"`.

import { relations } from "drizzle-orm";
import {
  index,
  integer,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
  vector,
} from "drizzle-orm/pg-core";

import { notes } from "./notes";

// --------------------------------------------------------------------------- //
// note_embeddings
// --------------------------------------------------------------------------- //
// One current embedding per note (UNIQUE note_id). The indexer (Part 53)
// replaces the single row when a note is re-embedded via
// `on conflict (note_id) do update`; there is no historical-vector table here
// (the Part 53 chunked/multi-vector design will introduce its own table).

export const noteEmbeddings = pgTable(
  "note_embeddings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // One current embedding per note. CASCADE: deleting a note removes its
    // embedding (the embedding is a derived projection, not durable content).
    noteId: uuid("note_id")
      .references(() => notes.id, { onDelete: "cascade" })
      .notNull(),
    // 1536-dimensional vector (OpenAI text-embedding-3-small / text-embedding
    // -ada-002 default dimensionality). The dimensionality is also recorded in
    // `dimensions` so the query path can detect a mismatch before issuing
    // `<=>`. Part 53 may parameterize this when multiple models are supported.
    embedding: vector("embedding", { dimensions: 1536 }).notNull(),
    // Embedding model identifier (e.g. "text-embedding-3-small"). Lets the
    // indexer detect a model change and recompute the workspace. NOT NULL
    // because every vector has a known origin model.
    model: varchar("model", { length: 100 }).notNull(),
    // Stable hash (sha256 hex) of the source text used to derive the vector.
    // When the note's extracted text changes, the hash changes and the indexer
    // knows the vector is stale without recomputing similarity. 64 chars
    // accommodates sha256 hex; shorter hashes (e.g. xxhash hex) fit too.
    contentHash: varchar("content_hash", { length: 64 }).notNull(),
    // Vector dimensionality mirror. The query path checks this BEFORE issuing a
    // `<=>` query so a stored vector is never compared against a mismatched-
    // dimension query vector (which errors at runtime).
    dimensions: integer("dimensions").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // UNIQUE note_id: one current embedding per note. Also serves the per-note
    // upsert and lookup path.
    uniqueIndex("note_embeddings_note_id_unique").on(t.noteId),
    // HNSW approximate-nearest-neighbor index for cosine similarity (`<=>`).
    // `vector_cosine_ops` is the operator class matching the cosine-distance
    // operator the query path uses. Rebuildable from notes.content_plain.
    index("note_embeddings_embedding_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),
  ],
);

// --------------------------------------------------------------------------- //
// Relations
// --------------------------------------------------------------------------- //
// Forward relation only; `notesRelations` (Part 15) is not extended, to keep
// earlier parts immutable per the handoff rules.

export const noteEmbeddingsRelations = relations(noteEmbeddings, ({ one }) => ({
  note: one(notes, {
    fields: [noteEmbeddings.noteId],
    references: [notes.id],
  }),
}));
