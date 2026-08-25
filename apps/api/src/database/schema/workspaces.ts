// Part 14: workspace, membership, and invitation tables.
//
// This is the first tenant-owned schema in Notted. Per ADR 0007 every
// tenant-owned row carries or reaches a `workspace_id`; `workspaces` is the
// tenancy root that Parts 15–18 (projects, notes, tags, tasks, ...) will
// reference. Per ADR 0003 a valid identity never implies workspace access:
// only an active `workspace_members` row with a role grants access, and the
// service policy layer (Part 26) denies by default.
//
// Conventions (copied from Part 13's `users.ts` / `auth.ts`):
// - Drizzle property keys are camelCase; database column names are snake_case.
// - Primary keys are `uuid("id").primaryKey().defaultRandom()`.
// - Timestamps are timezone-aware (`timestamp(..., { withTimezone: true })`).
// - The table second argument uses the array callback form `(t) => [ ... ]`.
// - Column helpers and `relations` come from `"drizzle-orm/pg-core"`; if a later
//   part needs a functional index, `sql` is imported from `"drizzle-orm"` (never
//   `pg-core`) per the Part 13 convention.
//
// Deletion model:
// - Deleting a `workspaces` row CASCADES to `workspace_members` and
//   `invitations` (and, in later parts, to projects/notes/etc.) so a workspace
//   cannot leave orphaned tenant rows. This is the tenant-lifecycle cascade.
// - `workspace_members.user_id` and `invitations.invited_by_id` /
//   `invitations.accepted_by_id` cascade or nullify per-column so deleting a
//   user removes their memberships and invitation footprints.
// - `workspaces.created_by_id` uses `ON DELETE RESTRICT`. A workspace is a
//   shared tenant entity, not personal auth state, so deleting its original
//   creator must NOT silently destroy the workspace and every member's data.
//   RESTRICT forces the membership service (Part 26) to transfer ownership or
//   delete the workspace explicitly before the creator's account can be removed.
//
// Last-owner protection is NOT enforceable at the column/constraint level. It
// is transactional service logic in Part 26: before any role change or member
// removal, the service counts active `owner` rows in `workspace_members` for
// that workspace and rejects the change if it would leave zero owners. The
// schema only guarantees (via the `(workspace_id, user_id)` unique constraint)
// that a user has exactly one role per workspace, so "is this user an owner?"
// is a single-row lookup.
//
// Invitations (ADR 0007 "Invitations" row):
// - Workspace-scoped and single-use. `token_hash` is UNIQUE so a given token
//   can redeem at most one invitation row; the service also sets `accepted_at`
//   / `revoked_at` and rejects already-used tokens.
// - `email` stores the target address normalized to lowercase; the membership
//   service (Part 28) lowercases before insert and before lookup so plain
//   indexes are sufficient (no functional `lower(email)` index needed here).
// - Default intended role is `viewer`; default expiry is seven days (service-
//   supplied `expiresAt`; the column itself is `notNull` so a token without an
//   expiry can never be persisted).
// - Acceptance requires the authenticated user's email to match `email`; that
//   check is service-side (Part 28) and is not expressible as a DB constraint.
// - Only `token_hash` is stored. The raw token is generated, sent by email, and
//   discarded; it is never persisted or logged.

import { relations } from "drizzle-orm";
import {
  bigint,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { users } from "./users";

// --------------------------------------------------------------------------- //
// Enums
// --------------------------------------------------------------------------- //
// Role ordering reflects the permissions matrix in `Notted.md`
// (owner > admin > editor > viewer). Authorization comparisons and privilege
// escalation checks live in the service/policy layer (Part 26), not here.
export const memberRoleEnum = pgEnum("member_role", ["owner", "admin", "editor", "viewer"]);

// Billing/feature plan stored on the workspace. Plan defaults and enforcement
// are owned by billing/feature logic (later parts); the column only records
// the workspace's current plan with a safe `free` default.
export const workspacePlanEnum = pgEnum("workspace_plan", ["free", "pro", "enterprise"]);

// --------------------------------------------------------------------------- //
// workspaces
// --------------------------------------------------------------------------- //

export const workspaces = pgTable(
  "workspaces",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: varchar("name", { length: 255 }).notNull(),
    // URL/workspace handle. Unique and indexed for resolution and conflict
    // checks. Slug validation/collision-avoidance is service-side (Part 26).
    slug: varchar("slug", { length: 255 }).notNull(),
    description: text("description"),
    logoUrl: text("logo_url"),
    // Part 73: a READ-ONLY MIRROR of the workspace's VERIFIED custom hostname.
    // `workspace_domains` is the source of truth — it is where a claim lives
    // while it is still unproven, which this column must never contain. The
    // domains service writes it inside the same transaction as a successful
    // verification and clears it on removal or a failed re-verification, so a
    // reader of this column is always reading a proved hostname. It is not
    // writable through `PATCH /workspaces/{id}` and carries no API input schema.
    //
    // NULL for the majority; uniqueness only applies to non-null values
    // (PostgreSQL NULL distinctness).
    domain: varchar("domain", { length: 255 }),
    plan: workspacePlanEnum("plan").default("free").notNull(),
    // Branding, accent color, default page size, feature flags, etc. Defaults
    // to an empty object; the service validates the shape on write.
    settings: jsonb("settings").default({}).notNull(),
    // Per-workspace storage override in bytes. NULL means the plan default
    // applies (Part 45). Using an explicit bigint column keeps quota checks
    // indexable and avoids baking plan limits into JSON.
    storageLimitBytes: bigint("storage_limit_bytes", { mode: "number" }),
    // Original creator. RESTRICT: see module note. Ownership at any point in
    // time is the `owner` row in `workspace_members`, not this column.
    createdById: uuid("created_by_id")
      .references(() => users.id, { onDelete: "restrict" })
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("workspaces_slug_unique").on(t.slug),
    uniqueIndex("workspaces_domain_unique").on(t.domain),
    // Lookup workspaces by creator (e.g. "your workspaces" admin views).
    index("workspaces_created_by_id_idx").on(t.createdById),
  ],
);

