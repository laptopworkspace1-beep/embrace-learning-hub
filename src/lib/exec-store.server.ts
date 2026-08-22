/**
 * Durable storage for the execution-engine layer.
 *
 * Engine configuration, execution records and status-change events all live in
 * PostgreSQL (the event project's own database) — never in localStorage and
 * never in module memory. API keys stay in this server-only module; the admin
 * projection deliberately exposes only `apiKeySet`.
 */
import {
  normalizeProvider,
  parseLanguageList,
  type EngineHealth,
  type EngineSummary,
  type ExecutionMode,
  type Language,
  type NormalizedStatus,
  type Provider,
  normalizeExecutionMode,
} from "./exec-engines";
import { getConfig } from "./app-config.server";
import { ddlAlreadyApplied, forgetDdl, markDdlApplied, requestPg, type PgClient } from "./pg-request.server";

async function databaseUrl(): Promise<string> {
  const fromConfig = (await getConfig("OWN_SUPABASE_DB_URL")) ?? "";
  const url = (fromConfig || process.env["OWN_SUPABASE_DB_URL"] || "").trim();
  if (!url) throw new Error("The application is not connected to its database yet.");
  return url;
}

/**
 * Connections are request-scoped: a socket opened for one student's request is
 * never reused by another request handler (Cloudflare Workers forbid that).
 */
function pool(url: string): PgClient {
  return requestPg(url);
}


const DDL = `
create schema if not exists codearena_private;

create table if not exists codearena_private.execution_engines (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  provider text not null,
  base_url text not null default '',
  api_key text not null default '',
  enabled boolean not null default true,
  priority integer not null default 1,
  timeout_ms integer not null default 20000,
  supported_languages jsonb not null default '["C"]'::jsonb,
  health_status text not null default 'UNKNOWN',
  health_detail text not null default '',
  last_health_check timestamptz,
  last_latency_ms integer not null default 0,
  request_count integer not null default 0,
  success_count integer not null default 0,
  failure_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists codearena_private.execution_records (
  id uuid primary key default gen_random_uuid(),
  execution_id text not null,
  submission_id text,
  engine_id uuid,
  engine_name text not null default '',
  provider text not null,
  purpose text not null default 'RUN',
  attempt integer not null default 1,
  language text not null default '',
  status text not null,
  latency_ms integer not null default 0,
  uncertain boolean not null default false,
  detail text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists execution_records_created_idx on codearena_private.execution_records (created_at desc);
create index if not exists execution_records_execution_idx on codearena_private.execution_records (execution_id);

create table if not exists codearena_private.execution_engine_events (
  id uuid primary key default gen_random_uuid(),
  engine_id uuid,
  engine_name text not null default '',
  provider text not null default '',
  from_status text not null default '',
  to_status text not null default '',
  message text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists execution_engine_events_created_idx on codearena_private.execution_engine_events (created_at desc);

create table if not exists codearena_private.execution_settings (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

-- Separate API reachability from real execution capability.
alter table codearena_private.execution_engines
  add column if not exists api_health text not null default 'UNKNOWN';
alter table codearena_private.execution_engines
  add column if not exists execution_health text not null default 'UNKNOWN';
alter table codearena_private.execution_engines
  add column if not exists last_error text not null default '';
`;

/**
 * Applies the idempotent DDL once per isolate. Only a plain string key is
 * remembered across requests — never a promise or a client, both of which
 * would carry request-scoped I/O into another request.
 */
async function ensureSchema(): Promise<PgClient> {
  const url = await databaseUrl();
  const client = pool(url);
  if (!ddlAlreadyApplied(url)) {
    try {
      await client.unsafe(DDL);
      markDdlApplied(url);
    } catch (error) {
      forgetDdl(url);
      throw error;
    }
  }
  return client;
}


/* ------------------------------------------------------------------ */
/* Engine records                                                      */
/* ------------------------------------------------------------------ */

/** Full engine record, including the secret. Server-side only. */
export type EngineRecord = EngineSummary & { apiKey: string };

