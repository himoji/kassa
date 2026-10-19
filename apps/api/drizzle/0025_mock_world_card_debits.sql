-- (added 2026-10-19) One-time card charges paid from a mock-bank wallet (apps/mock-world/src/store/postgres.ts,
-- cardDebit). Keyed by the authorization ("card-auth:<authorization id>") so a replayed authorization debits once;
-- card_id is unique too, so a single-use card is never debited twice. Not part of Kassa's own schema (schema.ts).
CREATE TABLE IF NOT EXISTS "mock_world_card_debits" (
	"reference" text PRIMARY KEY NOT NULL,
	"card_id" text NOT NULL UNIQUE,
	"profile_id" bigint NOT NULL,
	"request_currency" text NOT NULL,
	"request_amount_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"amount_minor" bigint NOT NULL CHECK ("amount_minor" > 0),
	"balance_after_minor" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
