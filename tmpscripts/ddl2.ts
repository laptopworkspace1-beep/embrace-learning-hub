import { SQL } from "bun";
const db = new SQL(process.env["OWN_SUPABASE_DB_URL"]!);
// Round 2 additive columns — no destructive changes, no data loss.
await db`ALTER TABLE public.bug_definitions ADD COLUMN IF NOT EXISTS "orderNo" integer NOT NULL DEFAULT 1`;
await db`ALTER TABLE public.bug_definitions ADD COLUMN IF NOT EXISTS "isActive" boolean NOT NULL DEFAULT true`;
await db`ALTER TABLE public.debugging_problems ADD COLUMN IF NOT EXISTS "starterCode" text NOT NULL DEFAULT ''`;
await db`ALTER TABLE public.debugging_problems ADD COLUMN IF NOT EXISTS "solutionCode" text NOT NULL DEFAULT ''`;
await db`ALTER TABLE public.debugging_problems ADD COLUMN IF NOT EXISTS "timeLimitSec" integer NOT NULL DEFAULT 2`;
await db`ALTER TABLE public.debugging_problems ADD COLUMN IF NOT EXISTS "memoryLimitMb" integer NOT NULL DEFAULT 128`;
await db`CREATE INDEX IF NOT EXISTS "bug_awards_studentId_problemId_idx" ON public.bug_awards ("studentId","problemId")`;
await db`CREATE INDEX IF NOT EXISTS "bug_definitions_problemId_orderNo_idx" ON public.bug_definitions ("problemId","orderNo")`;
console.log("round2 ddl done");
await db.end();
