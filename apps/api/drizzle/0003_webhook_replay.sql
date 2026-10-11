CREATE TABLE "webhook_seen_signatures" (
	"sig_hash" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"signed_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "webhook_seen_signatures_signed_at_idx" ON "webhook_seen_signatures" USING btree ("signed_at");