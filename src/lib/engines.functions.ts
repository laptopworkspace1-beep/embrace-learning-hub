/**
 * Admin server functions for the multi-engine execution layer.
 *
 * Every handler re-verifies the ADMIN role on the server, and no handler ever
 * returns a stored API key — only whether one is set.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { EXECUTABLE_LANGUAGES, PROVIDERS } from "./exec-engines";

const engineInputSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(2).max(60),
  provider: z.enum(PROVIDERS),
  baseUrl: z.string().trim().max(300),
  apiKey: z.string().trim().max(400).optional(),
  enabled: z.boolean(),
  priority: z.number().int().min(1).max(99),
  timeoutMs: z.number().int().min(2000).max(60000),
  supportedLanguages: z.array(z.enum(EXECUTABLE_LANGUAGES)).min(1),
});

export type EngineFormInput = z.infer<typeof engineInputSchema>;

/** Engines + routing mode + execution statistics + recent status changes. */
export const listExecutionEngines = createServerFn({ method: "POST" }).handler(async () => {
  const { requireAdmin } = await import("./app-session.server");
  await requireAdmin();
  const store = await import("./exec-store.server");
  const { maybeHeartbeat } = await import("./exec-router.server");

  // Opportunistic heartbeat (at most once a minute). It is awaited inside this
  // request: work left running after the response is sent would keep using
  // sockets belonging to a finished request, which the hosting runtime rejects
  // with "Cannot perform I/O on behalf of a different request".
  await maybeHeartbeat();

  const [engines, mode, stats, events] = await Promise.all([
    store.listEngines(),
    store.readExecutionMode(),
    store.readExecutionStats().catch(() => ({ total: 0, successful: 0, failed: 0, averageLatencyMs: 0 })),
    store.readEngineEvents(12).catch(() => []),
  ]);


  return {
    engines: engines.map(store.toSummary),
    mode,
    stats,
    events,
    checkedAt: new Date().toISOString(),
  };
});

export const saveExecutionEngine = createServerFn({ method: "POST" })
  .inputValidator((input: EngineFormInput) => engineInputSchema.parse(input))
  .handler(async ({ data }) => {
    const { requireAdmin } = await import("./app-session.server");
    const { audit } = await import("./own-db.server");
    const { MAX_ENGINES, describeBaseUrlProblem, normalizeProviderBaseUrl } = await import("./exec-engines");
    const claims = await requireAdmin();
    const store = await import("./exec-store.server");
    const { checkEngineHealth, applyHealth } = await import("./exec-router.server");

    // One normalizer for every provider: trims, drops trailing slashes, strips
    // any /api/v2, /languages, /submissions suffix and rejects unreachable hosts.
    const normalized = normalizeProviderBaseUrl(data.baseUrl);
    if (normalized.problem) throw new Error(describeBaseUrlProblem(normalized.problem));

    const existing = await store.listEngines();
    const previous = data.id ? existing.find((engine) => engine.id === data.id) ?? null : null;
    if (data.id && !previous) throw new Error("That execution engine no longer exists.");
    if (!data.id && existing.length >= MAX_ENGINES) {
      throw new Error(`CodeArena supports at most ${MAX_ENGINES} execution engines. Remove one first.`);
    }

    const payload = {
      name: data.name,
      provider: data.provider,
      baseUrl: normalized.baseUrl,
      enabled: data.enabled,
      priority: data.priority,
      timeoutMs: data.timeoutMs,
      supportedLanguages: data.supportedLanguages,
      ...(data.apiKey ? { apiKey: data.apiKey } : {}),
    };

    let record = data.id
      ? await store.updateEngine(data.id, payload)
      : await store.createEngine({ ...payload, apiKey: data.apiKey ?? "" });
    if (!record) throw new Error("That execution engine no longer exists.");

    // A changed target invalidates the previous health state: clear it, then
    // re-check immediately so the admin sees the new diagnostic straight away.
    const targetChanged =
      !previous ||
      previous.baseUrl !== record.baseUrl ||
      previous.provider !== record.provider ||
      Boolean(data.apiKey) ||
      previous.enabled !== record.enabled;

    if (targetChanged) {
      await store.saveHealth(record.id, {
        status: "UNKNOWN",
        detail: "Configuration changed — running a fresh health check.",
        latencyMs: 0,
        apiHealth: "UNKNOWN",
        executionHealth: "UNKNOWN",
        lastError: "",
      });
      const fresh = (await store.getEngine(record.id)) ?? record;
      const health = record.enabled
        ? await checkEngineHealth(fresh, { probeExecution: true })
        : {
            status: "DISABLED" as const,
            detail: "Engine is disabled by the administrator.",
            latencyMs: 0,
            languages: [],
            available: [],
            compilerTest: null,
            apiHealth: "DISABLED" as const,
            executionHealth: "DISABLED" as const,
            lastError: "",
          };

      await applyHealth(fresh, health);
      record = (await store.getEngine(record.id)) ?? record;
    }

    await audit({
      actorUserId: claims.sub,
      action: data.id ? "ENGINE_UPDATED" : "ENGINE_CREATED",
      entityType: "execution_engine",
      entityId: record.id,
      metadata: {
        name: record.name,
        provider: record.provider,
        enabled: record.enabled,
        priority: record.priority,
      },
    }).catch(() => {});

    return { engine: store.toSummary(record) };
  });

