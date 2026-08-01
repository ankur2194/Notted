CREATE TABLE "workspace_deletion_audits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deleted_workspace_id" uuid NOT NULL,
	"actor_id" uuid,
	"request_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "workspace_deletion_audits_workspace_created_idx" ON "workspace_deletion_audits" USING btree ("deleted_workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "workspace_deletion_audits_request_id_idx" ON "workspace_deletion_audits" USING btree ("request_id");