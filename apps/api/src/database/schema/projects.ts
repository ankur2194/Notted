// Part 15: projects, project access grants, and project status enum.
//
// Projects are workspace-scoped containers that group related notes. Per ADR
// 0007, projects DEFAULT to inheriting workspace access; explicit
// `project_access` rows are added ONLY when a project is restricted.
// Restricted projects deny users without an explicit grant; workspace
// owner/admin retain administrative access via the policy layer (Part 24/29),
// not via rows in this table. Access is NEVER inferred from authorship alone.
//
// Cross-tenant integrity: every project row carries `workspace_id`, and notes
// reference projects via a COMPOSITE foreign key `(workspace_id, project_id)`
// (declared on `notes`) so a note cannot point at another workspace's project
// at the database layer. To support that composite FK, `projects` declares a
// UNIQUE index on `(workspace_id, id)` — redundant with the `id` PK but
// REQUIRED by PostgreSQL as the composite FK target.
//
// Project deletion: the composite FK on `notes` uses `ON DELETE NO ACTION`
// (see `notes.ts`), so deleting a project requires the service (Part 29) to
// first nullify `notes.project_id` for its notes in the same transaction. This
// is a deliberate, security-first deviation from Notted.md's literal
// `onDelete: "set null"`; the observable behavior ("project deletion keeps
// notes alive as standalone") is preserved through service coordination.
//
// Conventions (copied from Part 13/14):
// - Drizzle property keys are camelCase; database column names are snake_case.
// - Primary keys are `uuid("id").primaryKey().defaultRandom()`.
// - Timestamps are timezone-aware (`timestamp(..., { withTimezone: true })`).
// - The table second argument uses the array callback form `(t) => [ ... ]`.
// - `relations` is imported from `drizzle-orm` (root), never `pg-core`.
// - `sql` is imported from `drizzle-orm` (root) when partial/functional
//   indexes are needed.

import { relations } from "drizzle-orm";
import {
  boolean,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { users } from "./users";
import { workspaces } from "./workspaces";

// --------------------------------------------------------------------------- //
// Enums
// --------------------------------------------------------------------------- //
// Lifecycle status for projects. `active` is the default. The denormalized
// `is_archived` boolean mirrors `status = 'archived'`; the service (Part 29)
// keeps both in sync. Queries may use whichever is more convenient.
export const projectStatusEnum = pgEnum("project_status", ["active", "archived", "completed"]);

// Narrower role enum for explicit project access grants. Excludes `owner`
// because project ownership is delegated from workspace-level ownership:
// workspace owners/admins are project admins via the policy layer (Part 24),
// not via rows in `project_access`. Reusing `memberRoleEnum` was considered
// and rejected: storing an `owner` value here would imply project-level
// ownership that does not exist. Ordering viewer < editor < admin matches the
// permissions matrix; privilege comparison and escalation checks live in the
// policy layer.
export const projectAccessRoleEnum = pgEnum("project_access_role", ["admin", "editor", "viewer"]);

// --------------------------------------------------------------------------- //
// projects
// --------------------------------------------------------------------------- //

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .references(() => workspaces.id, { onDelete: "cascade" })
      .notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    description: text("description"),
    coverImageUrl: text("cover_image_url"),
    // Hex accent color. The service (Part 29) validates the `#rrggbb` shape;
    // the column only constrains length. Default brand blue.
    color: varchar("color", { length: 7 }).default("#3b82f6"),
    status: projectStatusEnum("status").default("active").notNull(),
    dueDate: timestamp("due_date", { withTimezone: true }),
    // Denormalized convenience flag mirroring `status = 'archived'`. Kept for
    // cheap filtered indexes without joining on enum equality.
    isArchived: boolean("is_archived").default(false).notNull(),
    // Original creator. RESTRICT: a project is a shared tenant entity (many
    // notes), so deleting its creator must not silently destroy the project
    // and its notes. The service (Part 26) transfers or nullifies before the
    // creator account can be removed.
    createdById: uuid("created_by_id")
      .references(() => users.id, { onDelete: "restrict" })
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // Composite FK target for `notes(workspace_id, project_id)`. The pair is
    // already unique because `id` alone is the PK; this explicit unique index
    // exists solely so PostgreSQL accepts the composite FK in `notes.ts`.
    uniqueIndex("projects_workspace_id_id_unique").on(t.workspaceId, t.id),
    // "List projects in workspace" hot path.
    index("projects_workspace_id_idx").on(t.workspaceId),
    // "Active/archived/completed projects in workspace" filtered list.
    index("projects_workspace_status_idx").on(t.workspaceId, t.status),
    // "Projects created by user" admin view.
    index("projects_created_by_id_idx").on(t.createdById),
  ],
);

// --------------------------------------------------------------------------- //
// project_access
// --------------------------------------------------------------------------- //
// Per ADR 0007, explicit access grants exist ONLY for restricted projects.
// Absence of any row for a project means the project INHERITS workspace
// access. Restricted projects deny users without an explicit grant; workspace
// owner/admin retain administrative access via the policy layer (Part 24/29),
// not via rows here. Never infer access from authorship.
//
// This table is intentionally workspace-free at the column level: `project_id`
// reaches `workspace_id` transitively via `projects`. Cross-workspace grant
// validation (the grantee must be an active member of the project's
// workspace) is enforced by the service/policy layer (Part 24/29); it is not
// expressible as a single-column DB constraint without denormalizing
// `workspace_id` here, which the brief deliberately omits.

export const projectAccess = pgTable(
  "project_access",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .references(() => projects.id, { onDelete: "cascade" })
      .notNull(),
    // Grantee. CASCADE: deleting a user removes their explicit project grants
    // (the durable workspace membership is the source of truth for default
    // access; explicit grants are personal and do not survive the account).
    userId: uuid("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    role: projectAccessRoleEnum("role").notNull(),
    // Grantor (audit). RESTRICT: deleting the grantor must not silently drop
    // the audit trail; the service (Part 26) reassigns or removes grants
    // before the grantor account can be removed.
    createdById: uuid("created_by_id")
      .references(() => users.id, { onDelete: "restrict" })
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // One grant per (project, user). The composite leftmost prefix also
    // accelerates "list grants for project X".
    uniqueIndex("project_access_project_user_unique").on(t.projectId, t.userId),
    // "Which restricted projects can user X access" lookup.
    index("project_access_user_id_idx").on(t.userId),
  ],
);

// --------------------------------------------------------------------------- //
// Relations
// --------------------------------------------------------------------------- //
// Forward relations only; `workspacesRelations` and `usersRelations` are not
// extended here, to keep Part 13/14 files immutable per the handoff rules.

export const projectsRelations = relations(projects, ({ one, many }) => ({
  workspace: one(workspaces, {
    fields: [projects.workspaceId],
    references: [workspaces.id],
  }),
  createdBy: one(users, {
    fields: [projects.createdById],
    references: [users.id],
  }),
  access: many(projectAccess),
}));

export const projectAccessRelations = relations(projectAccess, ({ one }) => ({
  project: one(projects, {
    fields: [projectAccess.projectId],
    references: [projects.id],
  }),
  user: one(users, {
    fields: [projectAccess.userId],
    references: [users.id],
    relationName: "project_access_user",
  }),
  createdBy: one(users, {
    fields: [projectAccess.createdById],
    references: [users.id],
    relationName: "project_access_createdBy",
  }),
}));