export const deleteExecutionEngine = createServerFn({ method: "POST" })
  .inputValidator((input: { id: string }) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data }) => {
    const { requireAdmin } = await import("./app-session.server");
    const { audit } = await import("./own-db.server");
    const claims = await requireAdmin();
    const store = await import("./exec-store.server");
    const removed = await store.deleteEngine(data.id);
    if (!removed) throw new Error("That execution engine no longer exists.");
    await audit({
      actorUserId: claims.sub,
      action: "ENGINE_DELETED",
      entityType: "execution_engine",
      entityId: data.id,
    }).catch(() => {});
    return { ok: true };
  });

export const setExecutionMode = createServerFn({ method: "POST" })
  .inputValidator((input: { mode: "AUTO_FAILOVER" | "LOAD_BALANCED" }) =>
    z.object({ mode: z.enum(["AUTO_FAILOVER", "LOAD_BALANCED"]) }).parse(input),
  )
  .handler(async ({ data }) => {
    const { requireAdmin } = await import("./app-session.server");
    await requireAdmin();
    const store = await import("./exec-store.server");
    await store.writeExecutionMode(data.mode);
    return { mode: data.mode };
  });

/**
 * Tests exactly ONE engine — never the whole set.
 *   mode CONNECTION → provider API reachability, JSON validity, language list
 *   mode COMPILER    → additionally compiles and runs the reference C program
 * Values that have not been saved yet can be tested directly by sending them here.
 */
export const testExecutionEngine = createServerFn({ method: "POST" })
  .inputValidator(
    (input: {
      id?: string;
      provider?: (typeof PROVIDERS)[number];
      baseUrl?: string;
      apiKey?: string;
      timeoutMs?: number;
      mode?: "CONNECTION" | "COMPILER";
    }) =>
      z
        .object({
          id: z.string().uuid().optional(),
          provider: z.enum(PROVIDERS).optional(),
          baseUrl: z.string().trim().max(300).optional(),
          apiKey: z.string().trim().max(400).optional(),
          timeoutMs: z.number().int().min(2000).max(60000).optional(),
          mode: z.enum(["CONNECTION", "COMPILER"]).default("COMPILER"),
        })
        .parse(input),
  )
  .handler(async ({ data }) => {
    const { requireAdmin } = await import("./app-session.server");
    const { describeBaseUrlProblem, normalizeProviderBaseUrl } = await import("./exec-engines");
    await requireAdmin();
    const store = await import("./exec-store.server");
    const { testEngineTarget, applyHealth } = await import("./exec-router.server");

    const saved = data.id ? await store.getEngine(data.id) : null;
    if (data.id && !saved) throw new Error("That execution engine no longer exists.");

    const normalized = normalizeProviderBaseUrl(data.baseUrl ?? saved?.baseUrl ?? "");
    if (normalized.problem) throw new Error(describeBaseUrlProblem(normalized.problem));

    const target = {
      ...(saved ? { id: saved.id } : {}),
      name: saved?.name ?? "New engine",
      provider: data.provider ?? saved?.provider ?? "PISTON",
      baseUrl: normalized.baseUrl,
      apiKey: data.apiKey || saved?.apiKey || "",
      timeoutMs: data.timeoutMs ?? saved?.timeoutMs ?? 20_000,
    };

    const result = await testEngineTarget(target, data.mode);

    // A test against the *saved* configuration also updates the stored health.
    // A CONNECTION-only pass never promotes an engine to HEALTHY — only real C
    // execution can do that — so it is recorded as DEGRADED at best.
    const keepHealthy = data.mode === "CONNECTION" && saved?.healthStatus === "HEALTHY" && result.connected;
    if (saved && normalized.baseUrl === saved.baseUrl && !keepHealthy) {
      await applyHealth(saved, {
        status: saved.enabled ? result.status : "DISABLED",
        detail: result.detail,
        latencyMs: result.latencyMs,
        languages: result.languages,
        available: [],
        compilerTest: result.compilerTest,
        // Connection tests only ever prove the API side. Execution health is
        // promoted solely by a successful C compile-and-run.
        apiHealth: saved.enabled ? (result.connected ? "HEALTHY" : "UNAVAILABLE") : "DISABLED",
        executionHealth: !saved.enabled
          ? "DISABLED"
          : data.mode === "COMPILER"
            ? result.executionReady
              ? "HEALTHY"
              : "UNAVAILABLE"
            : saved.executionHealth,
        lastError: result.executionReady ? "" : result.detail,
      });

    }

    return {
      mode: result.mode,
      endpoint: result.endpoint,
      provider: target.provider,
      baseUrl: target.baseUrl,
      connected: result.connected,
      executionReady: result.executionReady,
      status: result.status,
      detail: result.detail,
      latencyMs: result.latencyMs,
      languages: result.languages.slice(0, 80),
      compilerTest: result.compilerTest,
      testedAt: new Date().toISOString(),
    };
  });

/** Re-checks every configured engine right now. */
export const refreshEngineHealth = createServerFn({ method: "POST" }).handler(async () => {
  const { requireAdmin } = await import("./app-session.server");
  await requireAdmin();
  const { checkAllEngines } = await import("./exec-router.server");
  const store = await import("./exec-store.server");
  await checkAllEngines({ probeExecution: true });
  const engines = await store.listEngines();
  return { engines: engines.map(store.toSummary), checkedAt: new Date().toISOString() };
});
