-- Part 71 — make `audit_logs` append-only in the database, not just by
-- convention. `recordAudit` (apps/api/src/audit/audit-record.ts) is the only
-- application writer, but a trigger is the only thing that also stops a
-- future migration, a psql session, or a bug from mutating a row after the
-- fact. Immutability is the point of an audit trail: a row that can be
-- edited or removed by anything other than a declared, logged exception is
-- not evidence.
--
-- The trigger raises SQLSTATE 42501 (`insufficient_privilege`) on every
-- UPDATE and DELETE, with exactly two exemptions:
--
--   1. `pg_trigger_depth() > 1` — a referential action (the `workspace_id`
--      ON DELETE CASCADE or the `user_id` ON DELETE SET NULL declared on
--      this table) fires from INSIDE a system-generated trigger, so by the
--      time our BEFORE trigger runs, trigger depth is 2, not 1. A row-level
--      trigger fired directly by a client statement always sees depth 1.
--      This is how a workspace or user deletion is still allowed to remove
--      or null out audit rows, with no separate escape hatch for it.
--   2. `TG_OP = 'DELETE' AND current_setting('notted.audit_purge', true) =
--      'on'` — the one sanctioned exception, the Part 71 retention purge
--      (`AuditLogRetentionService`) and test fixtures that clean up their
--      own rows. `current_setting(name, true)` is the `missing_ok` form, so
--      an unset GUC reads as NULL (not an error) and the condition is false
--      by default. The flag is set with `set_config(..., true)` — the
--      third argument makes it transaction-local, so it cannot leak onto a
--      pooled connection and reverts automatically on commit or rollback.
--      See `allowAuditDelete()` in apps/api/src/audit/audit-record.ts.
--
-- LOCK COST: `CREATE TRIGGER` on an existing table takes a brief SHARE ROW
-- EXCLUSIVE lock on `audit_logs` to install the trigger — it does not block
-- concurrent readers, does not rewrite the table, and holds the lock only
-- for the duration of the DDL statement itself. `CREATE OR REPLACE
-- FUNCTION` takes no lock on the table at all.
--
-- ROLLBACK: `DROP TRIGGER audit_logs_append_only_trigger ON audit_logs;`
-- followed by `DROP FUNCTION audit_logs_append_only();` restores the
-- pre-migration, application-only-enforced state with no data loss.
CREATE OR REPLACE FUNCTION audit_logs_append_only() RETURNS trigger AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF TG_OP = 'DELETE' AND current_setting('notted.audit_purge', true) = 'on' THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION 'audit_logs is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER audit_logs_append_only_trigger
  BEFORE UPDATE OR DELETE ON "audit_logs"
  FOR EACH ROW
  EXECUTE FUNCTION audit_logs_append_only();
