import { SQL } from "bun";
const db = new SQL(process.env["OWN_SUPABASE_DB_URL"]!);

// Admin-configurable Round 3 language allow-list (JSON array of platform language codes).
await db`ALTER TABLE public.event_settings ADD COLUMN IF NOT EXISTS "round3Languages" text NOT NULL DEFAULT '["C"]'`;
await db`UPDATE public.event_settings SET "round3Languages" = '["C"]' WHERE COALESCE("round3Languages", '') = ''`;

console.log("ddl5 ok");
await db.end();
