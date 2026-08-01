CREATE TABLE "api_idempotency_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"operation" varchar(100) NOT NULL,
	"key_hash" varchar(64) NOT NULL,
	"payload_hash" varchar(64) NOT NULL,
	"resource_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_idempotency_records" ADD CONSTRAINT "api_idempotency_records_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "api_idempotency_actor_operation_key_unique" ON "api_idempotency_records" USING btree ("actor_user_id","operation","key_hash");--> statement-breakpoint
CREATE INDEX "api_idempotency_expires_at_idx" ON "api_idempotency_records" USING btree ("expires_at");