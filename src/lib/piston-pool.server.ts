/**
 * Piston node pool — the multi-VM execution layer that sits *inside* the
 * existing execution router.
 *
 *   Student browser
 *     → existing CodeArena execution API (unchanged)
 *       → ExecutionRouter (exec-router.server.ts)
 *         → PistonPool  ├── piston-vm-1
 *                       ├── piston-vm-2
 *                       └── … (configuration only, no code change)
 *         → existing engines / Judge0 fallback (unchanged)
 *
 * Nothing here is importable by the browser: node URLs, health state and load
 * counters never leave the server except through the admin server functions,
 * which return plain serializable summaries only.
 *
 * Cloudflare-safe: every PostgreSQL client is request-scoped and every HTTP
 * body is consumed inside the call that created it.
 */
import { getConfig } from "./app-config.server";
import { ddlAlreadyApplied, forgetDdl, markDdlApplied, requestPg, type PgClient } from "./pg-request.server";
import {
  normalizeProviderBaseUrl,
  isEgressBlockedPort,
  describeEgressPortProblem,
  isDirectIpHost,
  describeDirectIpProblem,
} from "./exec-engines";

import {
  ExecutionServiceError,
  LanguageUnavailableError,
  providerJson,
  type ExecInput,
  type ExecResult,
} from "./exec-error.server";
import { pistonAdapter } from "./engine-adapters.server";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export type NodeHealth = "ONLINE" | "UNHEALTHY" | "OFFLINE" | "DISABLED";

export type PistonNode = {
  id: string;
  nodeId: string;
  url: string;
  enabled: boolean;
  maxConcurrentJobs: number;
  healthStatus: NodeHealth;
  lastHealthCheck: string | null;
  lastError: string;
  failureCount: number;
  currentLoad: number;
  totalExecutions: number;
  totalFailures: number;
  timeoutMs: number;
  createdAt: string;
  updatedAt: string;
};

export type PistonExecutionLog = {
  id: string;
  submissionId: string | null;
  studentId: string | null;
  roundId: string | null;
  assignedNodeId: string;
  actualNodeId: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  /** Time this run spent waiting for a free capacity slot before it started. */
  queueMs: number;
  retryCount: number;
  status: string;
  failureReason: string;
};


/* ------------------------------------------------------------------ */
/* Storage                                                             */
/* ------------------------------------------------------------------ */

async function databaseUrl(): Promise<string> {
  const fromConfig = (await getConfig("OWN_SUPABASE_DB_URL")) ?? "";
  const url = (fromConfig || process.env["OWN_SUPABASE_DB_URL"] || "").trim();
  if (!url) throw new Error("The application is not connected to its database yet.");
  return url;
}

const DDL = `
create schema if not exists codearena_private;

create table if not exists codearena_private.piston_nodes (
  id uuid primary key default gen_random_uuid(),
  node_id text not null unique,
  url text not null,
  enabled boolean not null default true,
  max_concurrent_jobs integer not null default 20,
  timeout_ms integer not null default 20000,
  health_status text not null default 'OFFLINE',
  last_health_check timestamptz,
  last_error text not null default '',
  failure_count integer not null default 0,
  current_load integer not null default 0,
  total_executions integer not null default 0,
  total_failures integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists codearena_private.piston_assignments (
  student_id text not null,
  round_id text not null default '',
  node_id text not null,
  created_at timestamptz not null default now(),
  primary key (student_id, round_id)
);

create table if not exists codearena_private.piston_executions (
  id uuid primary key default gen_random_uuid(),
  submission_id text,
  student_id text,
  round_id text,
  assigned_node_id text not null default '',
  actual_node_id text not null default '',
  started_at timestamptz not null default now(),
  ended_at timestamptz not null default now(),
  duration_ms integer not null default 0,
  retry_count integer not null default 0,
  status text not null default '',
  failure_reason text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists piston_executions_created_idx on codearena_private.piston_executions (created_at desc);
alter table codearena_private.piston_executions add column if not exists queue_ms integer not null default 0;

-- In-flight executions: the live QUEUED/RUNNING view used by the admin event
-- dashboard and by the stuck-execution sweeper. Rows are short lived: they are
-- deleted by the same statement that records the finished run.
create table if not exists codearena_private.piston_inflight (
  id uuid primary key default gen_random_uuid(),
  node_id text not null default '',
  student_id text,
  submission_id text,
  round_id text,
  purpose text not null default '',
  state text not null default 'QUEUED',
  timeout_ms integer not null default 20000,
  queued_at timestamptz not null default now(),
  started_at timestamptz
);
create index if not exists piston_inflight_state_idx on codearena_private.piston_inflight (state, queued_at);
`;


const DDL_KEY_SUFFIX = "#piston-pool";

async function schema(): Promise<PgClient> {
  const url = await databaseUrl();
  const client = requestPg(url);
  const key = url + DDL_KEY_SUFFIX;
  if (!ddlAlreadyApplied(key)) {
    try {
      await client.unsafe(DDL);
      markDdlApplied(key);
      await seedNodes(client);
      await reconcileNodes(client);
      await repointBlockedPorts(client);
    } catch (error) {
      forgetDdl(key);
      throw error;
    }
  }
  return client;
}

function toNode(row: Record<string, unknown>): PistonNode {
  const enabled = Boolean(row["enabled"]);
  const status = String(row["health_status"] ?? "OFFLINE").toUpperCase() as NodeHealth;
  return {
    id: String(row["id"]),
    nodeId: String(row["node_id"]),
    url: String(row["url"] ?? ""),
    enabled,
    maxConcurrentJobs: Number(row["max_concurrent_jobs"] ?? 20),
    healthStatus: enabled ? status : "DISABLED",
    lastHealthCheck: row["last_health_check"] ? new Date(String(row["last_health_check"])).toISOString() : null,
    lastError: String(row["last_error"] ?? ""),
    failureCount: Number(row["failure_count"] ?? 0),
    currentLoad: Math.max(0, Number(row["current_load"] ?? 0)),
    totalExecutions: Number(row["total_executions"] ?? 0),
    totalFailures: Number(row["total_failures"] ?? 0),
    timeoutMs: Number(row["timeout_ms"] ?? 20_000),
    createdAt: new Date(String(row["created_at"] ?? new Date())).toISOString(),
    updatedAt: new Date(String(row["updated_at"] ?? new Date())).toISOString(),
  };
}

/**
 * The authoritative competition pool: exactly four Piston VMs, no other
 * execution provider. Overridable through the PISTON_NODES_JSON backend
 * variable.
 *
 * The VMs expose Piston on port 2000, but the CodeArena backend runs on a
 * serverless runtime whose outbound fetch() may only use a fixed set of ports
 * (see EGRESS_ALLOWED_HTTP_PORTS): port 2000 is refused at the network edge.
 * Each VM also answers on 8080, which is the port the backend can actually
 * dial, so the pool stores the 8080 address of the very same Piston instance.
 */
const DEFAULT_NODES = [
  { id: "piston-vm-1", url: "http://148.113.52.23:8080", enabled: true, maxConcurrentJobs: 20 },
  { id: "piston-vm-2", url: "http://148.113.52.28:8080", enabled: true, maxConcurrentJobs: 20 },
  { id: "piston-vm-3", url: "http://148.113.52.24:8080", enabled: true, maxConcurrentJobs: 20 },
  { id: "piston-vm-4", url: "http://148.113.52.39:8080", enabled: true, maxConcurrentJobs: 20 },
];


function initialNodes(): { id: string; url: string; enabled: boolean; maxConcurrentJobs: number }[] {
  const raw = (process.env["PISTON_NODES_JSON"] ?? "").trim();
  if (!raw) return DEFAULT_NODES;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.length) return DEFAULT_NODES;
    return parsed
      .map((entry: Record<string, unknown>) => ({
        id: String(entry["id"] ?? "").trim(),
        url: String(entry["url"] ?? "").trim(),
        enabled: entry["enabled"] !== false,
        maxConcurrentJobs: Math.min(Math.max(Number(entry["maxConcurrentJobs"] ?? 20) || 20, 1), 200),
      }))
      .filter((entry) => entry.id && entry.url);
  } catch {
    console.error("[piston-pool] PISTON_NODES_JSON is not valid JSON — using the built-in pool");
    return DEFAULT_NODES;
  }
}

