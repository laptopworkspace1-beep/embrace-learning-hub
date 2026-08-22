/**
 * ExecutionRouter + HealthChecker — the part of CodeExecutionService that
 * decides *where* a program runs.
 *
 *   CodeExecutionService.execute()
 *      → candidate engines (enabled, supports the language, by priority)
 *      → adapter.execute() on the first one
 *      → on an infrastructure fault: mark it, log it, fail over to the next
 *      → every attempt is persisted in execution_records
 *
 * Participant errors (compile errors, wrong output, runtime errors, TLE) are
 * NEVER a reason to fail over: they are legitimate results of the program.
 */
import {
  ENGINE_TEST_EXPECTED,
  normalizeLanguage,
  type EngineHealth,
  type ExecutionMode,
  type Language,
} from "./exec-engines";
import {
  ALL_ENGINES_DOWN_MESSAGE,
  ExecutionServiceError,
  NOT_CONFIGURED_MESSAGE,
  type ExecInput,
  type ExecResult,
} from "./exec-error.server";
import {
  adapterFor,
  runCompilerTest,
  type CompilerTest,
  type EngineTarget,
} from "./engine-adapters.server";
import {
  cachedEngines,
  invalidateEngineCache,
  readExecutionMode,
  recordEngineOutcome,
  saveHealth,
  writeEngineEvent,
  writeExecutionRecord,
  type EngineRecord,
} from "./exec-store.server";

function targetOf(engine: EngineRecord): EngineTarget {
  return {
    id: engine.id,
    name: engine.name,
    provider: engine.provider,
    baseUrl: engine.baseUrl,
    apiKey: engine.apiKey,
    timeoutMs: engine.timeoutMs,
  };
}

/* ================================================================== */
/* HealthChecker                                                       */
/* ================================================================== */

export type HealthResult = {
  status: EngineHealth;
  detail: string;
  latencyMs: number;
  languages: string[];
  available: Language[];
  compilerTest: CompilerTest | null;
  /** Catalogue endpoint reachable and answering with valid data. */
  apiHealth: EngineHealth;
  /** The reference C program actually compiled and ran on the engine. */
  executionHealth: EngineHealth;
  /** Last infrastructure error in administrator-readable terms. */
  lastError: string;
};

/**
 * A full health check. API reachability and execution capability are reported
 * separately and are never conflated: a Judge0 whose `/languages` answers but
 * whose worker cannot open `/box/main.c` is API HEALTHY / execution
 * UNAVAILABLE, and stays out of the routing pool.
 *
 * Only plain, serializable data is returned — never a Response, a stream, or
 * any other request-scoped I/O object.
 */
export async function checkEngineHealth(
  engine: EngineRecord,
  options: { probeExecution?: boolean } = {},
): Promise<HealthResult> {
  const probeExecution = options.probeExecution ?? true;
  const target = targetOf(engine);
  const adapter = adapterFor(engine.provider);

  if (!engine.enabled) {
    return {
      status: "DISABLED",
      detail: "Engine is disabled by the administrator.",
      latencyMs: 0,
      languages: [],
      available: [],
      compilerTest: null,
      apiHealth: "DISABLED",
      executionHealth: "DISABLED",
      lastError: "",
    };
  }

  try {
    const probe = await adapter.probeApi(target);
    const missing = engine.supportedLanguages.filter((lang) => !probe.available.includes(lang));
    const apiHealth: EngineHealth = missing.length ? "DEGRADED" : "HEALTHY";

    if (!probeExecution) {
      // The catalogue answered, but nothing has been executed yet, so the
      // execution side stays UNKNOWN rather than being assumed healthy.
      return {
        status: "DEGRADED",
        detail: missing.length
          ? `API reachable. Engine does not advertise: ${missing.join(", ")}. Execution not verified yet.`
          : `${probe.detail} Execution not verified yet.`,
        latencyMs: probe.latencyMs,
        languages: probe.languages,
        available: probe.available,
        compilerTest: null,
        apiHealth,
        executionHealth: "UNKNOWN",
        lastError: "",
      };
    }

    const compilerTest = await runCompilerTest(target);
    if (!compilerTest.ok) {
      return {
        status: "UNAVAILABLE",
        detail: `API reachable but the C test program failed: ${compilerTest.detail}`,
        latencyMs: probe.latencyMs,
        languages: probe.languages,
        available: probe.available,
        compilerTest,
        apiHealth,
        executionHealth: "UNAVAILABLE",
        lastError: compilerTest.detail,
      };
    }
    return {
      status: missing.length ? "DEGRADED" : "HEALTHY",
      detail: missing.length
        ? `C works, but the engine does not advertise: ${missing.join(", ")}.`
        : `${probe.detail} C compiled and printed "${ENGINE_TEST_EXPECTED}" in ${compilerTest.executionTimeMs}ms.`,
      latencyMs: probe.latencyMs,
      languages: probe.languages,
      available: probe.available,
      compilerTest,
      apiHealth,
      executionHealth: "HEALTHY",
      lastError: "",
    };
  } catch (err) {
    const detail =
      err instanceof ExecutionServiceError ? err.detail : err instanceof Error ? err.message : "unknown error";
    return {
      status: "UNAVAILABLE",
      detail,
      latencyMs: 0,
      languages: [],
      available: [],
      compilerTest: null,
      apiHealth: "UNAVAILABLE",
      executionHealth: "UNAVAILABLE",
      lastError: detail,
    };
  }
}

