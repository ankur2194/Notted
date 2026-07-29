CREATE TYPE "public"."job_outbox_status" AS ENUM('pending', 'dispatching', 'dispatched', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TABLE "job_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid,
	"queue_name" varchar(100) NOT NULL,
	"job_type" varchar(100) NOT NULL,
	"payload_version" integer DEFAULT 1 NOT NULL,
	"payload" jsonb NOT NULL,
	"payload_hash" varchar(64) NOT NULL,
	"idempotency_key" varchar(255) NOT NULL,
	"status" "job_outbox_status" DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"dispatched_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"correlation_id" uuid,
	"last_error_code" varchar(100),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM "note_versions"
		GROUP BY "note_id", "version"
		HAVING count(*) > 1
	) THEN
		RAISE EXCEPTION 'note_versions contains duplicate (note_id, version) rows; resolve them before migration 0007'
			USING ERRCODE = '23505';
	END IF;
END
$$;--> statement-breakpoint
DROP INDEX "note_versions_note_version_idx";--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email_verified_at" timestamp with time zone;--> statement-breakpoint
UPDATE "users"
SET "email_verified_at" = "email_verified"
WHERE "email_verified" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "email_verified" SET DATA TYPE boolean
USING ("email_verified" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "email_verified" SET DEFAULT false;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "email_verified" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "job_outbox" ADD CONSTRAINT "job_outbox_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "job_outbox_idempotency_key_unique" ON "job_outbox" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "job_outbox_workspace_created_idx" ON "job_outbox" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "job_outbox_dispatcher_idx" ON "job_outbox" USING btree ("status","available_at");--> statement-breakpoint
CREATE INDEX "job_outbox_correlation_id_idx" ON "job_outbox" USING btree ("correlation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "note_versions_note_version_unique" ON "note_versions" USING btree ("note_id","version");
