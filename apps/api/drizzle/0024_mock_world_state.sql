-- (added 2026-10-18) Mock-world state shared by every serverless instance of a deployed build
-- (apps/mock-world/src/store/postgres.ts). Not part of Kassa's own schema (schema.ts): the simulated bank and
-- third-party systems keep their state here, so a cold start or a second instance sees the same world.
CREATE TABLE IF NOT EXISTS "mock_world_wallets" (
	"profile_id" bigint PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mock_world_aliases" (
	"alias" text PRIMARY KEY NOT NULL,
	"profile_id" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mock_world_balances" (
	"profile_id" bigint NOT NULL REFERENCES "mock_world_wallets"("profile_id") ON DELETE CASCADE,
	"currency" text NOT NULL,
	"amount_minor" bigint NOT NULL CHECK ("amount_minor" >= 0),
	"position" bigserial NOT NULL,
	PRIMARY KEY ("profile_id", "currency")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mock_world_top_ups" (
	"reference" text PRIMARY KEY NOT NULL,
	"profile_id" bigint NOT NULL,
	"currency" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"balance_after_minor" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mock_world_entities" (
	"kind" text NOT NULL,
	"id" text NOT NULL,
	"data" jsonb NOT NULL,
	"version" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	PRIMARY KEY ("kind", "id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mock_world_entities_updated_idx" ON "mock_world_entities" USING btree ("updated_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mock_world_meta" (
	"id" integer PRIMARY KEY NOT NULL CHECK ("id" = 1),
	"generation" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
INSERT INTO "mock_world_meta" ("id", "generation") VALUES (1, 1) ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- Recipient, transfer and balance-transaction ids, handed out in blocks of 1000 per instance (Wise ids are integers).
CREATE SEQUENCE IF NOT EXISTS "mock_world_ids" START WITH 200000000 INCREMENT BY 1000;