async function seedNodes(client: PgClient): Promise<void> {
  const rows = await client.unsafe("select count(*)::int as n from codearena_private.piston_nodes");
  if (Number(rows[0]?.["n"] ?? 0) > 0) return;
  for (const node of initialNodes()) {
    const normalized = normalizeProviderBaseUrl(node.url);
    if (!normalized.baseUrl) continue;
    await client.unsafe(
      `insert into codearena_private.piston_nodes (node_id, url, enabled, max_concurrent_jobs)
       values ($1,$2,$3,$4) on conflict (node_id) do nothing`,
      [node.id, normalized.baseUrl, node.enabled, node.maxConcurrentJobs],
    );
  }
  console.info("[piston-pool] seeded initial Piston nodes");
}

/**
 * Makes sure the configured pool really contains every authoritative VM even
 * when the table was seeded earlier with a smaller pool. Missing nodes are
 * inserted; nodes that already exist keep their administrator-managed
 * settings (enabled flag, capacity, counters) untouched.
 */
async function reconcileNodes(client: PgClient): Promise<void> {
  for (const node of initialNodes()) {
    const normalized = normalizeProviderBaseUrl(node.url);
    if (!normalized.baseUrl) continue;
    const rows = await client.unsafe(
      `insert into codearena_private.piston_nodes (node_id, url, enabled, max_concurrent_jobs)
       values ($1,$2,$3,$4) on conflict (node_id) do nothing returning node_id`,
      [node.id, normalized.baseUrl, node.enabled, node.maxConcurrentJobs],
    );
    if (rows.length) console.info(`[piston-pool] added missing node ${node.id}`);
  }
}


/**
 * One-time self-heal for pools seeded before the VMs were re-exposed: the
 * hosting environment cannot dial outbound port 2000, so any node still
 * pointing there is repointed to the routable 8080 listener of the same host.
 */
async function repointBlockedPorts(client: PgClient): Promise<void> {
  try {
    const rows = await client.unsafe(
      `update codearena_private.piston_nodes
          set url = replace(url, ':2000', ':8080'),
              health_status = 'OFFLINE',
              last_error = '',
              failure_count = 0,
              updated_at = now()
        where url like '%:2000%'
        returning node_id`,
    );
    if (rows.length) {
      console.info(`[piston-pool] repointed ${rows.length} node(s) from blocked port 2000 to 8080`);
    }
  } catch (err) {
    console.error("[piston-pool] could not repoint blocked-port nodes", err);
  }
}

export async function listNodes(): Promise<PistonNode[]> {
  const client = await schema();
  const rows = await client.unsafe("select * from codearena_private.piston_nodes order by node_id asc");
  return rows.map(toNode);
}

export async function getNode(id: string): Promise<PistonNode | null> {
  const client = await schema();
  const rows = await client.unsafe("select * from codearena_private.piston_nodes where id = $1", [id]);
  return rows[0] ? toNode(rows[0]) : null;
}

export type NodeInput = {
  nodeId: string;
  url: string;
  enabled: boolean;
  maxConcurrentJobs: number;
  timeoutMs?: number;
};

/**
 * Validates an admin-supplied node address. Only http(s) is accepted, the URL
 * must parse, and loopback / link-local / metadata addresses are refused so a
 * node entry can never be turned into an SSRF probe of the backend's own
 * network namespace.
 */
export function validateNodeUrl(raw: string): { url: string; error: string | null } {
  const normalized = normalizeProviderBaseUrl(raw);
  if (normalized.problem) {
    return {
      url: "",
      error:
        normalized.problem === "local_url"
          ? "localhost / 127.0.0.1 cannot be reached from the backend. Use the VM's routable address."
          : "Enter a valid Piston API URL, for example http://203.0.113.10:8080",
    };
  }
  let host = "";
  try {
    host = new URL(normalized.baseUrl).hostname.toLowerCase();
  } catch {
    return { url: "", error: "Enter a valid Piston API URL." };
  }
  if (/^(169\.254\.|::ffff:169\.254\.)/.test(host) || host === "metadata.google.internal") {
    return { url: "", error: "Link-local and cloud metadata addresses are not allowed." };
  }
  return { url: normalized.baseUrl, error: null };
}

export async function createNode(input: NodeInput): Promise<PistonNode> {
  const client = await schema();
  const rows = await client.unsafe(
    `insert into codearena_private.piston_nodes (node_id, url, enabled, max_concurrent_jobs, timeout_ms)
     values ($1,$2,$3,$4,$5) returning *`,
    [input.nodeId, input.url, input.enabled, input.maxConcurrentJobs, input.timeoutMs ?? 20_000],
  );
  return toNode(rows[0]!);
}

export async function updateNode(id: string, patch: Partial<NodeInput>): Promise<PistonNode | null> {
  const client = await schema();
  const sets: string[] = [];
  const params: unknown[] = [];
  const push = (column: string, value: unknown) => {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  };
  if (patch.nodeId !== undefined) push("node_id", patch.nodeId);
  if (patch.url !== undefined) push("url", patch.url);
  if (patch.enabled !== undefined) push("enabled", patch.enabled);
  if (patch.maxConcurrentJobs !== undefined) push("max_concurrent_jobs", patch.maxConcurrentJobs);
  if (patch.timeoutMs !== undefined) push("timeout_ms", patch.timeoutMs);
  sets.push("updated_at = now()");
  params.push(id);
  const rows = await client.unsafe(
    `update codearena_private.piston_nodes set ${sets.join(", ")} where id = $${params.length} returning *`,
    params,
  );
  return rows[0] ? toNode(rows[0]) : null;
}

/** Removes a node. Historical execution logs keep their actualNodeId. */
export async function deleteNode(id: string): Promise<boolean> {
  const client = await schema();
  const rows = await client.unsafe("delete from codearena_private.piston_nodes where id = $1 returning node_id", [id]);
  const nodeId = rows[0] ? String(rows[0]["node_id"]) : "";
  if (nodeId) {
    // Existing students are re-assigned on their next execution; execution
    // history is intentionally left untouched.
    await client.unsafe("delete from codearena_private.piston_assignments where node_id = $1", [nodeId]);
  }
  return rows.length > 0;
}

async function saveNodeHealth(
  nodeId: string,
  health: { status: NodeHealth; error: string; resetFailures?: boolean },
): Promise<void> {
  const client = await schema();
  await client.unsafe(
    `update codearena_private.piston_nodes
        set health_status = $1,
            last_error = $2,
            failure_count = case when $3 then 0 else failure_count end,
            last_health_check = now(),
            updated_at = now()
      where node_id = $4`,
    [health.status, health.error.slice(0, 500), Boolean(health.resetFailures), nodeId],
  );
}

/**
 * Post-run bookkeeping in ONE round trip: updates the node counters/health,
 * releases the capacity slot claimed for this run and appends the execution
 * log together. These were previously separate statements, and every round
 * trip to the database adds real latency to each individual student run.
 *
 * Returns `true` when the statement committed, which also means the slot was
 * released — the caller then skips its fallback release so a slot is never
 * decremented twice and never leaked when this write fails.
 *
 * A success also refreshes `last_health_check`: a node that is actively
 * serving runs is proven healthy, so it stays out of the probe path.
 */
async function recordRun(
  nodeId: string,
  failure: string | null,
  entry: Omit<PistonExecutionLog, "id">,
  inflightId: string | null = null,
): Promise<boolean> {
  try {
    const client = await schema();
    // One statement (CTEs), not two: postgres.js sends multi-command strings
    // as prepared statements, which PostgreSQL rejects — and every extra
    // round trip adds latency to the student's run anyway. The in-flight row
    // for this run is dropped by the same statement, so the live QUEUED /
    // RUNNING view can never keep a finished execution.
    await client.unsafe(
      `with node_update as (
         update codearena_private.piston_nodes
            set total_executions = total_executions + case when $1 then 1 else 0 end,
                total_failures = total_failures + case when $1 then 0 else 1 end,
                failure_count = case when $1 then 0 else failure_count + 1 end,
                current_load = greatest(current_load - 1, 0),
                health_status = case
                                  when $1 then 'ONLINE'
                                  when failure_count + 1 >= 2 then 'UNHEALTHY'
                                  else health_status
                                end,
                last_error = $2,
                last_health_check = case when $1 then now() else last_health_check end,
                updated_at = now()
          where node_id = $3
          returning node_id
       ),
       inflight_drop as (
         delete from codearena_private.piston_inflight
          where $15::uuid is not null and id = $15::uuid
       )
       insert into codearena_private.piston_executions
         (submission_id, student_id, round_id, assigned_node_id, actual_node_id,
          started_at, ended_at, duration_ms, retry_count, status, failure_reason, queue_ms)
       select $4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$16 from node_update`,
      [
        failure === null,
        (failure ?? "").slice(0, 500),
        nodeId,
        entry.submissionId,
        entry.studentId,
        entry.roundId,
        entry.assignedNodeId,
        entry.actualNodeId,
        entry.startedAt,
        entry.endedAt,
        entry.durationMs,
        entry.retryCount,
        entry.status,
        entry.failureReason.slice(0, 500),
        inflightId,
        entry.queueMs,
      ],
    );
    return true;
  } catch (err) {
    // Telemetry must never break a student's run.
    console.error("[piston-pool] could not persist run bookkeeping", err);
    return false;
  }
}