/** Persists a health result and emits a status-change event for the dashboard. */
export async function applyHealth(engine: EngineRecord, health: HealthResult): Promise<void> {
  await saveHealth(engine.id, {
    status: health.status,
    detail: health.detail,
    latencyMs: health.latencyMs,
    apiHealth: health.apiHealth,
    executionHealth: health.executionHealth,
    lastError: health.lastError,
  });
  if (engine.healthStatus !== health.status || engine.executionHealth !== health.executionHealth) {
    await writeEngineEvent({
      engineId: engine.id,
      engineName: engine.name,
      provider: engine.provider,
      fromStatus: engine.healthStatus,
      toStatus: health.status,
      message: health.detail,
    });
    console.info(
      `[execution] ${engine.name}: ${engine.healthStatus} → ${health.status} ` +
        `(api ${health.apiHealth}, execution ${health.executionHealth}) ${health.detail}`,
    );
  }
}

/** Runs the health check for every configured engine (admin refresh + heartbeat). */
export async function checkAllEngines(options: { probeExecution?: boolean } = {}): Promise<void> {
  const engines = await cachedEngines(true);
  for (const engine of engines) {
    if (!engine.enabled) {
      if (engine.healthStatus !== "DISABLED") {
        await applyHealth(engine, {
          status: "DISABLED",
          detail: "Engine is disabled by the administrator.",
          latencyMs: 0,
          languages: [],
          available: [],
          compilerTest: null,
          apiHealth: "DISABLED",
          executionHealth: "DISABLED",
          lastError: "",
        });
      }
      continue;
    }
    if (!engine.baseUrl.trim()) {
      await applyHealth(engine, {
        status: "UNAVAILABLE",
        detail: "No Base URL configured.",
        latencyMs: 0,
        languages: [],
        available: [],
        compilerTest: null,
        apiHealth: "UNAVAILABLE",
        executionHealth: "UNAVAILABLE",
        lastError: "No Base URL configured.",
      });
      continue;
    }
    const health = await checkEngineHealth(engine, options);
    await applyHealth(engine, health);
  }
  invalidateEngineCache();
}

let lastHeartbeat = 0;

/**
 * Background heartbeat, triggered opportunistically by admin polling. Runs at
 * most once every 60 seconds.
 *
 * It is awaited by its callers on purpose: on Cloudflare Workers, work left
 * running after a response has been sent keeps using sockets that belong to
 * the finished request, which raises "Cannot perform I/O on behalf of a
 * different request".
 */
export async function maybeHeartbeat(): Promise<void> {
  if (Date.now() - lastHeartbeat < 60_000) return;
  lastHeartbeat = Date.now();
  try {
    await checkAllEngines({ probeExecution: true });
  } catch (err) {
    console.error("[execution] heartbeat failed", err);
  }
}


/* ================================================================== */
/* ExecutionRouter                                                     */
/* ================================================================== */

const HEALTH_ORDER: Record<EngineHealth, number> = {
  HEALTHY: 0,
  UNKNOWN: 1,
  DEGRADED: 2,
  UNAVAILABLE: 3,
  DISABLED: 4,
};

let roundRobin = 0;

function candidatesFor(engines: EngineRecord[], language: Language, mode: ExecutionMode): EngineRecord[] {
  const usable = engines.filter(
    (engine) => engine.enabled && engine.baseUrl.trim() && engine.supportedLanguages.includes(language),
  );
  const byPriority = [...usable].sort(
    (a, b) => a.priority - b.priority || a.createdAt.localeCompare(b.createdAt),
  );
  // Only engines that have actually executed the reference program may serve
  // student code. An engine whose API answers but whose sandbox is broken
  // (Judge0 status 13 / "/box/main.c" missing) is never selected here.
  const preferred = byPriority.filter(
    (engine) => engine.executionHealth === "HEALTHY" && engine.apiHealth !== "UNAVAILABLE",
  );
  // Engines that have never been probed are kept as a last resort so a freshly
  // configured or recovered engine is still tried instead of the run failing.
  const rest = byPriority.filter(
    (engine) => !preferred.includes(engine) && engine.executionHealth === "UNKNOWN",
  );
  const ordered = [
    ...preferred.sort((a, b) => HEALTH_ORDER[a.healthStatus] - HEALTH_ORDER[b.healthStatus] || a.priority - b.priority),
    ...rest,
  ];

  if (mode === "LOAD_BALANCED" && preferred.length > 1) {
    const rotation = preferred.slice();
    const offset = roundRobin++ % rotation.length;
    return [...rotation.slice(offset), ...rotation.slice(0, offset), ...rest];
  }
  return ordered;
}


