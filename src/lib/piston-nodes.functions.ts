/**
 * Admin server functions for the Piston node pool (Admin → Execution
 * infrastructure). Every handler re-verifies the ADMIN role server-side, and
 * nothing here ever returns infrastructure secrets — only the node address,
 * health, capacity and counters that an administrator needs.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const nodeInput = z.object({
  id: z.string().uuid().optional(),
  nodeId: z
    .string()
    .trim()
    .min(2)
    .max(60)
    .regex(/^[a-z0-9][a-z0-9-_]*$/i, "Use letters, digits, hyphen or underscore."),
  url: z.string().trim().min(4).max(300),
  enabled: z.boolean(),
  maxConcurrentJobs: z.number().int().min(1).max(200),
  timeoutMs: z.number().int().min(2000).max(60000).optional(),
});

export type PistonNodeFormInput = z.infer<typeof nodeInput>;

/**
 * Node pool + recent execution log for the admin infrastructure screen.
 * This is a pure read: it never probes the VMs, so the page renders as fast as
 * the database answers. Health is refreshed separately by `refreshPistonHealth`.
 */
export const listPistonNodes = createServerFn({ method: "POST" }).handler(async () => {
  const { requireAdmin } = await import("./app-session.server");
  await requireAdmin();
  const pool = await import("./piston-pool.server");

  const nodes = await pool.listNodes();
  return { nodes, checkedAt: new Date().toISOString() };
});

/**
 * Recent execution log, split out of `listPistonNodes` so the node pool (the
 * part the admin actually acts on) paints without waiting for, or shipping,
 * the much larger history payload.
 */
export const listPistonExecutions = createServerFn({ method: "POST" }).handler(async () => {
  const { requireAdmin } = await import("./app-session.server");
  await requireAdmin();
  const pool = await import("./piston-pool.server");
  const executions = await pool.readExecutionLogs(40).catch(() => []);
  return { executions };
});

/**
 * Live event-day health snapshot: VM load, queue depth, execution latency,
 * stuck-execution sweep results, database health and API health.
 *
 * The read itself performs the recovery work (stuck-execution sweep and leaked
 * slot reclamation) so an administrator watching this page is also actively
 * healing the pool. Everything is best effort: a failing sub-read degrades that
 * card instead of blanking the dashboard.
 */
export const readEventHealth = createServerFn({ method: "POST" }).handler(async () => {
  const { requireAdmin } = await import("./app-session.server");
  await requireAdmin();
  const pool = await import("./piston-pool.server");
  const monitor = await import("./event-monitor.server");

  // Recover before measuring, so the numbers shown are post-recovery truth.
  const swept = await pool.sweepStuckExecutions().catch(() => []);
  await monitor.flushApiMetrics(true).catch(() => undefined);

  const [nodes, queue, nodeStats, api, db] = await Promise.all([
    pool.listNodes().catch(() => []),
    pool.readQueueStats().catch(() => ({
      queued: 0,
      running: 0,
      oldestQueuedSeconds: 0,
      oldestRunningSeconds: 0,
    })),
    pool.readNodeStats(60).catch(() => []),
    monitor.readApiMetrics(60).catch(() => []),
    monitor.readDbHealth(),
  ]);

  const totals = nodeStats.reduce(
    (acc, stat) => ({
      executions: acc.executions + stat.executions,
      infraFailures: acc.infraFailures + stat.infraFailures,
      weightedMs: acc.weightedMs + stat.avgDurationMs * stat.successes,
      successes: acc.successes + stat.successes,
      maxMs: Math.max(acc.maxMs, stat.maxDurationMs),
      queueWeighted: acc.queueWeighted + stat.avgQueueMs * stat.executions,
    }),
    { executions: 0, infraFailures: 0, weightedMs: 0, successes: 0, maxMs: 0, queueWeighted: 0 },
  );

  const capacity = nodes
    .filter((node) => node.enabled)
    .reduce((sum, node) => sum + node.maxConcurrentJobs, 0);
  const load = nodes.reduce((sum, node) => sum + node.currentLoad, 0);
  const online = nodes.filter((node) => node.enabled && node.healthStatus === "ONLINE").length;

  const avgExecutionMs = totals.successes ? Math.round(totals.weightedMs / totals.successes) : 0;
  const avgQueueMs = totals.executions ? Math.round(totals.queueWeighted / totals.executions) : 0;
  const apiTotals = api.reduce(
    (acc, row) => ({
      requests: acc.requests + row.requests,
      failures: acc.failures + row.failures,
      weightedMs: acc.weightedMs + row.avgMs * row.requests,
      maxMs: Math.max(acc.maxMs, row.maxMs),
    }),
    { requests: 0, failures: 0, weightedMs: 0, maxMs: 0 },
  );

  // Alert thresholds an administrator can act on during the event.
  const alerts: { level: "WARN" | "CRITICAL"; message: string }[] = [];
  if (!online) alerts.push({ level: "CRITICAL", message: "No execution VM is online." });
  else if (online < nodes.filter((n) => n.enabled).length)
    alerts.push({
      level: "WARN",
      message: `${nodes.filter((n) => n.enabled).length - online} execution VM(s) are not answering.`,
    });
  if (capacity && load / capacity > 0.8)
    alerts.push({ level: "WARN", message: "Execution capacity is above 80%." });
  if (queue.queued > 0 && queue.oldestQueuedSeconds > 10)
    alerts.push({
      level: "WARN",
      message: `A run has been waiting ${queue.oldestQueuedSeconds}s for a free slot.`,
    });
  if (avgExecutionMs > 5000)
    alerts.push({ level: "WARN", message: "Average execution time is above 5s." });
  if (swept.length)
    alerts.push({
      level: "WARN",
      message: `${swept.length} stuck execution(s) were recovered automatically.`,
    });
  if (!db.reachable) alerts.push({ level: "CRITICAL", message: "The database is not answering." });
  else if (db.longestQueryMs > 10_000)
    alerts.push({ level: "WARN", message: "A database statement has been running over 10s." });
  if (apiTotals.requests && apiTotals.failures / apiTotals.requests > 0.05)
    alerts.push({ level: "WARN", message: "Over 5% of API calls are failing." });

  return {
    checkedAt: new Date().toISOString(),
    nodes,
    nodeStats,
    queue,
    capacity: { capacity, load, online, enabled: nodes.filter((node) => node.enabled).length },
    execution: {
      executions: totals.executions,
      infraFailures: totals.infraFailures,
      avgExecutionMs,
      maxExecutionMs: totals.maxMs,
      avgQueueMs,
    },
    swept,
    api: {
      endpoints: api,
      requests: apiTotals.requests,
      failures: apiTotals.failures,
      avgMs: apiTotals.requests ? Math.round(apiTotals.weightedMs / apiTotals.requests) : 0,
      maxMs: apiTotals.maxMs,
    },
    database: db,
    alerts,
  };
});


