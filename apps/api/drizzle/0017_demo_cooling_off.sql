CREATE TABLE "demo_cooling_off" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"credential_id" text NOT NULL,
	"off_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "demo_cooling_off" ADD CONSTRAINT "demo_cooling_off_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;