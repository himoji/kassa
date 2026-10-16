CREATE TABLE "rate_limit_counters" (
	"key" text PRIMARY KEY NOT NULL,
	"hits" integer NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "revoked_tokens" (
	"jti" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "rate_limit_counters_expires_idx" ON "rate_limit_counters" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "revoked_tokens_expires_idx" ON "revoked_tokens" USING btree ("expires_at");