/**
 * Opportunistic health refresh for the admin screen: only nodes whose last
 * check is stale are probed, so an unhealthy VM is never hammered. Runs after
 * the page has rendered, never in its critical path.
 */
export const refreshPistonHealth = createServerFn({ method: "POST" }).handler(async () => {
  const { requireAdmin } = await import("./app-session.server");
  await requireAdmin();
  const pool = await import("./piston-pool.server");
  await pool.checkAllNodes().catch((err) => {
    console.error("[piston-admin] background health check failed", err);
    return [];
  });
  const nodes = await pool.listNodes();
  return { nodes, checkedAt: new Date().toISOString() };
});


export const savePistonNode = createServerFn({ method: "POST" })
  .inputValidator((input: PistonNodeFormInput) => nodeInput.parse(input))
  .handler(async ({ data }) => {
    const { requireAdmin } = await import("./app-session.server");
    await requireAdmin();
    const pool = await import("./piston-pool.server");

    const validated = pool.validateNodeUrl(data.url);
    if (validated.error) throw new Error(validated.error);

    const existing = await pool.listNodes();
    const previous = data.id ? existing.find((node) => node.id === data.id) ?? null : null;
    if (data.id && !previous) throw new Error("That Piston node no longer exists.");
    const clash = existing.find((node) => node.nodeId === data.nodeId && node.id !== data.id);
    if (clash) throw new Error(`Node ID "${data.nodeId}" is already used.`);

    const payload = {
      nodeId: data.nodeId,
      url: validated.url,
      enabled: data.enabled,
      maxConcurrentJobs: data.maxConcurrentJobs,
      ...(data.timeoutMs !== undefined ? { timeoutMs: data.timeoutMs } : {}),
    };

    // Server-side health check before the node may serve student code.
    const probe = await pool.checkNode(
      {
        ...(previous ?? {
          id: "",
          healthStatus: "OFFLINE" as const,
          lastHealthCheck: null,
          lastError: "",
          failureCount: 0,
          currentLoad: 0,
          totalExecutions: 0,
          totalFailures: 0,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
        nodeId: payload.nodeId,
        url: payload.url,
        enabled: payload.enabled,
        maxConcurrentJobs: payload.maxConcurrentJobs,
        timeoutMs: payload.timeoutMs ?? previous?.timeoutMs ?? 20_000,
      },
      false,
    );
    if (payload.enabled && probe.status !== "ONLINE") {
      throw new Error(`That address did not answer as a Piston API: ${probe.detail}`);
    }

    const saved = previous
      ? await pool.updateNode(previous.id, payload)
      : await pool.createNode(payload);
    if (!saved) throw new Error("Could not save that Piston node.");

    // Persist the freshly observed health for the saved record.
    await pool.checkNode(saved).catch(() => null);
    return { ok: true, nodeId: saved.nodeId, detail: probe.detail };
  });

export const checkPistonNode = createServerFn({ method: "POST" })
  .inputValidator((input: { id: string }) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data }) => {
    const { requireAdmin } = await import("./app-session.server");
    await requireAdmin();
    const pool = await import("./piston-pool.server");
    const node = await pool.getNode(data.id);
    if (!node) throw new Error("That Piston node no longer exists.");
    return pool.checkNode(node);
  });

export const setPistonNodeEnabled = createServerFn({ method: "POST" })
  .inputValidator((input: { id: string; enabled: boolean }) =>
    z.object({ id: z.string().uuid(), enabled: z.boolean() }).parse(input),
  )
  .handler(async ({ data }) => {
    const { requireAdmin } = await import("./app-session.server");
    await requireAdmin();
    const pool = await import("./piston-pool.server");
    const updated = await pool.updateNode(data.id, { enabled: data.enabled });
    if (!updated) throw new Error("That Piston node no longer exists.");
    if (data.enabled) await pool.checkNode(updated).catch(() => null);
    return { ok: true };
  });

export const deletePistonNode = createServerFn({ method: "POST" })
  .inputValidator((input: { id: string }) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data }) => {
    const { requireAdmin } = await import("./app-session.server");
    await requireAdmin();
    const pool = await import("./piston-pool.server");
    // Historical execution records are intentionally kept: they retain the
    // actualNodeId that ran each submission.
    const removed = await pool.deleteNode(data.id);
    if (!removed) throw new Error("That Piston node no longer exists.");
    const remaining = (await pool.listNodes()).filter(
      (node) => node.enabled && node.healthStatus !== "OFFLINE",
    );
    return { ok: true, remainingUsable: remaining.length };
  });
