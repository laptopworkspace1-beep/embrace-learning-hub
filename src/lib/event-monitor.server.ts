/**
 * Event-day monitoring store: per-endpoint API metrics and database health.
 *
 * Server-only. Nothing here is reachable from the browser except through the
 * admin server functions, which return plain summaries.
 *
 * API metrics are aggregated in memory and flushed to PostgreSQL at most once
 * every FLUSH_INTERVAL_MS, so instrumenting an endpoint costs no extra database
 * round trip on the hot path. A worker that is evicted before its flush loses
 * at most a few seconds of counters — deliberately traded for zero added
 * latency on student requests.
 */
import { getConfig } from "./app-config.server";
import { ddlAlreadyApplied, forgetDdl, markDdlApplied, requestPg, type PgClient } from "./pg-request.server";

const DDL = `
create schema if not exists codearena_private;

create table if not exists codearena_private.api_metrics (
  endpoint text not null,
  bucket timestamptz not null,
  requests integer not null default 0,
  successes integer not null default 0,
  failures integer not null default 0,
  total_ms bigint not null default 0,
  max_ms integer not null default 0,
  primary key (endpoint, bucket)
);
create index if not exists api_metrics_bucket_idx on codearena_private.api_metrics (bucket desc);
`;

const DDL_KEY_SUFFIX = "#event-monitor";

async function schema(): Promise<PgClient> {
  const fromConfig = (await getConfig("OWN_SUPABASE_DB_URL")) ?? "";
  const url = (fromConfig || process.env["OWN_SUPABASE_DB_URL"] || "").trim();
  if (!url) throw new Error("The application is not connected to its database yet.");
  const client = requestPg(url);
  const key = url + DDL_KEY_SUFFIX;
  if (!ddlAlreadyApplied(key)) {
    try {
      await client.unsafe(DDL);
      markDdlApplied(key);
    } catch (error) {
      forgetDdl(key);
      throw error;
    }
  }
  return client;
}

/* ------------------------------------------------------------------ */
/* API metrics                                                         */
/* ------------------------------------------------------------------ */

type Bucket = { requests: number; successes: number; failures: number; totalMs: number; maxMs: number };

/** endpoint -> minute bucket ISO -> counters */
const buffer = new Map<string, Map<string, Bucket>>();
const FLUSH_INTERVAL_MS = 15_000;
const MAX_BUFFER_KEYS = 200;
let lastFlush = 0;
let flushing = false;

function minuteBucket(now = Date.now()): string {
  const d = new Date(now);
  d.setUTCSeconds(0, 0);
  return d.toISOString();
}

/**
 * Records one API call. Never throws and never awaits the database on the hot
 * path: counters accumulate in memory and are flushed opportunistically.
 */
export function recordApiCall(endpoint: string, ok: boolean, ms: number): void {
  try {
    const key = endpoint.slice(0, 60);
    let byBucket = buffer.get(key);
    if (!byBucket) {
      if (buffer.size >= MAX_BUFFER_KEYS) return; // bounded memory
      byBucket = new Map();
      buffer.set(key, byBucket);
    }
    const bucketKey = minuteBucket();
    const entry = byBucket.get(bucketKey) ?? {
      requests: 0,
      successes: 0,
      failures: 0,
      totalMs: 0,
      maxMs: 0,
    };
    entry.requests += 1;
    if (ok) entry.successes += 1;
    else entry.failures += 1;
    entry.totalMs += Math.max(0, Math.round(ms));
    entry.maxMs = Math.max(entry.maxMs, Math.max(0, Math.round(ms)));
    byBucket.set(bucketKey, entry);
  } catch {
    // Monitoring must never affect a request.
  }
}

/**
 * Flushes buffered counters when they are older than FLUSH_INTERVAL_MS.
 * Safe to call from any request; failures are logged and the buffer is kept.
 */
export async function flushApiMetrics(force = false): Promise<void> {
  if (flushing) return;
  if (!force && Date.now() - lastFlush < FLUSH_INTERVAL_MS) return;
  if (buffer.size === 0) {
    lastFlush = Date.now();
    return;
  }
  flushing = true;
  const pending = [...buffer.entries()].flatMap(([endpoint, byBucket]) =>
    [...byBucket.entries()].map(([bucket, counters]) => ({ endpoint, bucket, ...counters })),
  );
  buffer.clear();
  lastFlush = Date.now();
  try {
    const client = await schema();
    // One multi-row statement instead of one round trip per endpoint bucket.
    for (let i = 0; i < pending.length; i += 100) {
      const chunk = pending.slice(i, i + 100);
      const tuples = chunk
        .map((_, n) => {
          const b = n * 7;
          return `($${b + 1},$${b + 2}::timestamptz,$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7})`;
        })
        .join(",");
      await client.unsafe(
        `insert into codearena_private.api_metrics
           (endpoint, bucket, requests, successes, failures, total_ms, max_ms)
         values ${tuples}
         on conflict (endpoint, bucket) do update
            set requests = codearena_private.api_metrics.requests + excluded.requests,
                successes = codearena_private.api_metrics.successes + excluded.successes,
                failures = codearena_private.api_metrics.failures + excluded.failures,
                total_ms = codearena_private.api_metrics.total_ms + excluded.total_ms,
                max_ms = greatest(codearena_private.api_metrics.max_ms, excluded.max_ms)`,
        chunk.flatMap((row) => [
          row.endpoint,
          row.bucket,
          row.requests,
          row.successes,
          row.failures,
          row.totalMs,
          row.maxMs,
        ]),
      );
    }
  } catch (err) {
    console.error("[event-monitor] could not flush API metrics", err);
  } finally {
    flushing = false;
  }
}


