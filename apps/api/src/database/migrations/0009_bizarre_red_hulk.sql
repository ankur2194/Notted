CREATE TYPE "public"."notification_kind" AS ENUM('system', 'workspace', 'mention', 'comment', 'export');--> statement-breakpoint
CREATE TYPE "public"."notification_target_type" AS ENUM('workspace', 'note', 'comment', 'export', 'settings');--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"recipient_user_id" uuid NOT NULL,
	"actor_user_id" uuid,
	"kind" "notification_kind" NOT NULL,
	"target_type" "notification_target_type",
	"target_id" uuid,
	"summary" varchar(160) NOT NULL,
	"target_label" varchar(120),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_recipient_user_id_users_id_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notifications_recipient_recent_idx" ON "notifications" USING btree ("recipient_user_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "notifications_recipient_workspace_recent_idx" ON "notifications" USING btree ("recipient_user_id","workspace_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "notifications_workspace_recent_idx" ON "notifications" USING btree ("workspace_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "notifications_recipient_workspace_unread_idx" ON "notifications" USING btree ("recipient_user_id","workspace_id","created_at" DESC NULLS LAST) WHERE "notifications"."read_at" is null;