function toRecord(row: Record<string, unknown>): EngineRecord {
  const provider = normalizeProvider(row["provider"]);
  const apiKey = String(row["api_key"] ?? "");
  const health = String(row["health_status"] ?? "UNKNOWN").toUpperCase() as EngineHealth;
  const apiHealth = String(row["api_health"] ?? health).toUpperCase() as EngineHealth;
  const executionHealth = String(row["execution_health"] ?? "UNKNOWN").toUpperCase() as EngineHealth;
  const enabled = Boolean(row["enabled"]);
  return {
    id: String(row["id"]),
    name: String(row["name"] ?? provider),
    provider,
    baseUrl: String(row["base_url"] ?? ""),
    apiKey,
    apiKeySet: apiKey.length > 0,
    enabled,
    priority: Number(row["priority"] ?? 1),
    timeoutMs: Number(row["timeout_ms"] ?? 20_000),
    supportedLanguages: parseLanguageList(row["supported_languages"]),
    healthStatus: enabled ? health : "DISABLED",
    healthDetail: String(row["health_detail"] ?? ""),
    apiHealth: enabled ? apiHealth : "DISABLED",
    executionHealth: enabled ? executionHealth : "DISABLED",
    lastError: String(row["last_error"] ?? ""),

    lastHealthCheck: row["last_health_check"] ? new Date(String(row["last_health_check"])).toISOString() : null,
    lastLatencyMs: Number(row["last_latency_ms"] ?? 0),
    requestCount: Number(row["request_count"] ?? 0),
    successCount: Number(row["success_count"] ?? 0),
    failureCount: Number(row["failure_count"] ?? 0),
    createdAt: new Date(String(row["created_at"] ?? new Date())).toISOString(),
    updatedAt: new Date(String(row["updated_at"] ?? new Date())).toISOString(),
  };
}

/** Strips the secret before anything reaches the browser. */
export function toSummary(record: EngineRecord): EngineSummary {
  const { apiKey: _apiKey, ...summary } = record;
  return summary;
}

export async function listEngines(): Promise<EngineRecord[]> {
  const client = await ensureSchema();
  await seedFromLegacySettings(client);
  const rows = await client.unsafe(
    "select * from codearena_private.execution_engines order by priority asc, created_at asc",
  );
  return rows.map(toRecord);
}

export async function getEngine(id: string): Promise<EngineRecord | null> {
  const client = await ensureSchema();
  const rows = await client.unsafe("select * from codearena_private.execution_engines where id = $1", [id]);
  return rows[0] ? toRecord(rows[0]) : null;
}

export type EngineInput = {
  name: string;
  provider: Provider;
  baseUrl: string;
  apiKey?: string | null;
  enabled: boolean;
  priority: number;
  timeoutMs: number;
  supportedLanguages: Language[];
};

export async function createEngine(input: EngineInput): Promise<EngineRecord> {
  const client = await ensureSchema();
  const rows = await client.unsafe(
    `insert into codearena_private.execution_engines
       (name, provider, base_url, api_key, enabled, priority, timeout_ms, supported_languages)
     values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
     returning *`,
    [
      input.name,
      input.provider,
      input.baseUrl,
      input.apiKey ?? "",
      input.enabled,
      input.priority,
      input.timeoutMs,
      JSON.stringify(input.supportedLanguages),
    ],
  );
  invalidateEngineCache();
  return toRecord(rows[0]!);
}

/**
 * Updates an engine. `apiKey` is only written when a new value is supplied, so
 * an existing secret is never wiped by a form that cannot read it back.
 */
export async function updateEngine(
  id: string,
  patch: Partial<EngineInput> & { apiKey?: string | null },
): Promise<EngineRecord | null> {
  const client = await ensureSchema();
  const sets: string[] = [];
  const params: unknown[] = [];
  const push = (sql: string, value: unknown) => {
    params.push(value);
    sets.push(`${sql} = $${params.length}`);
  };
  if (patch.name !== undefined) push("name", patch.name);
  if (patch.provider !== undefined) push("provider", patch.provider);
  if (patch.baseUrl !== undefined) push("base_url", patch.baseUrl);
  if (patch.apiKey) push("api_key", patch.apiKey);
  if (patch.enabled !== undefined) push("enabled", patch.enabled);
  if (patch.priority !== undefined) push("priority", patch.priority);
  if (patch.timeoutMs !== undefined) push("timeout_ms", patch.timeoutMs);
  if (patch.supportedLanguages !== undefined) {
    params.push(JSON.stringify(patch.supportedLanguages));
    sets.push(`supported_languages = $${params.length}::jsonb`);
  }
  sets.push("updated_at = now()");
  params.push(id);
  const rows = await client.unsafe(
    `update codearena_private.execution_engines set ${sets.join(", ")} where id = $${params.length} returning *`,
    params,
  );
  invalidateEngineCache();
  return rows[0] ? toRecord(rows[0]) : null;
}

export async function deleteEngine(id: string): Promise<boolean> {
  const client = await ensureSchema();
  const rows = await client.unsafe(
    "delete from codearena_private.execution_engines where id = $1 returning id",
    [id],
  );
  invalidateEngineCache();
  return rows.length > 0;
}

