CREATE TABLE "note_public_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"note_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "note_public_links_note_id_unique" UNIQUE("note_id"),
	CONSTRAINT "note_public_links_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "note_public_links" ADD CONSTRAINT "note_public_links_note_id_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_public_links" ADD CONSTRAINT "note_public_links_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_public_links" ADD CONSTRAINT "note_public_links_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_public_links" ADD CONSTRAINT "note_public_links_workspace_note_fk" FOREIGN KEY ("workspace_id","note_id") REFERENCES "public"."notes"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "note_public_links_created_by_id_idx" ON "note_public_links" USING btree ("created_by_id");