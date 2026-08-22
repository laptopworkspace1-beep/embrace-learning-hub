import { SQL } from "bun";
const db = new SQL(process.env["OWN_SUPABASE_DB_URL"]!);

// Admin-configurable execution engine (Piston).
await db`ALTER TABLE public.event_settings ADD COLUMN IF NOT EXISTS "pistonEnabled" boolean NOT NULL DEFAULT true`;
await db`ALTER TABLE public.event_settings ADD COLUMN IF NOT EXISTS "pistonTimeoutMs" integer NOT NULL DEFAULT 20000`;

// Execution artefacts persisted with every submission.
for (const table of ["debugging_submissions", "programming_submissions"]) {
  await db.unsafe(`ALTER TABLE public.${table} ADD COLUMN IF NOT EXISTS "compileOutput" text NOT NULL DEFAULT ''`);
  await db.unsafe(`ALTER TABLE public.${table} ADD COLUMN IF NOT EXISTS "executionOutput" text NOT NULL DEFAULT ''`);
  await db.unsafe(`ALTER TABLE public.${table} ADD COLUMN IF NOT EXISTS "executionMs" integer NOT NULL DEFAULT 0`);
  await db.unsafe(`ALTER TABLE public.${table} ADD COLUMN IF NOT EXISTS "memoryKb" integer NOT NULL DEFAULT 0`);
}
await db`ALTER TABLE public.debugging_submissions ADD COLUMN IF NOT EXISTS language text NOT NULL DEFAULT 'C'`;

// Compile / run attempt counters (never incremented by autosave).
await db`CREATE TABLE IF NOT EXISTS public.code_attempts (
  id text PRIMARY KEY,
  "studentId" text NOT NULL,
  "problemId" text NOT NULL,
  kind text NOT NULL DEFAULT 'CODE',
  "compileAttempts" integer NOT NULL DEFAULT 0,
  "runAttempts" integer NOT NULL DEFAULT 0,
  "updatedAt" timestamp NOT NULL DEFAULT now()
)`;
await db`CREATE UNIQUE INDEX IF NOT EXISTS code_attempts_unique ON public.code_attempts ("studentId", "problemId")`;
await db`GRANT ALL ON public.code_attempts TO service_role`;

console.log("ddl4 ok");
await db.end();