export type RoutedResult = ExecResult & { engineName: string; provider: string; attempts: number };

/**
 * The public execution entry point. Tries each candidate engine in order and
 * returns the first real result.
 */
export async function routeExecution(input: ExecInput): Promise<RoutedResult> {
  const language = normalizeLanguage(input.language);
  if (!language) {
    throw new ExecutionServiceError(
      `${String(input.language)} is not available on this platform.`,
      `unsupported language ${String(input.language)}`,
    );
  }

  const [engines, mode] = await Promise.all([cachedEngines(), readExecutionMode()]);
  const candidates = candidatesFor(engines, language, mode);
  const executionId = crypto.randomUUID();
  const purpose = input.purpose ?? "RUN";
  /** Set when the Piston pool was tried and failed for infrastructure reasons. */
  let poolError: ExecutionServiceError | null = null;


  // ---------------------------------------------------------------------
  // Piston node pool first: the configured multi-VM layer. It handles sticky
  // student assignment, capacity, retries and failover between Piston VMs.
  // When it cannot serve the request at all we continue with the existing
  // engine list below, which preserves the Judge0 fallback unchanged.
  // ---------------------------------------------------------------------
  if (!input.baseUrl?.trim()) {
    const poolStarted = Date.now();
    try {
      const { runOnPistonPool } = await import("./piston-pool.server");
      const pooled = await runOnPistonPool({ ...input, language });
      console.info(
        `[execution] piston pool ${pooled ? "served" : "declined"} purpose=${purpose} ` +
          `language=${language} ms=${Date.now() - poolStarted}`,
      );
      if (pooled) {
        await writeExecutionRecord({
          executionId,
          submissionId: input.submissionId ?? null,
          engineName: `Piston pool (${pooled.nodeId})`,
          provider: "PISTON",
          attempt: pooled.attempts,
          purpose,
          language,
          status: pooled.status ?? "ACCEPTED",
          latencyMs: Date.now() - poolStarted,
          detail: pooled.message,
        });
        return {
          ...pooled,
          engineName: `Piston pool (${pooled.nodeId})`,
          provider: "PISTON",
          attempts: pooled.attempts,
        };
      }
    } catch (err) {
      const error =
        err instanceof ExecutionServiceError
          ? err
          : new ExecutionServiceError(
              ALL_ENGINES_DOWN_MESSAGE,
              err instanceof Error ? err.message : "piston pool failure",
            );
      console.error(`[execution] piston pool failed: ${error.detail}`);
      await writeExecutionRecord({
        executionId,
        submissionId: input.submissionId ?? null,
        engineName: "Piston pool",
        provider: "PISTON",
        attempt: 1,
        purpose,
        language,
        status: "EXECUTION_SERVICE_UNAVAILABLE",
        latencyMs: Date.now() - poolStarted,
        uncertain: error.uncertain,
        detail: error.detail,
      });
      // A timed-out run may still be executing on the VM: never re-run it.
      if (error.uncertain) throw error;
      // The language is not installed anywhere in the pool: no engine can help.
      if (error.name === "LanguageUnavailableError") throw error;
      poolError = error;
      // Otherwise fall through to the configured engines / Judge0 fallback.
    }
  }

  if (!candidates.length) {
    // The pool was tried and genuinely failed: report *that*, never a
    // misleading "not configured" message.
    if (poolError) throw poolError;
    await writeExecutionRecord({
      executionId,
      submissionId: input.submissionId ?? null,
      provider: "PISTON",
      attempt: 1,
      purpose,
      language,
      status: "EXECUTION_SERVICE_UNAVAILABLE",
      latencyMs: 0,
      detail: "no engine is enabled for this language",
    });
    throw new ExecutionServiceError(
      NOT_CONFIGURED_MESSAGE,
      "No enabled execution engine supports this language. Configure one under Admin → Execution engines.",
    );
  }


  let attempt = 0;
  let lastError: ExecutionServiceError | null = null;


  for (const engine of candidates) {
    attempt += 1;
    const started = Date.now();
    try {
      const result = await adapterFor(engine.provider).execute(targetOf(engine), input);
      const latencyMs = Date.now() - started;
      await Promise.all([
        recordEngineOutcome(engine.id, { success: true, latencyMs }),
        writeExecutionRecord({
          executionId,
          submissionId: input.submissionId ?? null,
          engineId: engine.id,
          engineName: engine.name,
          provider: engine.provider,
          attempt,
          purpose,
          language,
          status: result.status ?? "ACCEPTED",
          latencyMs,
          detail: result.message,
        }),
      ]);
      if (engine.healthStatus === "UNAVAILABLE" || engine.healthStatus === "UNKNOWN") {
        await applyHealth(engine, {
          status: "HEALTHY",
          detail: "Recovered: a live submission executed successfully.",
          latencyMs,
          languages: [],
          available: [],
          compilerTest: null,
          apiHealth: "HEALTHY",
          executionHealth: "HEALTHY",
          lastError: "",
        });

      }
      return { ...result, engineName: engine.name, provider: engine.provider, attempts: attempt };
    } catch (err) {
      const error =
        err instanceof ExecutionServiceError
          ? err
          : new ExecutionServiceError(
              ALL_ENGINES_DOWN_MESSAGE,
              err instanceof Error ? err.message : "unknown execution failure",
            );
      const latencyMs = Date.now() - started;
      lastError = error;
      console.error(`[execution] ${engine.name} failed (attempt ${attempt}): ${error.detail}`);
      await Promise.all([
        recordEngineOutcome(engine.id, { success: false, latencyMs }),
        writeExecutionRecord({
          executionId,
          submissionId: input.submissionId ?? null,
          engineId: engine.id,
          engineName: engine.name,
          provider: engine.provider,
          attempt,
          purpose,
          language,
          status: "EXECUTION_SERVICE_UNAVAILABLE",
          latencyMs,
          uncertain: error.uncertain,
          detail: error.detail,
        }),
        applyHealth(engine, {
          status: "UNAVAILABLE",
          detail: error.detail,
          latencyMs,
          languages: [],
          available: [],
          compilerTest: null,
          // A failed live run proves the execution path is broken; the API may
          // still be reachable, so it keeps its previously observed status.
          apiHealth: engine.apiHealth === "UNKNOWN" ? "UNAVAILABLE" : engine.apiHealth,
          executionHealth: "UNAVAILABLE",
          lastError: error.detail,
        }),

      ]);

      // A timed-out execution may already be running on that engine; retrying
      // elsewhere could double-execute and double-count, so stop here.
      if (error.uncertain) throw error;
    }
  }

  throw new ExecutionServiceError(ALL_ENGINES_DOWN_MESSAGE, lastError?.detail ?? "every engine failed");
}

