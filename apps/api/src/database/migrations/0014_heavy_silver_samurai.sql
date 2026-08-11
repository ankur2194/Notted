ALTER TABLE "notes" ADD COLUMN "checklist_done" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "notes" ADD COLUMN "checklist_total" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Backfill the new counters from the documents already stored, so existing
-- notes do not all report "0 of 0" until someone happens to edit them. Hand
-- appended to the generated file (precedent: 0013_free_lockheed.sql), because
-- drizzle-kit emits schema changes only.
--
-- The recursive CTE walks every node's `content` array, mirroring
-- `countChecklist` in `@notted/shared-validators`: a `taskItem` counts toward
-- the total wherever it sits, including inside another task item, and counts
-- as done only when `attrs.checked` is exactly `true`. The CASE guard is what
-- keeps `jsonb_array_elements` from being handed a non-array.
--
-- Full table scan, once, at deploy time. Acceptable at current scale; the rows
-- written are only those that actually contain a checklist.
WITH RECURSIVE "checklist_node" AS (
	SELECT "notes"."id" AS "note_id", "notes"."content" AS "value"
	FROM "notes"
	UNION ALL
	SELECT "checklist_node"."note_id", "child"."value"
	FROM "checklist_node"
	CROSS JOIN LATERAL jsonb_array_elements(
		CASE
			WHEN jsonb_typeof("checklist_node"."value" -> 'content') = 'array'
			THEN "checklist_node"."value" -> 'content'
			ELSE '[]'::jsonb
		END
	) AS "child"("value")
), "checklist_count" AS (
	SELECT
		"checklist_node"."note_id",
		count(*) FILTER (
			WHERE "checklist_node"."value" ->> 'type' = 'taskItem'
		) AS "total",
		count(*) FILTER (
			WHERE "checklist_node"."value" ->> 'type' = 'taskItem'
				AND "checklist_node"."value" -> 'attrs' -> 'checked' = 'true'::jsonb
		) AS "done"
	FROM "checklist_node"
	GROUP BY "checklist_node"."note_id"
)
UPDATE "notes"
SET "checklist_done" = "checklist_count"."done",
	"checklist_total" = "checklist_count"."total"
FROM "checklist_count"
WHERE "checklist_count"."note_id" = "notes"."id"
	AND "checklist_count"."total" > 0;