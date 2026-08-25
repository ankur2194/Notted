CREATE TYPE "public"."workspace_domain_status" AS ENUM('pending', 'verified', 'error');--> statement-breakpoint
CREATE TABLE "workspace_domains" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"hostname" varchar(253) NOT NULL,
	"status" "workspace_domain_status" DEFAULT 'pending' NOT NULL,
	"verification_token" varchar(64) NOT NULL,
	"last_error" varchar(64),
	"last_checked_at" timestamp with time zone,
	"verified_at" timestamp with time zone,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_domains_workspace_id_unique" UNIQUE("workspace_id"),
	CONSTRAINT "workspace_domains_hostname_unique" UNIQUE("hostname")
);
--> statement-breakpoint
ALTER TABLE "workspace_domains" ADD CONSTRAINT "workspace_domains_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_domains" ADD CONSTRAINT "workspace_domains_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workspace_domains_hostname_status_idx" ON "workspace_domains" USING btree ("hostname","status");