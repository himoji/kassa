CREATE TYPE "public"."agent_mode" AS ENUM('LIVE', 'REPLAY');--> statement-breakpoint
CREATE TYPE "public"."card_kind" AS ENUM('HOME_KZT', 'USD', 'LOCAL_HUF', 'MULTI');--> statement-breakpoint
CREATE TYPE "public"."decision" AS ENUM('AUTO', 'ASK', 'HANDOFF', 'REFUSE');--> statement-breakpoint
CREATE TYPE "public"."device_kind" AS ENUM('IOS_SHORTCUT', 'APP');--> statement-breakpoint
CREATE TYPE "public"."mandate_period" AS ENUM('WEEK', 'MONTH');--> statement-breakpoint
CREATE TYPE "public"."mandate_status" AS ENUM('ACTIVE', 'PENDING_EFFECTIVE', 'REVOKED');--> statement-breakpoint
CREATE TYPE "public"."money_mode" AS ENUM('PAY_IN_PLACE', 'CAPPED_WALLET', 'HANDOFF');--> statement-breakpoint
CREATE TYPE "public"."notification_mode" AS ENUM('EACH', 'THRESHOLDS', 'DIGEST');--> statement-breakpoint
CREATE TYPE "public"."payee_kind" AS ENUM('LANDLORD', 'UNIVERSITY', 'INSURER', 'MERCHANT', 'SUPPLIER', 'PERSON', 'OWN_ACCOUNT');--> statement-breakpoint
CREATE TYPE "public"."payee_status" AS ENUM('VERIFIED', 'COOLING', 'BLOCKED');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('CREATED', 'PROCESSING', 'SENT', 'FAILED', 'CANCELED');--> statement-breakpoint
CREATE TYPE "public"."preset" AS ENUM('ASK_ME', 'SMART', 'AUTOPILOT');--> statement-breakpoint
CREATE TYPE "public"."proposal_created_by" AS ENUM('AGENT', 'SCHEDULER', 'USER');--> statement-breakpoint
CREATE TYPE "public"."proposal_status" AS ENUM('PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'REFUSED', 'HANDOFF', 'EXECUTED', 'EXPIRED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."rail" AS ENUM('CARD_ISSUING', 'BANK_TRANSFER', 'HANDOFF', 'PAY_IN_PLACE');--> statement-breakpoint
CREATE TYPE "public"."recurrence" AS ENUM('MONTHLY', 'ONCE', 'TERM');--> statement-breakpoint
CREATE TYPE "public"."region" AS ENUM('EU', 'CN');--> statement-breakpoint
CREATE TYPE "public"."rule_change_direction" AS ENUM('LOOSEN', 'TIGHTEN');--> statement-breakpoint
CREATE TYPE "public"."tier" AS ENUM('T1', 'T2');--> statement-breakpoint
CREATE TYPE "public"."transaction_source" AS ENUM('SHORTCUT', 'NOTIF_SIM', 'TEXT', 'VOICE', 'SCREENSHOT', 'SETTLEMENT', 'KASSA_PAYMENT');--> statement-breakpoint
CREATE TYPE "public"."transaction_status" AS ENUM('PENDING', 'SETTLED');--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"proposal_id" uuid NOT NULL,
	"order_hash" text NOT NULL,
	"tier" "tier" NOT NULL,
	"approval_sig" text NOT NULL,
	"key_id" text NOT NULL,
	"user_assertion" jsonb,
	"mandate_id" uuid,
	"issued_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "budgets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"category" text NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"limit_home_minor" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "card_fee_profiles" (
	"card_id" uuid NOT NULL,
	"from_currency" text NOT NULL,
	"to_currency" text NOT NULL,
	"median_markup_bps" integer NOT NULL,
	"fixed_fee_minor" bigint DEFAULT 0 NOT NULL,
	"samples" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "card_fee_profiles_card_id_from_currency_to_currency_pk" PRIMARY KEY("card_id","from_currency","to_currency")
);
--> statement-breakpoint
CREATE TABLE "cards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"label" text NOT NULL,
	"last4" text NOT NULL,
	"billing_currency" text NOT NULL,
	"kind" "card_kind" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "demo_state" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"clock_offset_ms" bigint DEFAULT 0 NOT NULL,
	"agent_mode" "agent_mode" DEFAULT 'LIVE' NOT NULL,
	"seeded_at" timestamp with time zone,
	"demo_user_id" uuid,
	"demo_claimed" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" "device_kind" NOT NULL,
	"token_hash" text NOT NULL,
	"push_token" text,
	"platform" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "devices_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "issued_cards" (
	"stripe_card_id" text PRIMARY KEY NOT NULL,
	"approval_id" uuid NOT NULL,
	"expected_merchant_norm" text NOT NULL,
	"max_amount_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"canceled_at" timestamp with time zone,
	"payment_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"last4" text,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_checkpoints" (
	"seq" bigint PRIMARY KEY NOT NULL,
	"head_hash" text NOT NULL,
	"sig" text NOT NULL,
	"key_id" text NOT NULL,
	"ts" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"seq" bigint PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"prev_hash" text NOT NULL,
	"hash" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mandates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"payee_ids" jsonb NOT NULL,
	"categories" jsonb NOT NULL,
	"currency" text NOT NULL,
	"max_per_payment_minor" bigint NOT NULL,
	"max_per_period_minor" bigint NOT NULL,
	"period" "mandate_period" NOT NULL,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_until" timestamp with time zone,
	"mandate_hash" text NOT NULL,
	"user_assertion" jsonb,
	"status" "mandate_status" NOT NULL,
	"effective_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"data" jsonb,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "obligations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"payee_id" uuid NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"due_date" date NOT NULL,
	"recurrence" "recurrence" NOT NULL,
	"reference" text,
	"category" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payees" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" "payee_kind" NOT NULL,
	"account_enc" text NOT NULL,
	"account_hash" text NOT NULL,
	"country" text NOT NULL,
	"currency" text NOT NULL,
	"status" "payee_status" DEFAULT 'COOLING' NOT NULL,
	"verified_at" timestamp with time zone,
	"cooling_until" timestamp with time zone,
	"replaces_payee_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"approval_id" uuid NOT NULL,
	"rail" "rail" NOT NULL,
	"rail_ref" text,
	"status" "payment_status" NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"user_id" uuid NOT NULL,
	"proposal_id" uuid NOT NULL,
	"home_amount_minor" bigint NOT NULL,
	"home_currency" text NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"reason_codes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "placeholder_maps" (
	"conversation_id" text NOT NULL,
	"placeholder" text NOT NULL,
	"kind" text NOT NULL,
	"real_ref" text NOT NULL,
	CONSTRAINT "placeholder_maps_conversation_id_placeholder_pk" PRIMARY KEY("conversation_id","placeholder")
);
--> statement-breakpoint
CREATE TABLE "profiles" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"incomes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"notification_mode" "notification_mode" DEFAULT 'EACH' NOT NULL,
	"reserve_rules" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"caps" jsonb,
	"base_rules" jsonb,
	"base_rules_hash" text,
	"base_rules_assertion" jsonb,
	"base_rules_signed_at" timestamp with time zone,
	"bank_profile_id" bigint,
	"stripe_cardholder_id" text
);
--> statement-breakpoint
CREATE TABLE "proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"created_by" "proposal_created_by" NOT NULL,
	"draft" jsonb NOT NULL,
	"decision" "decision" NOT NULL,
	"reason_codes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"risk_score" double precision NOT NULL,
	"canonical_order" jsonb,
	"order_hash" text,
	"status" "proposal_status" NOT NULL,
	"category" text NOT NULL,
	"obligation_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rule_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"before" jsonb NOT NULL,
	"after" jsonb NOT NULL,
	"direction" "rule_change_direction" NOT NULL,
	"assertion" jsonb,
	"change_hash" text NOT NULL,
	"effective_at" timestamp with time zone,
	"applied_at" timestamp with time zone,
	"canceled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"source" "transaction_source" NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"merchant_raw" text NOT NULL,
	"merchant_norm" text NOT NULL,
	"mcc" text,
	"amount_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"card_id" uuid,
	"home_amount_minor" bigint,
	"rate_used" double precision,
	"rate_date" date,
	"settled_amount_minor" bigint,
	"settled_currency" text,
	"fee_home_minor" bigint,
	"category" text,
	"dedupe_key" text,
	"merged_into_id" uuid,
	"status" "transaction_status" DEFAULT 'PENDING' NOT NULL,
	"payment_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "used_nonces" (
	"nonce" text PRIMARY KEY NOT NULL,
	"used_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"display_name" text NOT NULL,
	"home_currency" text DEFAULT 'KZT' NOT NULL,
	"region" "region" DEFAULT 'EU' NOT NULL,
	"preset" "preset" DEFAULT 'ASK_ME' NOT NULL,
	"money_mode" "money_mode" DEFAULT 'PAY_IN_PLACE' NOT NULL,
	"overrides" jsonb DEFAULT '{"agentAutonomy":null,"paymentPolicy":null,"moneyMode":null}'::jsonb NOT NULL,
	"frozen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webauthn_credentials_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"credential_id" text NOT NULL,
	"public_key" text NOT NULL,
	"counter" bigint DEFAULT 0 NOT NULL,
	"transports" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webauthn_credentials_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"credential_id" text NOT NULL,
	"public_key" text NOT NULL,
	"counter" bigint DEFAULT 0 NOT NULL,
	"transports" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"conversation_id" text,
	"filename" text,
	"media_type" text NOT NULL,
	"data_b64" text NOT NULL,
	"kind" text,
	"reader_result" jsonb,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"seq" integer NOT NULL,
	"message" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "merchant_category_memory" (
	"user_id" uuid NOT NULL,
	"merchant_norm" text NOT NULL,
	"category" text NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "merchant_category_memory_user_id_merchant_norm_pk" PRIMARY KEY("user_id","merchant_norm")
);
--> statement-breakpoint
CREATE TABLE "onboarding_drafts" (
	"conversation_id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"draft" jsonb NOT NULL,
	"complete" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_proposal_id_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_fee_profiles" ADD CONSTRAINT "card_fee_profiles_card_id_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cards" ADD CONSTRAINT "cards_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issued_cards" ADD CONSTRAINT "issued_cards_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mandates" ADD CONSTRAINT "mandates_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "obligations" ADD CONSTRAINT "obligations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "obligations" ADD CONSTRAINT "obligations_payee_id_payees_id_fk" FOREIGN KEY ("payee_id") REFERENCES "public"."payees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payees" ADD CONSTRAINT "payees_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rule_changes" ADD CONSTRAINT "rule_changes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_card_id_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."cards"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webauthn_credentials_payments" ADD CONSTRAINT "webauthn_credentials_payments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webauthn_credentials_rules" ADD CONSTRAINT "webauthn_credentials_rules_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_documents" ADD CONSTRAINT "agent_documents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_messages" ADD CONSTRAINT "agent_messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_category_memory" ADD CONSTRAINT "merchant_category_memory_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_drafts" ADD CONSTRAINT "onboarding_drafts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "approvals_proposal_idx" ON "approvals" USING btree ("proposal_id");--> statement-breakpoint
CREATE INDEX "mandates_user_idx" ON "mandates" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "notifications_user_idx" ON "notifications" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "obligations_user_due_idx" ON "obligations" USING btree ("user_id","due_date");--> statement-breakpoint
CREATE INDEX "payees_user_idx" ON "payees" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "payments_user_created_idx" ON "payments" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "payments_rail_ref_idx" ON "payments" USING btree ("rail_ref");--> statement-breakpoint
CREATE INDEX "proposals_user_idx" ON "proposals" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "proposals_obligation_idx" ON "proposals" USING btree ("obligation_id");--> statement-breakpoint
CREATE INDEX "rule_changes_user_idx" ON "rule_changes" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "transactions_user_occurred_idx" ON "transactions" USING btree ("user_id","occurred_at");--> statement-breakpoint
CREATE INDEX "transactions_dedupe_idx" ON "transactions" USING btree ("dedupe_key");--> statement-breakpoint
CREATE UNIQUE INDEX "webauthn_credentials_payments_cred_uq" ON "webauthn_credentials_payments" USING btree ("credential_id");--> statement-breakpoint
CREATE UNIQUE INDEX "webauthn_credentials_rules_cred_uq" ON "webauthn_credentials_rules" USING btree ("credential_id");--> statement-breakpoint
CREATE INDEX "agent_documents_user_idx" ON "agent_documents" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "agent_messages_conv_idx" ON "agent_messages" USING btree ("conversation_id","seq");