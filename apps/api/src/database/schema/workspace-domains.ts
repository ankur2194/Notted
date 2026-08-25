// Part 73 — custom-domain claims and their verification state.
//
// WHY A TABLE AND NOT `workspaces.domain`. `workspaces.domain` has existed since
// Part 18 as a nullable, globally-unique string that nothing read. A claim is
// not a string: it has an ownership token, a status, a failure reason, and two
// timestamps, and — critically — it must be storable while it is still UNPROVEN.
// Putting an unproven hostname in `workspaces.domain` would mean the column that
// routing consults also contains hostnames nobody has proved they own, which is
// exactly the tenant-takeover this part exists to prevent.
//
// `workspaces.domain` therefore becomes a MIRROR of the verified hostname only:
// the service writes it on a successful verification and clears it on removal or
// a failed re-verification. It is read-only in every API contract and exists so
// the workspace detail can show the live hostname without a join.
//
// ONE DOMAIN PER WORKSPACE (`workspace_id` unique). A second hostname would need
// its own routing precedence, its own canonical-URL answer, and its own cookie
// story; none of that has a use case yet, and a unique constraint is a smaller
// thing to relax later than a multiplicity to take back.
//
// `hostname` is UNIQUE GLOBALLY and stored lowercase/punycode
// (`normalizeHostname` in `@notted/shared-validators` is the single normaliser
// on both sides of the wire). Two workspaces claiming the same name is not a
// tenant conflict to resolve later — it is two tenants racing for one address,
// and the database is the only place that race can be settled.
//
// `verification_token` IS NOT A CREDENTIAL and is deliberately stored in
// plaintext. Its whole purpose is to be PUBLISHED in a TXT record that anyone on
// the internet can read; hashing it would only make it impossible to tell the
// administrator what to publish. It proves control of DNS for the name, nothing
// more, and it grants nothing on its own.
//
// `last_error` is a FIXED VOCABULARY (`txt_missing`, `txt_mismatch`,
// `cname_mismatch`, `dns_failure`), never a resolver's own message: a
// third-party error string in a tenant-readable column is uncontrolled text, and
// it changes with the resolver.
//
// Deletion model:
// - `workspace_id` CASCADE — a deleted workspace's claim goes with it, and the
//   hostname is freed for whoever proves ownership next.
// - `created_by_id` SET NULL — a departed admin must not pin a claim, and the
//   audit trail (`domain.set` / `domain.verify` / `domain.remove`) is where "who
//   did this" actually lives.

import { relations } from "drizzle-orm";
import { index, pgEnum, pgTable, timestamp, uuid, varchar } from "drizzle-orm/pg-core";

import { users } from "./users";
import { workspaces } from "./workspaces";

/**
 * `pending` — claimed, DNS not yet proved. Routing must refuse it.
 * `verified` — both records observed; the host routes to this workspace.
 * `error`   — the last check failed; `last_error` says how. Also refused.
 */
export const workspaceDomainStatusEnum = pgEnum("workspace_domain_status", [
  "pending",
  "verified",
  "error",
]);

export const workspaceDomains = pgTable(
  "workspace_domains",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // UNIQUE: one claim per workspace. See the module comment.
    workspaceId: uuid("workspace_id")
      .references(() => workspaces.id, { onDelete: "cascade" })
      .notNull()
      .unique("workspace_domains_workspace_id_unique"),
    // Lowercase punycode, no trailing dot. 253 is the DNS maximum.
    hostname: varchar("hostname", { length: 253 })
      .notNull()
      .unique("workspace_domains_hostname_unique"),
    status: workspaceDomainStatusEnum("status").default("pending").notNull(),
    // PLAINTEXT ON PURPOSE — it is published in DNS. See the module comment.
    verificationToken: varchar("verification_token", { length: 64 }).notNull(),
    // Fixed vocabulary, not a resolver message.
    lastError: varchar("last_error", { length: 64 }),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    createdById: uuid("created_by_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // The trusted-host lookup on every request that arrives on a non-primary
    // host: `where hostname = $1 and status = 'verified'`. The unique index on
    // `hostname` already serves the equality; this one keeps the status filter
    // on the same index so the lookup stays index-only.
    index("workspace_domains_hostname_status_idx").on(t.hostname, t.status),
  ],
);

export const workspaceDomainsRelations = relations(workspaceDomains, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [workspaceDomains.workspaceId],
    references: [workspaces.id],
  }),
  createdBy: one(users, {
    fields: [workspaceDomains.createdById],
    references: [users.id],
  }),
}));
