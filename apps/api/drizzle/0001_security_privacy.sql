CREATE TABLE "user_keys" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"wrapped_dek" text,
	"kek_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"shredded_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "placeholder_maps" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "ai_consent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "restricted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "erased_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "user_keys" ADD CONSTRAINT "user_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- PCI DSS 3.5.1: card placeholders stored before this migration held the full PAN; keep only the last 4.
UPDATE "placeholder_maps" SET "real_ref" = 'pan:legacy:' || right("real_ref", 4) WHERE "kind" = 'CARD' AND "real_ref" ~ '^[0-9]{12,19}$';
