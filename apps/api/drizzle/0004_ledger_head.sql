CREATE TABLE "ledger_head" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"seq" bigint NOT NULL,
	"head_hash" text NOT NULL,
	"sig" text NOT NULL,
	"key_id" text NOT NULL,
	"ts" timestamp with time zone NOT NULL
);
