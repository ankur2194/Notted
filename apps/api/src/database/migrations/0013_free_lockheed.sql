ALTER TABLE "notes" ADD COLUMN "deletion_batch_id" uuid;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "is_restricted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "projects"
SET "is_restricted" = true
WHERE EXISTS (
	SELECT 1
	FROM "project_access"
	WHERE "project_access"."project_id" = "projects"."id"
);--> statement-breakpoint
CREATE INDEX "notes_workspace_template_updated_idx" ON "notes" USING btree ("workspace_id","is_template","updated_at") WHERE notes.is_deleted = false;--> statement-breakpoint
CREATE INDEX "notes_workspace_archive_updated_idx" ON "notes" USING btree ("workspace_id","is_archived","updated_at") WHERE notes.is_deleted = false;