/**
 * Ad-hoc test for the admin panel: runs against values that have not
 * necessarily been saved yet. Never mutates engine state.
 *
 * mode "CONNECTION" only probes the provider API (reachability + JSON + language
 * catalogue); mode "COMPILER" additionally compiles and runs the reference C
 * program, which is the only thing that makes an engine execution-ready.
 */
export async function testEngineTarget(
  target: EngineTarget,
  mode: "CONNECTION" | "COMPILER" = "COMPILER",
): Promise<{
  connected: boolean;
  executionReady: boolean;
  mode: "CONNECTION" | "COMPILER";
  endpoint: string;
  status: EngineHealth;
  detail: string;
  latencyMs: number;
  languages: string[];
  compilerTest: CompilerTest | null;
}> {
  const adapter = adapterFor(target.provider);
  const { healthEndpointFor, normalizeProviderBaseUrl } = await import("./exec-engines");
  const endpoint = healthEndpointFor(target.provider, normalizeProviderBaseUrl(target.baseUrl).baseUrl || "?");
  try {
    const probe = await adapter.probeApi(target);
    if (mode === "CONNECTION") {
      return {
        connected: true,
        executionReady: false,
        mode,
        endpoint,
        status: "DEGRADED",
        detail: `${probe.detail} Valid JSON received from ${endpoint}. Run "Test C compiler" to confirm the engine can execute code.`,
        latencyMs: probe.latencyMs,
        languages: probe.languages,
        compilerTest: null,
      };
    }
    const compilerTest = await runCompilerTest(target);
    return {
      connected: true,
      executionReady: compilerTest.ok,
      mode,
      endpoint,
      status: compilerTest.ok ? "HEALTHY" : "UNAVAILABLE",
      detail: compilerTest.ok
        ? `${probe.detail} C compiled and printed "${ENGINE_TEST_EXPECTED}" in ${compilerTest.executionTimeMs}ms.`
        : `API reachable but the C test program failed: ${compilerTest.detail}`,
      latencyMs: probe.latencyMs,
      languages: probe.languages,
      compilerTest,
    };
  } catch (err) {
    const detail =
      err instanceof ExecutionServiceError ? err.detail : err instanceof Error ? err.message : "unknown error";
    return {
      connected: false,
      executionReady: false,
      mode,
      endpoint,
      status: "UNAVAILABLE",
      detail,
      latencyMs: 0,
      languages: [],
      compilerTest: null,
    };
  }
}
