CREATE TYPE "public"."auth_email_intent_status" AS ENUM('pending', 'processing', 'sent', 'failed', 'expired', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."auth_email_purpose" AS ENUM('registration_verification', 'verification_resend', 'magic_link', 'password_reset_request', 'password_reset_confirmation');--> statement-breakpoint
CREATE TABLE "auth_email_intents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"delivery_id" uuid NOT NULL,
	"purpose" "auth_email_purpose" NOT NULL,
	"encrypted_context" text NOT NULL,
	"encryption_key_version" integer NOT NULL,
	"nonce" varchar(24) NOT NULL,
	"authentication_tag" varchar(24) NOT NULL,
	"status" "auth_email_intent_status" DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"terminal_at" timestamp with time zone,
	"last_error_code" varchar(100),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "auth_email_intents" ADD CONSTRAINT "auth_email_intents_delivery_id_email_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."email_deliveries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "auth_email_intents_delivery_id_unique" ON "auth_email_intents" USING btree ("delivery_id");--> statement-breakpoint
CREATE INDEX "auth_email_intents_dispatch_idx" ON "auth_email_intents" USING btree ("status","expires_at");