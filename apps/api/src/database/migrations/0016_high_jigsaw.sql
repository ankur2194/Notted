CREATE TABLE "platform_admin_audits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator_user_id" uuid NOT NULL,
	"action" varchar(40) NOT NULL,
	"queue_name" varchar(64) NOT NULL,
	"job_id" varchar(128),
	"request_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "is_platform_operator" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "platform_admin_audits_operator_created_idx" ON "platform_admin_audits" USING btree ("operator_user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "platform_admin_audits_request_id_idx" ON "platform_admin_audits" USING btree ("request_id");