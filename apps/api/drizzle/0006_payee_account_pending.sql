ALTER TABLE "payees" ALTER COLUMN "account_enc" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "payees" ALTER COLUMN "account_hash" DROP NOT NULL;