export async function saveHealth(
  id: string,
  health: {
    status: EngineHealth;
    detail: string;
    latencyMs: number;
    apiHealth?: EngineHealth;
    executionHealth?: EngineHealth;
    lastError?: string;
  },
): Promise<void> {
  const client = await ensureSchema();
  await client.unsafe(
    `update codearena_private.execution_engines
        set health_status = $1, health_detail = $2, last_latency_ms = $3,
            api_health = $5, execution_health = $6, last_error = $7,
            last_health_check = now(), updated_at = now()
      where id = $4`,
    [
      health.status,
      health.detail.slice(0, 1000),
      Math.max(0, Math.round(health.latencyMs)),
      id,
      health.apiHealth ?? health.status,
      health.executionHealth ?? health.status,
      (health.lastError ?? "").slice(0, 1000),
    ],
  );
  invalidateEngineCache();
}


export async function recordEngineOutcome(
  id: string,
  outcome: { success: boolean; latencyMs: number },
): Promise<void> {
  const client = await ensureSchema();
  await client.unsafe(
    `update codearena_private.execution_engines
        set request_count = request_count + 1,
            success_count = success_count + $1,
            failure_count = failure_count + $2,
            last_latency_ms = $3,
            updated_at = now()
      where id = $4`,
    [outcome.success ? 1 : 0, outcome.success ? 0 : 1, Math.max(0, Math.round(outcome.latencyMs)), id],
  );
  invalidateEngineCache();
}

/* ------------------------------------------------------------------ */
/* Execution records                                                   */
/* ------------------------------------------------------------------ */

export type ExecutionRecordInput = {
  executionId: string;
  submissionId?: string | null;
  engineId?: string | null;
  engineName?: string;
  provider: Provider;
  purpose?: "RUN" | "SUBMIT" | "HEALTH" | "TEST";
  attempt: number;
  language: string;
  status: NormalizedStatus;
  latencyMs: number;
  uncertain?: boolean;
  detail?: string;
};

