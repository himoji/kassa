CREATE TABLE "obligation_settlements" (
	"obligation_id" uuid NOT NULL,
	"period" date NOT NULL,
	"user_id" uuid NOT NULL,
	"proposal_id" uuid NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "obligation_settlements_obligation_id_period_pk" PRIMARY KEY("obligation_id","period")
);
--> statement-breakpoint
ALTER TABLE "obligation_settlements" ADD CONSTRAINT "obligation_settlements_obligation_id_obligations_id_fk" FOREIGN KEY ("obligation_id") REFERENCES "public"."obligations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "obligation_settlements" ADD CONSTRAINT "obligation_settlements_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "obligation_settlements" ADD CONSTRAINT "obligation_settlements_proposal_id_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "obligation_settlements_proposal_uq" ON "obligation_settlements" USING btree ("proposal_id");--> statement-breakpoint
-- Backfill (B4): one settlement per (obligation, due date) for live proposals created before this table existed;
-- an executed one wins over a pending one, the earliest wins otherwise; failed / canceled payments do not settle.
INSERT INTO "obligation_settlements" ("obligation_id", "period", "user_id", "proposal_id", "status", "created_at", "updated_at")
SELECT DISTINCT ON (p."obligation_id", (p."draft"->>'dueDate'))
  p."obligation_id", (p."draft"->>'dueDate')::date, p."user_id", p."id",
  CASE WHEN p."status" = 'EXECUTED' THEN 'PAID' ELSE 'PENDING' END, p."created_at", p."updated_at"
FROM "proposals" p
JOIN "obligations" o ON o."id" = p."obligation_id"
WHERE p."draft"->>'dueDate' IS NOT NULL
  AND p."status" IN ('PENDING_APPROVAL', 'APPROVED', 'EXECUTED')
  AND NOT EXISTS (SELECT 1 FROM "payments" pay WHERE pay."proposal_id" = p."id" AND pay."status" IN ('FAILED', 'CANCELED'))
ORDER BY p."obligation_id", (p."draft"->>'dueDate'), (p."status" = 'EXECUTED') DESC, p."created_at"
ON CONFLICT DO NOTHING;
