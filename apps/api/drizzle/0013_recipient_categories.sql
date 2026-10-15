ALTER TYPE "public"."payee_kind" ADD VALUE IF NOT EXISTS 'BILLER';--> statement-breakpoint
ALTER TABLE "payees" ADD COLUMN IF NOT EXISTS "details_enc" text;--> statement-breakpoint
ALTER TABLE "payees" ADD COLUMN IF NOT EXISTS "archived_at" timestamp with time zone;