/** Bounded concurrency: claims a slot only when the node is below capacity. */
async function acquireSlot(nodeId: string): Promise<boolean> {
  const client = await schema();
  const rows = await client.unsafe(
    `update codearena_private.piston_nodes
        set current_load = current_load + 1, updated_at = now()
      where node_id = $1 and current_load < max_concurrent_jobs
      returning node_id`,
    [nodeId],
  );
  return rows.length > 0;
}

async function releaseSlot(nodeId: string): Promise<void> {
  try {
    const client = await schema();
    await client.unsafe(
      `update codearena_private.piston_nodes
          set current_load = greatest(current_load - 1, 0), updated_at = now()
        where node_id = $1`,
      [nodeId],
    );
  } catch (err) {
    console.error("[piston-pool] could not release capacity slot", err);
  }
}

/**
 * Self-heal for capacity leaked by interrupted requests. A slot is held for at
 * most ~60s (the execution fetch budget); when the hosting runtime kills a
 * request mid-run the release in `finally` never happens and the counter stays
 * elevated forever. A node that is still full while its row has been untouched
 * for 3 minutes has provably lost those releases, so reset it and let the
 * caller retry immediately instead of queueing against a phantom load.
 */
async function reclaimLeakedSlots(nodeId: string): Promise<boolean> {
  try {
    const client = await schema();
    const rows = await client.unsafe(
      `update codearena_private.piston_nodes
          set current_load = 0,
              last_error = 'capacity reset: slots leaked by interrupted requests',
              updated_at = now()
        where node_id = $1
          and current_load >= max_concurrent_jobs
          and updated_at < now() - interval '3 minutes'
        returning node_id`,
      [nodeId],
    );
    if (rows.length) console.warn(`[piston-pool] reclaimed leaked capacity on ${nodeId}`);
    return rows.length > 0;
  } catch (err) {
    console.error("[piston-pool] could not reclaim leaked capacity", err);
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Live in-flight tracking (QUEUED / RUNNING) + stuck detection        */
/* ------------------------------------------------------------------ */

/**
 * Registers this run as in-flight. Telemetry must never break a student's run,
 * so a failure here just returns null and the run continues untracked.
 */
async function beginInflight(entry: {
  nodeId: string;
  studentId: string | null;
  submissionId: string | null;
  roundId: string | null;
  purpose: string;
  state: "QUEUED" | "RUNNING";
  timeoutMs: number;
}): Promise<string | null> {
  try {
    const client = await schema();
    const rows = await client.unsafe(
      `insert into codearena_private.piston_inflight
         (node_id, student_id, submission_id, round_id, purpose, state, timeout_ms, started_at)
       values ($1,$2,$3,$4,$5,$6,$7, case when $6 = 'RUNNING' then now() else null end)
       returning id`,
      [
        entry.nodeId,
        entry.studentId,
        entry.submissionId,
        entry.roundId,
        entry.purpose.slice(0, 40),
        entry.state,
        entry.timeoutMs,
      ],
    );
    return rows[0] ? String(rows[0]["id"]) : null;
  } catch (err) {
    console.error("[piston-pool] could not record in-flight execution", err);
    return null;
  }
}

/** Promotes a queued row to RUNNING on the node that actually accepted it. */
async function markInflightRunning(id: string | null, nodeId: string, timeoutMs: number): Promise<void> {
  if (!id) return;
  try {
    const client = await schema();
    await client.unsafe(
      `update codearena_private.piston_inflight
          set state = 'RUNNING', node_id = $2, timeout_ms = $3, started_at = now()
        where id = $1::uuid`,
      [id, nodeId, timeoutMs],
    );
  } catch (err) {
    console.error("[piston-pool] could not mark in-flight execution running", err);
  }
}

/** Removes an in-flight row when the run ended without reaching `recordRun`. */
async function dropInflight(id: string | null): Promise<void> {
  if (!id) return;
  try {
    const client = await schema();
    await client.unsafe(`delete from codearena_private.piston_inflight where id = $1::uuid`, [id]);
  } catch (err) {
    console.error("[piston-pool] could not clear in-flight execution", err);
  }
}

/** Grace added to a node's own timeout before a RUNNING row counts as stuck. */
const STUCK_GRACE_MS = 15_000;

export type StuckExecution = {
  nodeId: string;
  studentId: string | null;
  submissionId: string | null;
  ageMs: number;
};

/**
 * Sweeps executions that have been RUNNING longer than the node's configured
 * timeout plus a grace period. Such a run can no longer return a result to the
 * student (the request that owned it is gone), so it is recorded as a timeout,
 * its capacity slot is released and its live state is cleaned up. Called from
 * the admin dashboard read and from the student-facing pool entry point, so it
 * runs during the event without a separate scheduler.
 */
export async function sweepStuckExecutions(): Promise<StuckExecution[]> {
  try {
    const client = await schema();
    const rows = await client.unsafe(
      `with stuck as (
         delete from codearena_private.piston_inflight
          where state = 'RUNNING'
            and started_at is not null
            and started_at < now() - ((timeout_ms + $1) * interval '1 millisecond')
          returning id, node_id, student_id, submission_id, round_id, started_at, timeout_ms
       ),
       logged as (
         insert into codearena_private.piston_executions
           (submission_id, student_id, round_id, assigned_node_id, actual_node_id,
            started_at, ended_at, duration_ms, retry_count, status, failure_reason, queue_ms)
         select submission_id, student_id, round_id, node_id, node_id,
                started_at, now(),
                (extract(epoch from (now() - started_at)) * 1000)::int, 0,
                'TIME_LIMIT_EXCEEDED',
                'stuck execution swept: no result within the configured execution timeout', 0
           from stuck
       ),
       released as (
         update codearena_private.piston_nodes n
            set current_load = greatest(n.current_load - c.n, 0), updated_at = now()
           from (select node_id, count(*)::int as n from stuck group by node_id) c
          where n.node_id = c.node_id
       )
       select node_id, student_id, submission_id,
              (extract(epoch from (now() - started_at)) * 1000)::int as age_ms
         from stuck`,
      [STUCK_GRACE_MS],
    );
    const stuck = rows.map((row) => ({
      nodeId: String(row["node_id"] ?? ""),
      studentId: row["student_id"] ? String(row["student_id"]) : null,
      submissionId: row["submission_id"] ? String(row["submission_id"]) : null,
      ageMs: Number(row["age_ms"] ?? 0),
    }));
    for (const item of stuck) {
      console.error(
        `[piston-pool] stuck execution swept node=${item.nodeId} student=${item.studentId ?? "-"} ` +
          `submission=${item.submissionId ?? "-"} ageMs=${item.ageMs}`,
      );
    }
    return stuck;
  } catch (err) {
    console.error("[piston-pool] stuck-execution sweep failed", err);
    return [];
  }
}

const SWEEP_INTERVAL_MS = 30_000;
let lastSweep = 0;

/** Throttled sweep, safe to fire-and-forget from the student execution path. */
export async function maybeSweepStuck(): Promise<void> {
  if (Date.now() - lastSweep < SWEEP_INTERVAL_MS) return;
  lastSweep = Date.now();
  await sweepStuckExecutions().catch(() => []);
}


export type QueueStats = {
  queued: number;
  running: number;
  oldestQueuedSeconds: number;
  oldestRunningSeconds: number;
};

/** Live queue depth straight from the in-flight table. */
export async function readQueueStats(): Promise<QueueStats> {
  try {
    const client = await schema();
    const rows = await client.unsafe(
      `select
         count(*) filter (where state = 'QUEUED')::int as queued,
         count(*) filter (where state = 'RUNNING')::int as running,
         coalesce(max(extract(epoch from (now() - queued_at))) filter (where state = 'QUEUED'), 0)::int as oldest_queued,
         coalesce(max(extract(epoch from (now() - started_at))) filter (where state = 'RUNNING'), 0)::int as oldest_running
       from codearena_private.piston_inflight`,
    );
    const row = rows[0] ?? {};
    return {
      queued: Number(row["queued"] ?? 0),
      running: Number(row["running"] ?? 0),
      oldestQueuedSeconds: Number(row["oldest_queued"] ?? 0),
      oldestRunningSeconds: Number(row["oldest_running"] ?? 0),
    };
  } catch (err) {
    console.error("[piston-pool] could not read queue stats", err);
    return { queued: 0, running: 0, oldestQueuedSeconds: 0, oldestRunningSeconds: 0 };
  }
}

export type NodeExecutionStats = {
  nodeId: string;
  executions: number;
  successes: number;
  /** Infrastructure failures only — never compile/runtime/wrong-answer results. */
  infraFailures: number;
  avgDurationMs: number;
  maxDurationMs: number;
  avgQueueMs: number;
};

/**
 * Per-node execution statistics over a recent window, computed from the real
 * execution log. Participant outcomes (COMPILATION_ERROR, RUNTIME_ERROR,
 * WRONG_ANSWER, TIME_LIMIT_EXCEEDED) are successful executions from the
 * infrastructure's point of view and are never counted as failures.
 */
export async function readNodeStats(windowMinutes = 60): Promise<NodeExecutionStats[]> {
  try {
    const client = await schema();
    const rows = await client.unsafe(
      `select actual_node_id as node_id,
              count(*)::int as executions,
              count(*) filter (where status not in ('FAILED','INFRASTRUCTURE_ERROR'))::int as successes,
              count(*) filter (where status in ('FAILED','INFRASTRUCTURE_ERROR'))::int as infra_failures,
              coalesce(avg(duration_ms) filter (where status not in ('FAILED','INFRASTRUCTURE_ERROR')), 0)::int as avg_ms,
              coalesce(max(duration_ms), 0)::int as max_ms,
              coalesce(avg(queue_ms), 0)::int as avg_queue_ms
         from codearena_private.piston_executions
        where created_at > now() - ($1 * interval '1 minute')
        group by actual_node_id`,
      [Math.min(Math.max(windowMinutes, 1), 1440)],
    );
    return rows.map((row) => ({
      nodeId: String(row["node_id"] ?? ""),
      executions: Number(row["executions"] ?? 0),
      successes: Number(row["successes"] ?? 0),
      infraFailures: Number(row["infra_failures"] ?? 0),
      avgDurationMs: Number(row["avg_ms"] ?? 0),
      maxDurationMs: Number(row["max_ms"] ?? 0),
      avgQueueMs: Number(row["avg_queue_ms"] ?? 0),
    }));
  } catch (err) {
    console.error("[piston-pool] could not read node stats", err);
    return [];
  }
}


export async function readExecutionLogs(limit = 50): Promise<PistonExecutionLog[]> {
  const client = await schema();
  const rows = await client.unsafe(
    `select * from codearena_private.piston_executions order by created_at desc limit $1`,
    [Math.min(Math.max(limit, 1), 200)],
  );
  return rows.map((row) => ({
    id: String(row["id"]),
    submissionId: row["submission_id"] ? String(row["submission_id"]) : null,
    studentId: row["student_id"] ? String(row["student_id"]) : null,
    roundId: row["round_id"] ? String(row["round_id"]) : null,
    assignedNodeId: String(row["assigned_node_id"] ?? ""),
    actualNodeId: String(row["actual_node_id"] ?? ""),
    startedAt: new Date(String(row["started_at"])).toISOString(),
    endedAt: new Date(String(row["ended_at"])).toISOString(),
    queueMs: Number(row["queue_ms"] ?? 0),
    durationMs: Number(row["duration_ms"] ?? 0),

    retryCount: Number(row["retry_count"] ?? 0),
    status: String(row["status"] ?? ""),
    failureReason: String(row["failure_reason"] ?? ""),
  }));
}

/* ------------------------------------------------------------------ */
/* Health checking                                                     */
/* ------------------------------------------------------------------ */

export const HEALTH_TIMEOUT_MS = 8_000;

export type NodeHealthResult = {
  nodeId: string;
  status: NodeHealth;
  latencyMs: number;
  runtimes: number;
  detail: string;
};

/**
 * Real sandbox verification: compiles and runs the reference C program through
 * `POST {url}/api/v2/execute` and checks the produced output. Used before a
 * node is promoted to ONLINE — an open port is never treated as health.
 */
const EXECUTE_PROBE_C = `#include <stdio.h>
int main(){int a,b;scanf("%d %d",&a,&b);printf("%d",a+b);return 0;}`;

async function verifyExecute(node: PistonNode): Promise<{ ok: boolean; detail: string }> {
  const started = Date.now();
  const result = await pistonAdapter.execute(
    {
      id: node.id,
      name: `Piston ${node.nodeId}`,
      provider: "PISTON",
      baseUrl: node.url,
      timeoutMs: Math.min(node.timeoutMs || HEALTH_TIMEOUT_MS, HEALTH_TIMEOUT_MS),
    },
    { code: EXECUTE_PROBE_C, language: "c", stdin: "10 20", timeLimitSec: 2, memoryLimitMb: 128 } as ExecInput,
  );
  const stdout = (result.stdout ?? "").trim();
  if (stdout !== "30") {
    return {
      ok: false,
      detail: `expected "30" from POST /api/v2/execute, got "${stdout.slice(0, 60)}" (${result.status ?? "?"})`,
    };
  }
  return { ok: true, detail: `C ran in ${Date.now() - started}ms` };
}

/**
 * Calls `GET {url}/api/v2/runtimes`, validating HTTP status, content type and
 * JSON shape. Only plain data is returned — the Response body is consumed by
 * `providerJson` inside the same call.
 */

export async function checkNode(node: PistonNode, persist = true): Promise<NodeHealthResult> {
  if (!node.enabled) {
    if (persist) await saveNodeHealth(node.nodeId, { status: "DISABLED", error: "" });
    return { nodeId: node.nodeId, status: "DISABLED", latencyMs: 0, runtimes: 0, detail: "Disabled by administrator." };
  }
  const started = Date.now();
  const finalUrl = `${node.url}/api/v2/runtimes`;
  console.info(
    `[piston-health] node=${node.nodeId} configuredUrl=${node.url} finalUrl=${finalUrl} method=GET headers=accept:application/json (no Authorization header is sent)`,
  );
  try {
    const payload = await providerJson(
      finalUrl,
      { method: "GET", headers: { accept: "application/json" } },
      // A probe must answer quickly even when the node allows long-running
      // executions, so a hung VM can never stall a student's run for the full
      // execution timeout.
      Math.min(node.timeoutMs || HEALTH_TIMEOUT_MS, HEALTH_TIMEOUT_MS),
      `Piston ${node.nodeId}`,
      "/api/v2/runtimes",
    );
    if (!Array.isArray(payload)) {
      const detail = "The endpoint answered with JSON that is not a Piston runtime list.";
      console.error(`[piston-health] node=${node.nodeId} url=${finalUrl} unexpected JSON shape`);
      if (persist) await saveNodeHealth(node.nodeId, { status: "UNHEALTHY", error: detail });
      return { nodeId: node.nodeId, status: "UNHEALTHY", latencyMs: Date.now() - started, runtimes: 0, detail };
    }
    // A runtime catalogue alone is not proof of a working sandbox (an open TCP
    // port or a half-broken node can still answer it), so a node that is not
    // already ONLINE must actually compile and run C before it is trusted with
    // a student's run.
    if (node.healthStatus !== "ONLINE") {
      const probe = await verifyExecute(node).catch((err: unknown) => ({
        ok: false,
        detail: err instanceof Error ? err.message : "execute probe failed",
      }));
      if (!probe.ok) {
        const detail = `Piston runtimes answered but the C execute probe failed: ${probe.detail}`;
        console.error(`[piston-health] node=${node.nodeId} execute probe failed: ${probe.detail}`);
        if (persist) await saveNodeHealth(node.nodeId, { status: "UNHEALTHY", error: detail });
        return {
          nodeId: node.nodeId,
          status: "UNHEALTHY",
          latencyMs: Date.now() - started,
          runtimes: payload.length,
          detail,
        };
      }
    }
    const latencyMs = Date.now() - started;
    console.info(
      `[piston-health] node=${node.nodeId} url=${finalUrl} status=200 contentType=application/json runtimes=${payload.length} ms=${latencyMs} -> ONLINE`,
    );
    if (persist) await saveNodeHealth(node.nodeId, { status: "ONLINE", error: "", resetFailures: true });
    return {
      nodeId: node.nodeId,
      status: "ONLINE",
      latencyMs,
      runtimes: payload.length,
      detail: `Piston answered with ${payload.length} runtimes and ran C in ${latencyMs}ms.`,
    };

  } catch (err) {
    const raw = err instanceof ExecutionServiceError ? err.detail : err instanceof Error ? err.message : "unknown";
    console.error(
      `[piston-health] node=${node.nodeId} configuredUrl=${node.url} finalUrl=${finalUrl} errorType=${
        err instanceof Error ? err.name : typeof err
      } detail=${raw.slice(0, 400)} ms=${Date.now() - started}`,
    );
    // Never blame Piston authentication for a hosting-side network refusal.
    const edgeBlocked = /error code: 100\d|direct ip|outbound network edge/i.test(raw);
    const detail = isEgressBlockedPort(node.url)
      ? `${describeEgressPortProblem(node.url)} (${raw})`
      : edgeBlocked || isDirectIpHost(node.url)
        ? `${describeDirectIpProblem(node.url)} (observed: ${raw})`
        : raw;
    if (persist) await saveNodeHealth(node.nodeId, { status: "OFFLINE", error: detail });
    return { nodeId: node.nodeId, status: "OFFLINE", latencyMs: Date.now() - started, runtimes: 0, detail };
  }
}


/** Healthy nodes are re-probed every 60s, unhealthy ones no more than every 120s. */
function isStale(node: PistonNode): boolean {
  if (!node.lastHealthCheck) return true;
  const age = Date.now() - new Date(node.lastHealthCheck).getTime();
  return node.healthStatus === "ONLINE" ? age > 60_000 : age > 120_000;
}

export async function checkAllNodes(force = false): Promise<NodeHealthResult[]> {
  const nodes = await listNodes();
  const out: NodeHealthResult[] = [];
  for (const node of nodes) {
    if (!force && !isStale(node)) continue;
    out.push(await checkNode(node));
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Deterministic student → node assignment                             */
/* ------------------------------------------------------------------ */

/**
 * Server-side, stable and never derived from the browser: the student's
 * position in the registration order decides the batch,
 * `batchSize = ceil(totalStudents / activeNodes)`.
 */
/**
 * Registration order changes only when a student is added, so re-reading the
 * whole students table on the execution path was pure latency. Cached briefly;
 * a miss only affects which node a *new* student lands on.
 */
let studentOrderCache: { at: number; ids: string[] } | null = null;
const STUDENT_ORDER_TTL_MS = 60_000;

async function studentOrder(): Promise<string[]> {
  if (studentOrderCache && Date.now() - studentOrderCache.at < STUDENT_ORDER_TTL_MS) {
    return studentOrderCache.ids;
  }
  const { ownDb } = await import("./own-db.server");
  const { data } = await ownDb().from("students").select("id").order("createdAt", { ascending: true });
  const ids = (data ?? []).map((row) => String((row as Record<string, unknown>)["id"]));
  studentOrderCache = { at: Date.now(), ids };
  return ids;
}

async function computeAssignment(studentId: string, activeNodeIds: string[]): Promise<string> {
  if (activeNodeIds.length === 1) return activeNodeIds[0]!;
  let ordinal = -1;
  let total = activeNodeIds.length;
  try {
    const ids = await studentOrder();
    if (ids.length) {
      total = ids.length;
      ordinal = ids.indexOf(studentId);
    }
  } catch (err) {
    console.error("[piston-pool] student ordering unavailable, falling back to a stable hash", err);
  }

  if (ordinal < 0) {
    // Stable fallback: a deterministic hash of the student's own id.
    let hash = 0;
    for (const char of studentId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    return activeNodeIds[hash % activeNodeIds.length]!;
  }
  // Contiguous batches (floor(ordinal / batchSize)) sent every student who
  // registers after the roster was sized to the LAST node, so a hall that
  // signs up on the day put its whole intake on one VM while three sat idle.
  // Interleaving by position spreads the roster evenly no matter when each
  // student registers, and is just as stable per student.
  const index = ordinal % activeNodeIds.length;
  void total;
  return activeNodeIds[index]!;

}

/**
 * The sticky assignment for a student in a round. Once written it is reused for
 * every execution in that round, so adding a node later never moves a student
 * who is already competing.
 */
/**
 * Sticky assignments are written once and then never change for a student in a
 * round, so re-reading the row on every single run only added a database round
 * trip to the hot path. The memo is validated against the live candidate list
 * exactly like the stored value is, and it expires so an administrator's reset
 * is picked up quickly.
 */
const assignmentMemo = new Map<string, { at: number; nodeId: string }>();
const ASSIGNMENT_TTL_MS = 60_000;

export async function assignedNodeFor(
  studentId: string,
  roundId: string,
  candidates: PistonNode[],
): Promise<string | null> {
  if (!candidates.length) return null;
  if (!studentId) return candidates[0]!.nodeId;
  const key = roundId || "";
  const memoKey = `${studentId}|${key}`;
  const memo = assignmentMemo.get(memoKey);
  if (
    memo &&
    Date.now() - memo.at < ASSIGNMENT_TTL_MS &&
    candidates.some((node) => node.nodeId === memo.nodeId)
  ) {
    return memo.nodeId;
  }

  const client = await schema();
  const rows = await client.unsafe(
    "select node_id from codearena_private.piston_assignments where student_id = $1 and round_id = $2",
    [studentId, key],
  );
  const existing = rows[0] ? String(rows[0]["node_id"]) : "";
  if (existing && candidates.some((node) => node.nodeId === existing)) {
    assignmentMemo.set(memoKey, { at: Date.now(), nodeId: existing });
    return existing;
  }

  const chosen = await computeAssignment(
    studentId,
    candidates.map((node) => node.nodeId),
  );
  await client.unsafe(
    `insert into codearena_private.piston_assignments (student_id, round_id, node_id)
     values ($1,$2,$3)
     on conflict (student_id, round_id) do update set node_id = excluded.node_id`,
    [studentId, key, chosen],
  );
  assignmentMemo.set(memoKey, { at: Date.now(), nodeId: chosen });
  return chosen;

}

/* ------------------------------------------------------------------ */
/* Execution                                                           */
/* ------------------------------------------------------------------ */

const MAX_ATTEMPTS = 3;
/**
 * Hard response budget. A student must get an answer in seconds, not minutes,
 * so a run waits only briefly for its own node's capacity before moving to
 * another VM, and the HTTP call itself is capped well below the old 20s node
 * timeout (a C compile+run on these VMs completes in well under a second).
 */
const QUEUE_WAIT_MS = 2_500;
const QUEUE_POLL_MS = 120;
/** Per-attempt ceiling for the execute HTTP call, regardless of node config. */
const EXEC_BUDGET_MS = 6_000;

/**
 * Short-lived node-list snapshot for the run hot path. Capacity is still
 * enforced atomically by acquireSlot in the database and health is refreshed
 * by the executions themselves, so a couple of seconds of staleness is safe —
 * and it removes one cross-region database round trip from nearly every run
 * during a burst of students.
 */
let nodeListCache: { at: number; nodes: PistonNode[] } | null = null;
const NODE_LIST_TTL_MS = 2_000;
/**
 * Sixty students clicking Run in the same second all missed the cache at once
 * and each opened its own connection for the same SELECT, so the node lookup
 * alone cost well over a second per run. Concurrent misses now share one
 * in-flight query.
 */
let nodeListInFlight: Promise<PistonNode[]> | null = null;

async function listNodesForRun(): Promise<PistonNode[]> {
  const cached = nodeListCache;
  if (cached && Date.now() - cached.at < NODE_LIST_TTL_MS) return cached.nodes;
  if (nodeListInFlight) return nodeListInFlight;
  nodeListInFlight = (async () => {
    try {
      const nodes = await listNodes();
      nodeListCache = { at: Date.now(), nodes };
      return nodes;
    } finally {
      nodeListInFlight = null;
    }
  })();
  return nodeListInFlight;
}


/** Nodes that may currently receive work: enabled and not known-offline. */
function usableNodes(nodes: PistonNode[]): PistonNode[] {
  return nodes.filter((node) => node.enabled && node.url.trim() && node.healthStatus !== "OFFLINE");
}

/* ------------------------------------------------------------------ */
/* Global round-robin scheduler                                        */
/* ------------------------------------------------------------------ */

/**
 * One scheduling cursor for the whole pool — not one per student, per request
 * or per React client. The authoritative counter lives in the database so that
 * several backend instances cannot each independently start at VM1; each
 * instance atomically reserves a small block of tickets and consumes them
 * locally, which keeps the hot path free of a round trip per execution.
 */
const TICKET_BLOCK = 16;
let ticketNext = 0;
let ticketEnd = 0;
let ticketRefill: Promise<void> | null = null;
/** Fallback cursor used only when the shared counter is unreachable. */
let localTicket = Math.floor(Math.random() * 4);

let schedulerReady = false;

async function reserveTicketBlock(): Promise<void> {
  const client = await schema();
  if (!schedulerReady) {
    await client.unsafe(
    `create table if not exists codearena_private.piston_scheduler (
       id int primary key,
       cursor bigint not null default 0,
       updated_at timestamptz not null default now()
     )`,
    );
    schedulerReady = true;
  }
  const rows = await client.unsafe(
    `insert into codearena_private.piston_scheduler (id, cursor)
     values (1, $1)
     on conflict (id) do update
       set cursor = codearena_private.piston_scheduler.cursor + $1, updated_at = now()
     returning cursor`,
    [TICKET_BLOCK],
  );
  const end = Number(rows[0]?.["cursor"] ?? 0);
  ticketNext = end - TICKET_BLOCK;
  ticketEnd = end;
}

/** Next global round-robin ticket. Never throws and never blocks for long. */
async function nextTicket(): Promise<number> {
  if (ticketNext < ticketEnd) return ticketNext++;
  try {
    ticketRefill ??= reserveTicketBlock().finally(() => {
      ticketRefill = null;
    });
    await ticketRefill;
    if (ticketNext < ticketEnd) return ticketNext++;
  } catch (err) {
    console.error("[piston-pool] shared round-robin counter unavailable", err);
  }
  return localTicket++;
}

/**
 * Scheduling order: GLOBAL ROUND ROBIN, filtered by health and capacity.
 *
 * Nodes are ranked by their position in the rotation starting at the current
 * ticket, so four equally healthy VMs receive requests strictly in turn
 * (VM1 → VM2 → VM3 → VM4 → VM1 …) instead of the previous least-loaded rule,
 * which kept picking whichever VM happened to be marginally freer.
 *
 * Capacity and health still win over fairness:
 *   - a node at maxConcurrentJobs is pushed to the back (skipped in practice);
 *   - a node whose utilisation is far above the least-loaded node is demoted
 *     so rotation can never intentionally overload a busy VM;
 *   - non-ONLINE nodes always come last.
 *
 * The student's sticky assignment is deliberately NOT preferred here: affinity
 * must never override load balancing. It is still recorded on the execution
 * row as `assignedNodeId` for the admin history.
 */
const OVERLOAD_MARGIN = 0.25;

function orderFor(nodes: PistonNode[], _assigned: string | null, ticket: number): PistonNode[] {
  void _assigned;
  const ratio = (node: PistonNode) => node.currentLoad / Math.max(1, node.maxConcurrentJobs);
  const ids = nodes.map((node) => node.nodeId).sort();
  const minRatio = Math.min(...nodes.map(ratio));
  const rank = (node: PistonNode) => {
    if (node.healthStatus !== "ONLINE") return 3;
    if (node.currentLoad >= node.maxConcurrentJobs) return 2;
    // Significantly busier than the freest VM: still usable, but only after the
    // fairly-rotated, comparably loaded ones.
    if (ratio(node) - minRatio > OVERLOAD_MARGIN) return 1;
    return 0;
  };
  const rotation = ((ticket % ids.length) + ids.length) % ids.length;
  const slot = (node: PistonNode) =>
    (ids.indexOf(node.nodeId) - rotation + ids.length * 2) % ids.length;
  return [...nodes].sort((a, b) => rank(a) - rank(b) || slot(a) - slot(b) || ratio(a) - ratio(b));
}



const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export type PoolResult = ExecResult & { nodeId: string; assignedNodeId: string; attempts: number };

/* ------------------------------------------------------------------ */
/* Fast-execution race (interactive Compile / Run only)                */
/* ------------------------------------------------------------------ */

/**
 * Interactive Compile/Run is raced across the healthy Piston VMs: the first
 * VALID response wins, is returned immediately, and every other in-flight
 * request is aborted so its VM slot is released at once.
 *
 * Scoring paths (Round 2 / Round 3 evaluate + submit, hidden tests) never
 * enter this path — they keep the controlled least-loaded router with
 * failover, so a program is executed exactly once per test case.
 */
const RACE_DEADLINE_MS = 5_000;
const RACE_MAX_NODES = 4;

function raceEnabled(): boolean {
  return String(process.env["PISTON_RACE_ENABLED"] ?? "true").toLowerCase() !== "false";
}

function raceMaxConcurrent(): number {
  const raw = Number(process.env["PISTON_RACE_MAX_CONCURRENT_REQUESTS"] ?? 12);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 12;
}

/** Races currently in flight on this worker — the load-protection valve. */
let raceInFlight = 0;

/** The student's own request signal, when the runtime exposes one. */
async function requestSignal(): Promise<AbortSignal | null> {
  try {
    const { getRequest } = await import("@tanstack/react-start/server");
    return getRequest()?.signal ?? null;
  } catch {
    return null;
  }
}

/**
 * Only the explicit student "Run All VMs" fast mode is raced. Ordinary
 * Compile / Run keeps using the global round-robin load balancer, and no
 * scoring path ever enters the race.
 */
function raceEligible(input: ExecInput): boolean {
  return String(input.purpose ?? "") === "RUN_ALL";
}

/**
 * Returns the winning result, or `null` when the race is not applicable
 * (disabled, not "Run All VMs", no healthy VM with capacity, or the
 * concurrency valve is closed) so the caller continues with the normal
 * round-robin router.
 */
async function raceOnPistonPool(
  input: ExecInput,
  nodes: PistonNode[],
  assigned: string | null,
): Promise<PoolResult | null> {
  if (!raceEnabled() || !raceEligible(input)) return null;

  // Load protection: only ONLINE VMs with spare capacity may be raced, so the
  // race can use fewer than four VMs when some are full or unhealthy.
  const eligible = nodes
    .filter((node) => node.healthStatus === "ONLINE" && node.currentLoad < node.maxConcurrentJobs)
    .slice(0, RACE_MAX_NODES);
  if (!eligible.length) return null;
  if (raceInFlight >= raceMaxConcurrent()) {
    console.warn(
      `[piston-race] concurrency limit reached (${raceInFlight}/${raceMaxConcurrent()}) — ` +
        "falling back to the round-robin load balancer",
    );
    return null;
  }

  const executionRequestId = globalThis.crypto.randomUUID();
  raceInFlight += 1;
  const t0 = Date.now();

  // Capacity slots are claimed atomically up front; every one of them is
  // released again on every exit path below (win, loss, failure, cancel,
  // timeout, throw) so a cancelled job never stays counted as active.
  // Claimed in parallel: four sequential round trips to the database would
  // cost more than the executions themselves.
  const claims = await Promise.all(
    eligible.map((node) => acquireSlot(node.nodeId).catch(() => false)),
  );
  const claimed = eligible.filter((_, index) => claims[index]);
  if (!claimed.length) {
    raceInFlight -= 1;
    return null;
  }


  const controllers = new Map<string, AbortController>();
  const cancelled: string[] = [];
  const failures: string[] = [];
  let completed = false;
  let timedOut = false;

  const abortAll = () => {
    for (const controller of controllers.values()) controller.abort();
  };
  const deadlineTimer = setTimeout(() => {
    timedOut = true;
    abortAll();
  }, RACE_DEADLINE_MS);
  const clientSignal = await requestSignal();
  const onClientAbort = () => {
    // Student pressed "Stop running" (or the browser went away): cancel every
    // raced request immediately instead of letting the VMs finish the work.
    abortAll();
  };
  if (clientSignal) {
    if (clientSignal.aborted) abortAll();
    else clientSignal.addEventListener("abort", onClientAbort, { once: true });
  }

  type Attempt = { result: ExecResult; nodeId: string; ms: number } | null;

  // Resolved by the first valid response so the caller returns immediately;
  // the losing requests are aborted and finish cleaning up in the background.
  let resolveWinner: (value: NonNullable<Attempt>) => void = () => {};
  const winnerPromise = new Promise<NonNullable<Attempt>>((resolve) => {
    resolveWinner = resolve;
  });

  const attempts = claimed.map(async (node): Promise<Attempt> => {
    const controller = new AbortController();
    controllers.set(node.nodeId, controller);
    const started = Date.now();
    const startedAt = new Date().toISOString();
    let slotReleased = false;
    try {
      const result = await pistonAdapter.execute(
        {
          id: node.id,
          name: node.nodeId,
          provider: "PISTON",
          baseUrl: node.url,
          timeoutMs: Math.min(node.timeoutMs || EXEC_BUDGET_MS, RACE_DEADLINE_MS),
          signal: controller.signal,
        },
        input,
      );
      // Atomic completion flag: only the FIRST valid response may finish the
      // request. A late answer is dropped without persisting anything.
      if (completed) {
        cancelled.push(node.nodeId);
        return null;
      }
      completed = true;
      for (const [nodeId, other] of controllers) {
        if (nodeId !== node.nodeId && !other.signal.aborted) {
          other.abort();
          cancelled.push(nodeId);
        }
      }
      const ms = Date.now() - started;
      // The student already has their answer: persist stats and release the
      // slot in the background instead of holding the response on a DB write.
      slotReleased = true;
      void recordRun(
        node.nodeId,
        null,
        {
          submissionId: input.submissionId ?? null,
          studentId: String(input.studentId ?? "") || null,
          roundId: String(input.roundId ?? "") || null,
          assignedNodeId: assigned ?? "",
          actualNodeId: node.nodeId,
          startedAt,
          endedAt: new Date().toISOString(),
          durationMs: ms,
          queueMs: 0,
          retryCount: 0,
          status: result.status ?? "ACCEPTED",
          failureReason: "",
        },
        null,
      ).catch(() => releaseSlot(node.nodeId).catch(() => undefined));
      resolveWinner({ result, nodeId: node.nodeId, ms });
      return { result, nodeId: node.nodeId, ms };
    } catch (err) {
      const error =
        err instanceof ExecutionServiceError
          ? err
          : new ExecutionServiceError(
              "Code execution is temporarily unavailable. Please try again.",
              err instanceof Error ? err.message : "unknown execution failure",
            );
      if (err instanceof LanguageUnavailableError) throw err;
      if (controller.signal.aborted) {
        // Deliberate cancellation (lost the race, deadline or Stop): not a VM
        // fault, so no failure counter and no execution row.
        return null;
      }
      // Infrastructure failure: recorded so node health stays truthful, and
      // simply ignored by the race — another VM may still answer.
      failures.push(`${node.nodeId}=${error.detail}`);
      slotReleased = await recordRun(
        node.nodeId,
        error.detail,
        {
          submissionId: input.submissionId ?? null,
          studentId: String(input.studentId ?? "") || null,
          roundId: String(input.roundId ?? "") || null,
          assignedNodeId: assigned ?? "",
          actualNodeId: node.nodeId,
          startedAt,
          endedAt: new Date().toISOString(),
          durationMs: Date.now() - started,
          queueMs: 0,
          retryCount: 0,
          status: "INFRASTRUCTURE_ERROR",
          failureReason: error.detail,
        },
        null,
      );
      return null;
    } finally {
      // Guaranteed slot cleanup — win, loss, failure, cancellation or timeout.
      if (!slotReleased) await releaseSlot(node.nodeId);
    }
  });

  const allSettled = Promise.all(attempts);
  try {
    // Whichever comes first: the first valid response, or every attempt
    // finishing without one.
    const winner = await Promise.race([
      winnerPromise,
      allSettled.then((settled) =>
        settled.find((entry): entry is NonNullable<Attempt> => entry !== null) ?? null,
      ),
    ]);
    const totalMs = Date.now() - t0;
    console.info(
      `[piston-race] request=${executionRequestId} vms=[${claimed.map((n) => n.nodeId).join(",")}] ` +
        `winner=${winner?.nodeId ?? "none"} firstResponseMs=${winner?.ms ?? -1} totalMs=${totalMs} ` +
        `cancelled=[${[...new Set(cancelled)].join(",")}] failures=[${failures.join("; ")}]`,
    );
    if (winner) {
      return {
        ...winner.result,
        nodeId: winner.nodeId,
        assignedNodeId: assigned ?? winner.nodeId,
        attempts: claimed.length,
      };
    }
    if (clientSignal?.aborted) {
      throw new ExecutionServiceError("Execution cancelled.", "student stopped the execution");
    }
    if (timedOut) {
      throw new ExecutionServiceError(
        "Execution timed out. Please try again.",
        `no Piston VM answered within ${RACE_DEADLINE_MS}ms (${claimed.length} raced)`,
      );
    }
    throw new ExecutionServiceError(
      "Code execution is temporarily unavailable. Please try again.",
      `every raced Piston VM failed: ${failures.join("; ") || "unknown"}`,
    );
  } finally {
    // Losers are aborted already; wait for their cleanup off the response path
    // so slots and the concurrency valve are still accounted for correctly.
    void allSettled
      .catch(() => undefined)
      .finally(() => {
        clearTimeout(deadlineTimer);
        if (clientSignal) clientSignal.removeEventListener("abort", onClientAbort);
        raceInFlight -= 1;
      });
  }
}

/**
 * Runs one program on the pool.
 *
 * Returns `null` when the pool cannot serve the request at all (no nodes
 * configured / none usable) so the caller can continue with the existing
 * engine list and its Judge0 fallback. Participant errors (compile error,
 * runtime error, wrong output, TLE) are normal results and never fail over.
 */
/** Last background re-probe per node, so recovery checks stay cheap. */
const lastRecheck = new Map<string, number>();
const RECHECK_INTERVAL_MS = 15_000;

function maybeRecheckDegraded(all: PistonNode[]): Promise<void> {
  const now = Date.now();
  const stale = all.filter(
    (node) =>
      node.enabled &&
      node.url.trim() &&
      node.healthStatus !== "ONLINE" &&
      now - (lastRecheck.get(node.nodeId) ?? 0) > RECHECK_INTERVAL_MS,
  );
  if (!stale.length) return Promise.resolve();
  for (const node of stale) lastRecheck.set(node.nodeId, now);
  return Promise.all(stale.map((node) => checkNode(node).catch(() => null))).then(() => undefined);
}

export async function runOnPistonPool(input: ExecInput): Promise<PoolResult | null> {
  const t0 = Date.now();
  // Self-healing during the event, without a separate scheduler: student
  // traffic itself reclaims slots held by runs that can never return. Throttled
  // so a busy pool sweeps at most once every SWEEP_INTERVAL_MS, and never
  // awaited — a student's run must not wait on maintenance.
  void maybeSweepStuck();

  let all: PistonNode[];
  try {
    all = await listNodesForRun();
  } catch (err) {
    console.error("[piston-pool] node pool unavailable", err);
    return null;
  }
  let nodes = usableNodes(all);
  // A node marked UNHEALTHY stays out of the rotation until something probes
  // it again. Re-probe degraded nodes in the background (throttled, never
  // awaited) so a VM that has recovered rejoins the round-robin on its own
  // instead of leaving all traffic on the survivors.
  void maybeRecheckDegraded(all);

  // Every enabled node is currently marked OFFLINE. That status is only a
  // memory of a past probe, so re-check the nodes live before declaring the
  // pool unusable — otherwise one transient network blip keeps both VMs out
  // of rotation forever and the router reports a misleading configuration
  // error while both VMs are perfectly healthy.
  const enabled = all.filter((node) => node.enabled && node.url.trim());
  if (!nodes.length && enabled.length) {
    const results = await Promise.all(enabled.map((node) => checkNode(node).catch(() => null)));
    const recovered = new Set(
      results.filter((result) => result && result.status === "ONLINE").map((result) => result!.nodeId),
    );
    nodes = enabled
      .filter((node) => recovered.has(node.nodeId))
      .map((node) => ({ ...node, healthStatus: "ONLINE" as NodeHealth }));
    if (!nodes.length) {
      // Nodes ARE configured — they are simply unreachable right now.
      throw new ExecutionServiceError(
        "Code execution is temporarily unavailable. Please contact the event administrator.",
        `all ${enabled.length} Piston node(s) failed their health check: ` +
          results.map((r, i) => `${enabled[i]!.nodeId}=${r?.detail ?? "unreachable"}`).join("; "),
      );
    }
  }
  if (!nodes.length) return null;
  const tNodes = Date.now();


  const studentId = String(input.studentId ?? "");
  const roundId = String(input.roundId ?? "");
  // Recorded for the admin execution history only — it never biases scheduling.
  const assigned = await assignedNodeFor(studentId, roundId, nodes).catch(() => nodes[0]!.nodeId);
  // "Run All VMs": race the healthy VMs, first valid response wins and the
  // rest are cancelled. Returns null when the race does not apply, in which
  // case the round-robin router below serves the request.
  const raced = await raceOnPistonPool({ ...input }, nodes, assigned);
  if (raced) return raced;

  // One global ticket per execution drives the rotation across ALL four VMs.
  const ticket = await nextTicket();
  const ordered = orderFor(nodes, assigned, ticket);

  const tAssign = Date.now();

  let attempts = 0;
  let lastError: ExecutionServiceError | null = null;
  const unreachable: string[] = [];
  const deadline = Date.now() + QUEUE_WAIT_MS;
  let probeMs = 0;
  let slotMs = 0;
  let execMs = 0;
  /** Live QUEUED/RUNNING row for this run; cleared when the run is recorded. */
  let inflightId: string | null = null;


  for (const node of ordered) {
    if (attempts >= MAX_ATTEMPTS) break;

    // Only a node that is NOT currently ONLINE is probed first, so a dead VM
    // is skipped instead of burning the student's run on a connection that
    // will never answer. A merely *stale* ONLINE node is executed against
    // directly — the run itself refreshes the health record, so the normal
    // path never waits on a probe round trip.
    if (node.healthStatus !== "ONLINE") {
      const tProbe = Date.now();
      const probe = await checkNode(node).catch(() => null);
      probeMs += Date.now() - tProbe;
      if (!probe || probe.status !== "ONLINE") {
        unreachable.push(`${node.nodeId}=${probe?.detail ?? "unreachable"}`);
        continue;
      }

    }

    // Bounded queue: never send work to a node at maxConcurrentJobs. Every
    // other VM is tried first (rotation order); only when the LAST candidate
    // is also full does the run wait briefly for capacity. A node that stays
    // full with no activity for minutes leaked its slots (interrupted
    // requests), so try one reclaim before queueing against a phantom load.
    const tSlot = Date.now();
    let slot = await acquireSlot(node.nodeId);
    if (!slot && (await reclaimLeakedSlots(node.nodeId))) slot = await acquireSlot(node.nodeId);
    const isLastCandidate = node.nodeId === ordered[ordered.length - 1]!.nodeId;
    if (!slot && isLastCandidate && Date.now() < deadline) {

      // Only a run that actually has to wait is registered as QUEUED, so the
      // normal (immediately served) path costs no extra database write.
      inflightId ??= await beginInflight({
        nodeId: node.nodeId,
        studentId: studentId || null,
        submissionId: input.submissionId ?? null,
        roundId: roundId || null,
        purpose: String(input.purpose ?? "RUN"),
        state: "QUEUED",
        timeoutMs: node.timeoutMs,
      });
      while (!slot && Date.now() < deadline) {
        await sleep(QUEUE_POLL_MS);
        slot = await acquireSlot(node.nodeId);
      }
    }
    slotMs += Date.now() - tSlot;
    if (!slot) {
      console.warn(`[piston-pool] ${node.nodeId} is at capacity — trying the next node`);
      continue;
    }


    attempts += 1;
    const startedAt = new Date().toISOString();
    const started = Date.now();
    const queueMs = Date.now() - tSlot;
    // Live RUNNING state: this is what the admin dashboard shows and what the
    // stuck-execution sweeper uses to reclaim a run that can never return.
    if (inflightId) await markInflightRunning(inflightId, node.nodeId, node.timeoutMs);
    else
      inflightId = await beginInflight({
        nodeId: node.nodeId,
        studentId: studentId || null,
        submissionId: input.submissionId ?? null,
        roundId: roundId || null,
        purpose: String(input.purpose ?? "RUN"),
        state: "RUNNING",
        timeoutMs: node.timeoutMs,
      });
    // The bookkeeping statement below also releases the capacity slot, so the
    // fallback release in `finally` only runs when that write did not commit.
    let slotReleased = false;

    try {
      const result = await pistonAdapter.execute(
        {
          id: node.id,
          name: node.nodeId,
          provider: "PISTON",
          baseUrl: node.url,
          // A silent VM must not hold a student for 20 seconds: fail fast and
          // let the loop hand the run to another node.
          timeoutMs: Math.min(node.timeoutMs || EXEC_BUDGET_MS, EXEC_BUDGET_MS),
        },
        input,
      );
      execMs += Date.now() - started;
      const tPersist = Date.now();
      // Stats, audit row and slot release are bookkeeping: the student's
      // result must not wait on a database round trip.
      const persistedInflightId = inflightId;
      slotReleased = true;
      inflightId = null;
      void recordRun(
        node.nodeId,
        null,
        {
          submissionId: input.submissionId ?? null,
          studentId: studentId || null,
          roundId: roundId || null,
          assignedNodeId: assigned ?? "",
          actualNodeId: node.nodeId,
          startedAt,
          endedAt: new Date().toISOString(),
          durationMs: execMs,
          queueMs,
          retryCount: attempts - 1,
          status: result.status ?? "ACCEPTED",
          failureReason: "",
        },
        persistedInflightId,
      ).then((released) => {
        if (!released) return releaseSlot(node.nodeId).catch(() => undefined);
        return undefined;
      }).catch(() => releaseSlot(node.nodeId).catch(() => undefined));

      console.info(
        `[piston-pool] run ok node=${node.nodeId} attempts=${attempts} ` +
          `nodes=${tNodes - t0}ms assign=${tAssign - tNodes}ms probe=${probeMs}ms ` +
          `slot=${slotMs}ms exec=${execMs}ms persist=${Date.now() - tPersist}ms ` +
          `total=${Date.now() - t0}ms`,
      );
      return { ...result, nodeId: node.nodeId, assignedNodeId: assigned ?? node.nodeId, attempts };
    } catch (err) {
      execMs += Date.now() - started;
      const error =
        err instanceof ExecutionServiceError
          ? err
          : new ExecutionServiceError(
              "Code execution is temporarily unavailable. Please try again.",
              err instanceof Error ? err.message : "unknown execution failure",
            );
      lastError = error;
      // The language is not installed on the pool: retrying elsewhere cannot
      // help and the node is not at fault.
      if (error instanceof LanguageUnavailableError) throw error;
      console.error(`[piston-pool] ${node.nodeId} failed: ${error.detail}`);
      slotReleased = await recordRun(
        node.nodeId,
        error.detail,
        {
          submissionId: input.submissionId ?? null,
          studentId: studentId || null,
          roundId: roundId || null,
          assignedNodeId: assigned ?? "",
          actualNodeId: node.nodeId,
          startedAt,
          endedAt: new Date().toISOString(),
          durationMs: Date.now() - started,
          queueMs,
          retryCount: attempts - 1,
          // Infrastructure failure, kept distinct from participant outcomes.
          status: "INFRASTRUCTURE_ERROR",
          failureReason: error.detail,
        },
        inflightId,
      );
      if (slotReleased) inflightId = null;
      // A timed-out run may still be executing on that VM: retrying elsewhere
      // could double-execute, so stop and let the caller decide — UNLESS the
      // node turns out to be unreachable altogether, which proves the request
      // never got in and makes failing over to the other VM safe.
      if (error.uncertain) {
        const probe = await checkNode(node).catch(() => null);
        if (probe && probe.status === "ONLINE") throw error;
        console.error(`[piston-pool] ${node.nodeId} is unreachable — failing over to another node`);
      }

    } finally {
      if (!slotReleased) await releaseSlot(node.nodeId);
      // Never leave a phantom QUEUED/RUNNING row behind, on any exit path.
      if (inflightId) {
        await dropInflight(inflightId);
        inflightId = null;
      }
    }

  }

  // A run that queued but never got a slot on any node still holds a QUEUED
  // row: clear it so the dashboard queue depth stays truthful.
  if (inflightId) {
    await dropInflight(inflightId);
    inflightId = null;
  }

  console.warn(

    `[piston-pool] run failed attempts=${attempts} nodes=${tNodes - t0}ms ` +
      `assign=${tAssign - tNodes}ms probe=${probeMs}ms slot=${slotMs}ms exec=${execMs}ms ` +
      `total=${Date.now() - t0}ms unreachable=[${unreachable.join("; ")}] ` +
      `lastError=${lastError?.detail ?? "none"}`,
  );
  if (lastError) throw lastError;
  if (unreachable.length) {
    // Nodes are configured but none of them answered: report an outage, not a
    // missing configuration.
    throw new ExecutionServiceError(
      "Code execution is temporarily unavailable. Please contact the event administrator.",
      `no Piston node reachable: ${unreachable.join("; ")}`,
    );
  }
  return null;
}
