import { SQL } from "bun";
const db = new SQL(process.env["OWN_SUPABASE_DB_URL"]!);

// Multi-engine execution: one row per configured execution provider.
await db`
CREATE TABLE IF NOT EXISTS public.execution_engines (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  provider text NOT NULL DEFAULT 'PISTON',
  "baseUrl" text NOT NULL DEFAULT '',
  "apiKey" text NOT NULL DEFAULT '',
  enabled boolean NOT NULL DEFAULT true,
  priority integer NOT NULL DEFAULT 1,
  "timeoutMs" integer NOT NULL DEFAULT 20000,
  "supportedLanguages" text NOT NULL DEFAULT '["C"]',
  "healthStatus" text NOT NULL DEFAULT 'UNKNOWN',
  "healthDetail" text NOT NULL DEFAULT '',
  "lastHealthCheck" timestamptz,
  "lastLatencyMs" integer NOT NULL DEFAULT 0,
  "requestCount" integer NOT NULL DEFAULT 0,
  "successCount" integer NOT NULL DEFAULT 0,
  "failureCount" integer NOT NULL DEFAULT 0,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now()
)`;
await db`GRANT ALL ON public.execution_engines TO service_role`;
await db`ALTER TABLE public.execution_engines ENABLE ROW LEVEL SECURITY`;

// One row per execution attempt, for monitoring and idempotent scoring.
await db`
CREATE TABLE IF NOT EXISTS public.execution_records (
  id uuid PRIMARY KEY,
  "engineId" uuid,
  provider text NOT NULL DEFAULT '',
  "executionId" text NOT NULL DEFAULT '',
  "submissionId" text,
  "studentId" text,
  "problemId" text,
  kind text NOT NULL DEFAULT 'RUN',
  attempt integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'INTERNAL_ERROR',
  "latencyMs" integer NOT NULL DEFAULT 0,
  uncertain boolean NOT NULL DEFAULT false,
  detail text NOT NULL DEFAULT '',
  "createdAt" timestamptz NOT NULL DEFAULT now()
)`;
await db`GRANT ALL ON public.execution_records TO service_role`;
await db`ALTER TABLE public.execution_records ENABLE ROW LEVEL SECURITY`;
await db`CREATE INDEX IF NOT EXISTS execution_records_created_idx ON public.execution_records ("createdAt" DESC)`;

// Router mode lives with the other event settings.
await db`ALTER TABLE public.event_settings ADD COLUMN IF NOT EXISTS "executionMode" text NOT NULL DEFAULT 'AUTO_FAILOVER'`;

// Seed the existing Piston configuration as engine #1 so nothing regresses.
const existing = await db`SELECT count(*)::int AS n FROM public.execution_engines`;
if (existing[0].n === 0) {
  const s = await db`SELECT "pistonBaseUrl", "pistonEnabled", "pistonTimeoutMs" FROM public.event_settings LIMIT 1`;
  const row = s[0] ?? {};
  await db`INSERT INTO public.execution_engines
    (id, name, provider, "baseUrl", enabled, priority, "timeoutMs", "supportedLanguages")
    VALUES (gen_random_uuid(), 'Piston', 'PISTON', ${row.pistonBaseUrl ?? ""}, ${row.pistonEnabled ?? true}, 1,
            ${row.pistonTimeoutMs ?? 20000}, ${'["C","CPP","JAVA","PYTHON","JAVASCRIPT"]'})`;
}

console.log("ddl6 ok", (await db`SELECT id, name, provider, priority FROM public.execution_engines ORDER BY priority`));
await db.end();
