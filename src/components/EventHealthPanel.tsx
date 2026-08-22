/**
 * Event-day health panel (Admin → Execution infrastructure).
 *
 * Refreshes every 10 seconds during the competition and shows the four things
 * that decide whether students are stuck: VM health and load, queue depth,
 * execution latency, and database / API health. Recovery (stuck-execution
 * sweep) happens inside the same read, so watching this page actively heals the
 * pool.
 */
import { useQuery } from "@tanstack/react-query";

import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { formatIst } from "@/lib/datetime";
import { readEventHealth } from "@/lib/piston-nodes.functions";

function Metric({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="rounded-md border border-border p-3">
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-xl font-semibold">{value}</dd>
      {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function ms(value: number): string {
  if (!value) return "—";
  return value >= 1000 ? `${(value / 1000).toFixed(2)}s` : `${value}ms`;
}

export function EventHealthPanel() {
  const q = useQuery({
    queryKey: ["event-health"],
    queryFn: () => readEventHealth(),
    refetchInterval: 10_000,
    placeholderData: (prev) => prev,
    retry: false,
  });

  if (q.isLoading && !q.data) {
    return (
      <section className="space-y-3">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-32 w-full" />
      </section>
    );
  }

  if (q.isError || !q.data) {
    return (
      <section className="rounded-lg border border-destructive/40 bg-destructive/5 p-5">
        <h2 className="text-lg font-semibold text-destructive">Event health unavailable</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          The health snapshot could not be read. Check the database connection on the Configuration page.
        </p>
      </section>
    );
  }

  const data = q.data;
  const { capacity, execution, queue, api, database, alerts } = data;
  const loadPct = capacity.capacity ? Math.round((capacity.load / capacity.capacity) * 100) : 0;
  const status = alerts.some((a) => a.level === "CRITICAL")
    ? "CRITICAL"
    : alerts.length
      ? "DEGRADED"
      : "HEALTHY";

  return (
    <section className="space-y-5 rounded-lg border border-border bg-card p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Event health</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Live every 10s · last checked {formatIst(data.checkedAt)}
          </p>
        </div>
        <Badge
          variant="outline"
          className={
            status === "HEALTHY"
              ? "bg-emerald-500/15 text-emerald-600 border-emerald-500/30"
              : status === "DEGRADED"
                ? "bg-amber-500/15 text-amber-600 border-amber-500/30"
                : "bg-destructive/15 text-destructive border-destructive/30"
          }
        >
          ● {status}
        </Badge>
      </div>

      {alerts.length ? (
        <ul className="space-y-2">
          {alerts.map((alert, index) => (
            <li
              key={`${alert.level}-${index}`}
              className={
                alert.level === "CRITICAL"
                  ? "rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
                  : "rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-sm text-amber-700 dark:text-amber-400"
              }
            >
              {alert.level === "CRITICAL" ? "Critical: " : "Warning: "}
              {alert.message}
            </li>
          ))}
        </ul>
      ) : (
        <p className="rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-400">
          All execution VMs, the queue, the database and the API are within normal limits.
        </p>
      )}

      <dl className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Metric
          label="VMs online"
          value={`${capacity.online}/${capacity.enabled}`}
          hint="enabled execution nodes answering"
        />
        <Metric
          label="Current load"
          value={`${capacity.load}/${capacity.capacity}`}
          hint={`${loadPct}% of concurrent capacity`}
        />
        <Metric
          label="Queue"
          value={queue.queued}
          hint={queue.queued ? `oldest waiting ${queue.oldestQueuedSeconds}s` : "no run is waiting"}
        />
        <Metric
          label="Running now"
          value={queue.running}
          hint={queue.running ? `oldest running ${queue.oldestRunningSeconds}s` : "idle"}
        />
        <Metric label="Avg execution" value={ms(execution.avgExecutionMs)} hint="last 60 minutes" />
        <Metric label="Max execution" value={ms(execution.maxExecutionMs)} hint="last 60 minutes" />
        <Metric
          label="Avg queue wait"
          value={ms(execution.avgQueueMs)}
          hint={`${execution.executions} executions, ${execution.infraFailures} infra failures`}
        />
        <Metric
          label="Recovered runs"
          value={data.swept.length}
          hint="stuck executions reclaimed on this check"
        />
      </dl>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded-md border border-border p-4">
          <h3 className="text-sm font-semibold">Database</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {database.reachable
              ? `Reachable in ${ms(database.probeMs)} · ${database.connections}/${database.maxConnections} connections · ` +
                `${database.activeQueries} active, ${database.waitingQueries} waiting on locks`
              : "Not answering."}
          </p>
          {database.reachable && database.longestQueryMs > 1000 ? (
            <p className="mt-2 font-mono text-xs text-muted-foreground">
              Longest statement {ms(database.longestQueryMs)}: {database.longestQuery}
            </p>
          ) : null}
          {!database.reachable && database.detail ? (
            <p className="mt-2 text-xs text-destructive">{database.detail}</p>
          ) : null}
        </div>

        <div className="rounded-md border border-border p-4">
          <h3 className="text-sm font-semibold">API</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {api.requests
              ? `${api.requests} calls in the last hour · ${api.failures} failed · avg ${ms(api.avgMs)} · max ${ms(api.maxMs)}`
              : "No instrumented API calls recorded in the last hour."}
          </p>
          {api.endpoints.length ? (
            <ul className="mt-3 space-y-1 text-xs text-muted-foreground">
              {api.endpoints.slice(0, 6).map((row) => (
                <li key={row.endpoint} className="flex justify-between gap-3">
                  <span className="font-mono">{row.endpoint}</span>
                  <span>
                    {row.requests} · avg {ms(row.avgMs)} · max {ms(row.maxMs)}
                    {row.failures ? ` · ${row.failures} failed` : ""}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>

      {data.nodeStats.length ? (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2">Node</th>
                <th className="px-3 py-2">Executions</th>
                <th className="px-3 py-2">Infra failures</th>
                <th className="px-3 py-2">Avg</th>
                <th className="px-3 py-2">Max</th>
                <th className="px-3 py-2">Avg queue</th>
              </tr>
            </thead>
            <tbody>
              {data.nodeStats.map((stat) => (
                <tr key={stat.nodeId} className="border-t border-border">
                  <td className="px-3 py-2 font-mono text-xs">{stat.nodeId || "—"}</td>
                  <td className="px-3 py-2">{stat.executions}</td>
                  <td className={`px-3 py-2 ${stat.infraFailures ? "text-destructive" : ""}`}>
                    {stat.infraFailures}
                  </td>
                  <td className="px-3 py-2">{ms(stat.avgDurationMs)}</td>
                  <td className="px-3 py-2">{ms(stat.maxDurationMs)}</td>
                  <td className="px-3 py-2">{ms(stat.avgQueueMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