export async function writeExecutionRecord(input: ExecutionRecordInput): Promise<void> {
  try {
    const client = await ensureSchema();
    await client.unsafe(
      `insert into codearena_private.execution_records
         (execution_id, submission_id, engine_id, engine_name, provider, purpose, attempt,
          language, status, latency_ms, uncertain, detail)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        input.executionId,
        input.submissionId ?? null,
        input.engineId ?? null,
        input.engineName ?? "",
        input.provider,
        input.purpose ?? "RUN",
        input.attempt,
        input.language,
        input.status,
        Math.max(0, Math.round(input.latencyMs)),
        input.uncertain ?? false,
        String(input.detail ?? "").slice(0, 1000),
      ],
    );
  } catch (err) {
    // Telemetry must never break a student's run.
    console.error("[execution] could not persist execution record", err);
  }
}

export type ExecutionStats = {
  total: number;
  successful: number;
  failed: number;
  averageLatencyMs: number;
};

export async function readExecutionStats(): Promise<ExecutionStats> {
  const client = await ensureSchema();
  const rows = await client.unsafe(
    `select count(*)::int as total,
            count(*) filter (where status = 'ACCEPTED')::int as accepted,
            count(*) filter (where status in ('EXECUTION_SERVICE_UNAVAILABLE','INTERNAL_ERROR'))::int as failed,
            coalesce(avg(latency_ms), 0)::int as avg_latency
       from codearena_private.execution_records
      where purpose in ('RUN','SUBMIT')`,
  );
  const row = rows[0] ?? {};
  const total = Number(row["total"] ?? 0);
  const failed = Number(row["failed"] ?? 0);
  return {
    total,
    successful: Math.max(0, total - failed),
    failed,
    averageLatencyMs: Number(row["avg_latency"] ?? 0),
  };
}

/* ------------------------------------------------------------------ */
/* Status-change events (pushed to the admin dashboard)                */
/* ------------------------------------------------------------------ */

export type EngineEvent = {
  id: string;
  engineId: string | null;
  engineName: string;
  provider: string;
  fromStatus: string;
  toStatus: string;
  message: string;
  createdAt: string;
};

export async function writeEngineEvent(event: Omit<EngineEvent, "id" | "createdAt">): Promise<void> {
  try {
    const client = await ensureSchema();
    await client.unsafe(
      `insert into codearena_private.execution_engine_events
         (engine_id, engine_name, provider, from_status, to_status, message)
       values ($1,$2,$3,$4,$5,$6)`,
      [
        event.engineId,
        event.engineName,
        event.provider,
        event.fromStatus,
        event.toStatus,
        event.message.slice(0, 500),
      ],
    );
  } catch (err) {
    console.error("[execution] could not persist engine event", err);
  }
}

export async function readEngineEvents(limit = 20): Promise<EngineEvent[]> {
  const client = await ensureSchema();
  const rows = await client.unsafe(
    `select * from codearena_private.execution_engine_events order by created_at desc limit $1`,
    [Math.min(Math.max(limit, 1), 100)],
  );
  return rows.map((row) => ({
    id: String(row["id"]),
    engineId: row["engine_id"] ? String(row["engine_id"]) : null,
    engineName: String(row["engine_name"] ?? ""),
    provider: String(row["provider"] ?? ""),
    fromStatus: String(row["from_status"] ?? ""),
    toStatus: String(row["to_status"] ?? ""),
    message: String(row["message"] ?? ""),
    createdAt: new Date(String(row["created_at"])).toISOString(),
  }));
}

/* ------------------------------------------------------------------ */
/* Routing mode                                                        */
/* ------------------------------------------------------------------ */

/**
 * Short-lived cache for the routing mode. It was read from PostgreSQL on every
 * single student run even though the value only changes when an administrator
 * edits it — and the write path below invalidates the cache immediately, so a
 * mode change still takes effect at once.
 */
let modeCache: { at: number; mode: ExecutionMode } | null = null;
const MODE_TTL_MS = 5_000;

export async function readExecutionMode(): Promise<ExecutionMode> {
  const cached = modeCache;
  if (cached && Date.now() - cached.at < MODE_TTL_MS) return cached.mode;
  try {
    const client = await ensureSchema();
    const rows = await client.unsafe(
      "select value from codearena_private.execution_settings where key = 'EXECUTION_MODE'",
    );
    const mode = normalizeExecutionMode(rows[0]?.["value"]);
    modeCache = { at: Date.now(), mode };
    return mode;
  } catch {
    return "AUTO_FAILOVER";
  }
}

export async function writeExecutionMode(mode: ExecutionMode): Promise<void> {
  const client = await ensureSchema();
  await client.unsafe(
    `insert into codearena_private.execution_settings (key, value, updated_at)
     values ('EXECUTION_MODE', $1, now())
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [mode],
  );
  modeCache = { at: Date.now(), mode };
}


/* ------------------------------------------------------------------ */
/* Cache + first-run seeding                                           */
/* ------------------------------------------------------------------ */

let cache: { at: number; engines: EngineRecord[] } | null = null;

export function invalidateEngineCache() {
  cache = null;
}

/** Short-lived cache so a burst of student runs does not hammer PostgreSQL. */
export async function cachedEngines(force = false): Promise<EngineRecord[]> {
  if (!force && cache && Date.now() - cache.at < 5_000) return cache.engines;
  const engines = await listEngines();
  cache = { at: Date.now(), engines };
  return engines;
}

let seeded = false;

/**
 * The very first read creates engine rows from the pre-existing configuration:
 * the Piston URL the administrator already saved (or PISTON_BASE_URL) and, when
 * present, JUDGE0_BASE_URL. Existing Piston behaviour therefore keeps working
 * with no manual step.
 */
async function seedFromLegacySettings(client: PgClient): Promise<void> {
  if (seeded) return;
  seeded = true;
  try {
    const existing = await client.unsafe("select count(*)::int as n from codearena_private.execution_engines");
    if (Number(existing[0]?.["n"] ?? 0) > 0) return;

    const { normalizeProviderBaseUrl } = await import("./exec-engines");
    let pistonUrl = (process.env["PISTON_BASE_URL"] ?? "").trim();
    try {
      const { ownDb } = await import("./own-db.server");
      const { data } = await ownDb().from("event_settings").select("pistonBaseUrl").limit(1);
      const saved = String((data?.[0] as Record<string, unknown> | undefined)?.["pistonBaseUrl"] ?? "").trim();
      if (saved) pistonUrl = saved;
    } catch {
      // event_settings is optional at this point.
    }
    // Judge0 is deliberately NOT seeded: the competition executes only on the
    // four Piston VMs. An administrator can still add an extra engine by hand
    // under Admin → Execution engines, but nothing auto-registers a fallback.
    await client.unsafe(
      `insert into codearena_private.execution_engines
         (name, provider, base_url, enabled, priority, timeout_ms, supported_languages)
       values
         ('Piston', 'PISTON', $1, true, 1, 20000, $2::jsonb)`,
      [
        normalizeProviderBaseUrl(pistonUrl).baseUrl,
        JSON.stringify(["C", "CPP", "JAVA", "PYTHON", "JAVASCRIPT"]),
      ],
    );
    console.info("[execution] seeded default execution engine");

  } catch (err) {
    console.error("[execution] engine seeding failed", err);
  }
}
