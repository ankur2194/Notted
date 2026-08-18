-- `event_id` is NOT NULL with no default in the Drizzle schema, so drizzle-kit
-- emitted a bare `ADD COLUMN "event_id" uuid NOT NULL`. That statement aborts
-- on any table that already holds rows, and `webhook_deliveries` is a log
-- table: a development or review database that has ever exercised a webhook
-- has rows in it. The default is therefore added and immediately dropped —
-- hand appended to the generated file (precedent: 0013/0014), because
-- drizzle-kit emits the target shape and not the path to it.
--
-- LOCK COST, STATED PLAINLY: `gen_random_uuid()` is VOLATILE, so PostgreSQL's
-- fast-path for adding a defaulted column does NOT apply. This statement takes
-- ACCESS EXCLUSIVE and REWRITES the whole table. That is acceptable only
-- because `webhook_deliveries` was introduced by Part 66 and holds at most a
-- handful of development rows at ship time. Adding a volatile default to a
-- large, live log table would need the three-step online path instead (add
-- nullable, backfill in batches, then SET NOT NULL after a VALIDATE).
--
-- Backfilled ids are per-row distinct (gen_random_uuid() is volatile), which is
-- the correct backfill: a pre-existing attempt has no recoverable event
-- identity, so giving each one its own is honest — it groups with nothing and
-- replays to a clean 409 rather than being falsely merged with another event.
--
-- DROP DEFAULT is not cosmetic. Leaving the default would (a) drift from the
-- 0020 snapshot, so the next `db:generate` would emit a spurious drop, and
-- (b) let a producer that forgot `event_id` insert a silently unusable row
-- instead of failing loudly.
ALTER TABLE "webhook_deliveries" ADD COLUMN "event_id" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ALTER COLUMN "event_id" DROP DEFAULT;--> statement-breakpoint
CREATE INDEX "webhook_deliveries_webhook_event_idx" ON "webhook_deliveries" USING btree ("webhook_id","event_id");
