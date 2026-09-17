ALTER TABLE "note_public_links" ADD COLUMN "encrypted_token" text;--> statement-breakpoint
ALTER TABLE "note_public_links" ADD COLUMN "encryption_key_version" integer;