// --------------------------------------------------------------------------- //
// workspace_members
// --------------------------------------------------------------------------- //
// Exactly one role per user per workspace is enforced by the
// `(workspace_id, user_id)` unique index. `joinedAt` is the membership
// creation timestamp (replaces `createdAt` per `Notted.md`).

export const workspaceMembers = pgTable(
  "workspace_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .references(() => workspaces.id, { onDelete: "cascade" })
      .notNull(),
    userId: uuid("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    role: memberRoleEnum("role").default("editor").notNull(),
    joinedAt: timestamp("joined_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // One membership per (workspace, user). Composite leftmost prefix also
    // accelerates "list members of workspace X".
    uniqueIndex("workspace_members_workspace_user_unique").on(t.workspaceId, t.userId),
    // "List a user's workspaces" is not covered by the composite's leftmost
    // prefix, so add a dedicated user_id index.
    index("workspace_members_user_id_idx").on(t.userId),
  ],
);

// --------------------------------------------------------------------------- //
// invitations
// --------------------------------------------------------------------------- //
// See the module-level comment and ADR 0007 for the full contract.

export const invitations = pgTable(
  "invitations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .references(() => workspaces.id, { onDelete: "cascade" })
      .notNull(),
    // Target email, normalized to lowercase by the service before insert.
    email: varchar("email", { length: 255 }).notNull(),
    role: memberRoleEnum("role").default("viewer").notNull(),
    // SHA-256 (or argon2-style) hash of the invitation token. Never store or
    // log the raw token. Unique so a token redeems exactly one invitation.
    tokenHash: varchar("token_hash", { length: 255 }).notNull(),
    invitedById: uuid("invited_by_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    // Service-supplied; default seven days from creation (ADR 0007).
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    // Single-use markers; both nullable and both set by the service.
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    acceptedById: uuid("accepted_by_id").references(() => users.id, { onDelete: "set null" }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // Token redemption lookup + single-use guarantee.
    uniqueIndex("invitations_token_hash_unique").on(t.tokenHash),
    // "Pending invitations for a workspace" and "pending invitations for an
    // email" are the two hot paths; the service normalizes email casing so a
    // plain index is sufficient.
    index("invitations_workspace_id_idx").on(t.workspaceId),
    index("invitations_email_idx").on(t.email),
  ],
);

// --------------------------------------------------------------------------- //
// Relations
// --------------------------------------------------------------------------- //
// Forward relations only. `usersRelations` (in `auth.ts`) is intentionally not
// extended here to keep Part 13 files immutable; Drizzle allows one-directional
// relations. `relationName` disambiguates the two `users` references on
// `invitations` so the Drizzle query builder can resolve them unambiguously.

export const workspacesRelations = relations(workspaces, ({ one, many }) => ({
  createdBy: one(users, { fields: [workspaces.createdById], references: [users.id] }),
  members: many(workspaceMembers),
  invitations: many(invitations),
}));

export const workspaceMembersRelations = relations(workspaceMembers, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [workspaceMembers.workspaceId],
    references: [workspaces.id],
  }),
  user: one(users, { fields: [workspaceMembers.userId], references: [users.id] }),
}));

export const invitationsRelations = relations(invitations, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [invitations.workspaceId],
    references: [workspaces.id],
  }),
  invitedBy: one(users, {
    fields: [invitations.invitedById],
    references: [users.id],
    relationName: "invitations_invitedBy",
  }),
  acceptedBy: one(users, {
    fields: [invitations.acceptedById],
    references: [users.id],
    relationName: "invitations_acceptedBy",
  }),
}));
