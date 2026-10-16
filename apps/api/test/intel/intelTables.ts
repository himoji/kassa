/*
 * The schema.intel.ts tables for PGlite tests, generated with drizzle-kit from
 * schema.ts + schema.intel.ts. Idempotent: becomes a no-op once the migrations include
 * schema.intel.ts.
 */
import { sql } from "drizzle-orm";

import type { Db } from "../../src/db/client.ts";

export const INTEL_TABLES_SQL: string[] = [
  "CREATE TABLE IF NOT EXISTS \"agent_documents\" (\n\t\"id\" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,\n\t\"user_id\" uuid NOT NULL,\n\t\"conversation_id\" text,\n\t\"filename\" text,\n\t\"media_type\" text NOT NULL,\n\t\"data_b64\" text NOT NULL,\n\t\"kind\" text,\n\t\"reader_result\" jsonb,\n\t\"created_at\" timestamp with time zone NOT NULL\n)",
  "CREATE TABLE IF NOT EXISTS \"agent_messages\" (\n\t\"id\" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,\n\t\"conversation_id\" text NOT NULL,\n\t\"user_id\" uuid NOT NULL,\n\t\"channel\" text NOT NULL,\n\t\"seq\" integer NOT NULL,\n\t\"message\" jsonb NOT NULL,\n\t\"created_at\" timestamp with time zone NOT NULL\n)",
  "CREATE TABLE IF NOT EXISTS \"merchant_category_memory\" (\n\t\"user_id\" uuid NOT NULL,\n\t\"merchant_norm\" text NOT NULL,\n\t\"category\" text NOT NULL,\n\t\"updated_at\" timestamp with time zone NOT NULL,\n\tCONSTRAINT \"merchant_category_memory_user_id_merchant_norm_pk\" PRIMARY KEY(\"user_id\",\"merchant_norm\")\n)",
  "CREATE TABLE IF NOT EXISTS \"onboarding_drafts\" (\n\t\"conversation_id\" text PRIMARY KEY NOT NULL,\n\t\"user_id\" uuid NOT NULL,\n\t\"draft\" jsonb NOT NULL,\n\t\"complete\" boolean DEFAULT false NOT NULL,\n\t\"updated_at\" timestamp with time zone NOT NULL\n)",
  "DO $$ BEGIN ALTER TABLE \"agent_documents\" ADD CONSTRAINT \"agent_documents_user_id_users_id_fk\" FOREIGN KEY (\"user_id\") REFERENCES \"public\".\"users\"(\"id\") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$",
  "DO $$ BEGIN ALTER TABLE \"agent_messages\" ADD CONSTRAINT \"agent_messages_user_id_users_id_fk\" FOREIGN KEY (\"user_id\") REFERENCES \"public\".\"users\"(\"id\") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$",
  "DO $$ BEGIN ALTER TABLE \"merchant_category_memory\" ADD CONSTRAINT \"merchant_category_memory_user_id_users_id_fk\" FOREIGN KEY (\"user_id\") REFERENCES \"public\".\"users\"(\"id\") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$",
  "DO $$ BEGIN ALTER TABLE \"onboarding_drafts\" ADD CONSTRAINT \"onboarding_drafts_user_id_users_id_fk\" FOREIGN KEY (\"user_id\") REFERENCES \"public\".\"users\"(\"id\") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$",
  "CREATE INDEX IF NOT EXISTS \"agent_documents_user_idx\" ON \"agent_documents\" USING btree (\"user_id\")",
  "CREATE INDEX IF NOT EXISTS \"agent_messages_conv_idx\" ON \"agent_messages\" USING btree (\"conversation_id\",\"seq\")",
];

export async function ensureIntelTables(db: Db): Promise<void> {
  for (const stmt of INTEL_TABLES_SQL) await db.execute(sql.raw(stmt));
}
