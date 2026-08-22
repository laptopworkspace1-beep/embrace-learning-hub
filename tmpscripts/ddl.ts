import { SQL } from "bun";
const db = new SQL(process.env["OWN_SUPABASE_DB_URL"]!);
// 1. additive enum value for the in-platform JS runner
try { await db`ALTER TYPE "ProgrammingLanguage" ADD VALUE IF NOT EXISTS 'JAVASCRIPT'`; console.log("enum ok"); } catch(e){ console.log("enum", String(e).slice(0,150)); }
// 2. deterministic bug detection pattern (admin-configured), additive + nullable
await db`ALTER TABLE public.bug_definitions ADD COLUMN IF NOT EXISTS "fixPattern" text`;
await db`ALTER TABLE public.bug_definitions ADD COLUMN IF NOT EXISTS "mustNotMatch" text`;
// 3. programming submissions: durable counters alongside resultJson
await db`ALTER TABLE public.programming_submissions ADD COLUMN IF NOT EXISTS "passedTests" integer NOT NULL DEFAULT 0`;
await db`ALTER TABLE public.programming_submissions ADD COLUMN IF NOT EXISTS "totalTests" integer NOT NULL DEFAULT 0`;
await db`ALTER TABLE public.programming_submissions ADD COLUMN IF NOT EXISTS "executionMs" integer NOT NULL DEFAULT 0`;
// 4. debugging submissions: persisted awarded score per submission
await db`ALTER TABLE public.debugging_submissions ADD COLUMN IF NOT EXISTS score integer NOT NULL DEFAULT 0`;
await db`ALTER TABLE public.debugging_submissions ADD COLUMN IF NOT EXISTS message text NOT NULL DEFAULT ''`;
// 5. round_progress server clock
await db`ALTER TABLE public.round_progress ADD COLUMN IF NOT EXISTS "startedAt" timestamp`;
await db`ALTER TABLE public.round_progress ADD COLUMN IF NOT EXISTS "endsAt" timestamp`;
// 6. students: generated student code is on users.studentId (unique) -> nothing to add
console.log("ddl done");
await db.end();
