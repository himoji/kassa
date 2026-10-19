-- (added 2026-10-19) Wallet top-ups keyed for good by (user, idempotency key), claimed under the per-user payments lock
-- (wallet/service.ts); simulated balances of linked accounts and their debits (funding-sources/pull.ts).
CREATE TABLE "linked_account_sim_balances" (
	"user_id" uuid NOT NULL,
	"account_key" text NOT NULL,
	"currency" text NOT NULL,
	"balance_minor" bigint NOT NULL,
	"seeded_minor" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "linked_account_sim_balances_user_id_account_key_currency_pk" PRIMARY KEY("user_id","account_key","currency")
);
--> statement-breakpoint
CREATE TABLE "linked_account_sim_debits" (
	"user_id" uuid NOT NULL,
	"reference" text NOT NULL,
	"account_key" text NOT NULL,
	"currency" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"provider_ref" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "linked_account_sim_debits_user_id_reference_pk" PRIMARY KEY("user_id","reference")
);
--> statement-breakpoint
CREATE TABLE "wallet_top_ups" (
	"user_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"home_amount_minor" bigint NOT NULL,
	"method" text NOT NULL,
	"funding_source_id" uuid,
	"provider_ref" text,
	"response" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_top_ups_user_id_idempotency_key_pk" PRIMARY KEY("user_id","idempotency_key")
);
--> statement-breakpoint
ALTER TABLE "linked_account_sim_balances" ADD CONSTRAINT "linked_account_sim_balances_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linked_account_sim_debits" ADD CONSTRAINT "linked_account_sim_debits_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_top_ups" ADD CONSTRAINT "wallet_top_ups_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "wallet_top_ups_user_day_idx" ON "wallet_top_ups" USING btree ("user_id","created_at");--> statement-breakpoint
-- Earlier top-ups, from the ledger: their keys stay used and they count toward today's total.
INSERT INTO "wallet_top_ups" ("user_id", "idempotency_key", "status", "amount_minor", "currency", "home_amount_minor", "method", "provider_ref", "response", "created_at", "updated_at")
SELECT u."id", l."payload"->>'idempotencyKey', 'COMPLETED', (l."payload"->>'amountMinor')::bigint, l."payload"->>'currency',
	coalesce((l."payload"->>'homeAmountMinor')::bigint, 0), coalesce(l."payload"->>'method', 'APPLE_PAY'), l."payload"->>'providerRef', l."payload"->'response', l."ts", l."ts"
FROM "ledger_entries" l JOIN "users" u ON u."id"::text = l."payload"->>'userId'
WHERE l."type" = 'WALLET_TOPUP' AND l."payload" ? 'idempotencyKey' AND l."payload" ? 'amountMinor' AND l."payload" ? 'currency'
ON CONFLICT DO NOTHING;