export type ApiEndpointMetric = {
  endpoint: string;
  requests: number;
  successes: number;
  failures: number;
  avgMs: number;
  maxMs: number;
};

/** Aggregated API metrics for the admin dashboard. */
export async function readApiMetrics(windowMinutes = 60): Promise<ApiEndpointMetric[]> {
  try {
    const client = await schema();
    const rows = await client.unsafe(
      `select endpoint,
              sum(requests)::int as requests,
              sum(successes)::int as successes,
              sum(failures)::int as failures,
              case when sum(requests) > 0 then (sum(total_ms) / sum(requests))::int else 0 end as avg_ms,
              max(max_ms)::int as max_ms
         from codearena_private.api_metrics
        where bucket > now() - ($1 * interval '1 minute')
        group by endpoint
        order by requests desc`,
      [Math.min(Math.max(windowMinutes, 1), 1440)],
    );
    return rows.map((row) => ({
      endpoint: String(row["endpoint"] ?? ""),
      requests: Number(row["requests"] ?? 0),
      successes: Number(row["successes"] ?? 0),
      failures: Number(row["failures"] ?? 0),
      avgMs: Number(row["avg_ms"] ?? 0),
      maxMs: Number(row["max_ms"] ?? 0),
    }));
  } catch (err) {
    console.error("[event-monitor] could not read API metrics", err);
    return [];
  }
}

/* ------------------------------------------------------------------ */
/* Database health                                                     */
/* ------------------------------------------------------------------ */

export type DbHealth = {
  reachable: boolean;
  probeMs: number;
  connections: number;
  maxConnections: number;
  activeQueries: number;
  waitingQueries: number;
  /** Longest currently running statement, in milliseconds. */
  longestQueryMs: number;
  /** Truncated text of that statement, so a slow operation can be identified. */
  longestQuery: string;
  detail: string;
};

/**
 * Live database health from the server's own catalogues. Read-only, cheap, and
 * intentionally not a place to raise timeouts: it names the slow statement so
 * the actual operation can be fixed.
 */
export async function readDbHealth(): Promise<DbHealth> {
  const started = Date.now();
  const empty: DbHealth = {
    reachable: false,
    probeMs: 0,
    connections: 0,
    maxConnections: 0,
    activeQueries: 0,
    waitingQueries: 0,
    longestQueryMs: 0,
    longestQuery: "",
    detail: "",
  };
  try {
    const client = await schema();
    const rows = await client.unsafe(
      `select
         (select count(*)::int from pg_stat_activity) as connections,
         (select setting::int from pg_settings where name = 'max_connections') as max_connections,
         (select count(*)::int from pg_stat_activity where state = 'active') as active_queries,
         (select count(*)::int from pg_stat_activity where wait_event_type = 'Lock') as waiting_queries,
         (select coalesce(max(extract(epoch from (now() - query_start)) * 1000), 0)::int
            from pg_stat_activity
           where state = 'active' and pid <> pg_backend_pid()) as longest_ms,
         (select left(coalesce(query, ''), 200)
            from pg_stat_activity
           where state = 'active' and pid <> pg_backend_pid()
           order by query_start asc nulls last
           limit 1) as longest_query`,
    );
    const row = rows[0] ?? {};
    return {
      reachable: true,
      probeMs: Date.now() - started,
      connections: Number(row["connections"] ?? 0),
      maxConnections: Number(row["max_connections"] ?? 0),
      activeQueries: Number(row["active_queries"] ?? 0),
      waitingQueries: Number(row["waiting_queries"] ?? 0),
      longestQueryMs: Number(row["longest_ms"] ?? 0),
      longestQuery: String(row["longest_query"] ?? ""),
      detail: "",
    };
  } catch (err) {
    console.error("[event-monitor] database health read failed", err);
    return {
      ...empty,
      probeMs: Date.now() - started,
      // Admin-only surface, but still a summary: no connection string, no host.
      detail: err instanceof Error ? err.message.slice(0, 200) : "database unreachable",
    };
  }
}
