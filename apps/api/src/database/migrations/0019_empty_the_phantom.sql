CREATE TYPE "public"."note_collaboration_record" AS ENUM('snapshot', 'update');--> statement-breakpoint
CREATE TABLE "note_collaboration_states" (
	"note_id" uuid PRIMARY KEY NOT NULL,
	"epoch" integer DEFAULT 1 NOT NULL,
	"last_revision" integer DEFAULT 0 NOT NULL,
	"projected_revision" integer DEFAULT 0 NOT NULL,
	"projected_note_version" integer NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"state_bytes" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "note_collaboration_updates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"note_id" uuid NOT NULL,
	"epoch" integer NOT NULL,
	"revision" integer NOT NULL,
	"kind" "note_collaboration_record" NOT NULL,
	"payload" "bytea" NOT NULL,
	"payload_bytes" integer NOT NULL,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "note_collaboration_states" ADD CONSTRAINT "note_collaboration_states_note_id_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_collaboration_updates" ADD CONSTRAINT "note_collaboration_updates_note_id_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_collaboration_updates" ADD CONSTRAINT "note_collaboration_updates_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "note_collaboration_updates_note_revision_unique" ON "note_collaboration_updates" USING btree ("note_id","revision");--> statement-breakpoint
CREATE INDEX "note_collaboration_updates_note_epoch_revision_idx" ON "note_collaboration_updates" USING btree ("note_id","epoch","revision");