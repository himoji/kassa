CREATE TABLE "demo_cooling_on" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"on_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "demo_cooling_on" ADD CONSTRAINT "demo_cooling_on_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;