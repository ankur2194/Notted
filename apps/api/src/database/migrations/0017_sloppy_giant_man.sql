ALTER TYPE "public"."email_status" ADD VALUE 'processing' BEFORE 'sent';--> statement-breakpoint
ALTER TYPE "public"."email_status" ADD VALUE 'reconciliation_required';--> statement-breakpoint
ALTER TYPE "public"."job_status" ADD VALUE 'processing' BEFORE 'completed';--> statement-breakpoint
ALTER TYPE "public"."job_status" ADD VALUE 'reconciliation_required';--> statement-breakpoint
ALTER TABLE "job_idempotency" ADD COLUMN "processing_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "platform_admin_audits" ADD COLUMN "phase" varchar(16) DEFAULT 'attempt' NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_admin_audits" ADD COLUMN "outcome" varchar(32) DEFAULT 'authorized' NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_admin_audits" ADD COLUMN "related_audit_id" uuid;