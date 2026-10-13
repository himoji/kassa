CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"title" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "placeholder_maps" ADD COLUMN "user_id" uuid;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversations_user_idx" ON "conversations" USING btree ("user_id","created_at");--> statement-breakpoint
ALTER TABLE "placeholder_maps" ADD CONSTRAINT "placeholder_maps_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Backfill: every existing conversation id gets its owner and channel (earliest row wins; ids that are not UUIDs are skipped).
INSERT INTO "conversations" ("id", "user_id", "channel", "created_at")
SELECT DISTINCT ON ("conversation_id") "conversation_id"::uuid, "user_id", "channel", "created_at"
FROM "agent_messages"
WHERE "conversation_id" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
ORDER BY "conversation_id", "seq"
ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "conversations" ("id", "user_id", "channel", "created_at")
SELECT "conversation_id"::uuid, "user_id", 'onboarding', "updated_at"
FROM "onboarding_drafts"
WHERE "conversation_id" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
ON CONFLICT DO NOTHING;--> statement-breakpoint
UPDATE "placeholder_maps" AS p SET "user_id" = c."user_id"
FROM "conversations" AS c
WHERE p."user_id" IS NULL AND p."conversation_id" = c."id"::text;
