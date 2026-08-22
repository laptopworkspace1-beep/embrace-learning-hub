/**
 * Provider adapters. Each adapter speaks exactly one execution API and returns
 * the common CodeArena execution result. All provider URLs, keys and headers
 * live here on the server; nothing in this module is importable by the browser.
 *
 *   ProviderAdapter
 *     ├── PistonAdapter    (Piston  — also used by PROVIDER3)
 *     └── Judge0Adapter    (Judge0  — also used by PROVIDER4)
 */
import {
  ENGINE_TEST_EXPECTED,
  ENGINE_TEST_PROGRAM,
  JUDGE0_LANGUAGE_IDS,
  LANGUAGE_LABELS,
  PISTON_LANGUAGES,
  normalizeLanguage,
  normalizeOutput,
  outcomeToStatus,
  providerFlavour,
  type Language,
  type Provider,
} from "./exec-engines";
import {
  ExecutionServiceError,
  LanguageUnavailableError,
  NOT_CONFIGURED_MESSAGE,
  SERVICE_UNAVAILABLE_MESSAGE,
  providerJson,
  resolveBaseUrl,
  truncate,
  type ExecInput,
  type ExecResult,
} from "./exec-error.server";

/** Everything an adapter needs to talk to one configured engine. */
export type EngineTarget = {
  id?: string | null;
  name: string;
  provider: Provider;
  baseUrl: string;
  apiKey?: string;
  timeoutMs: number;
};

export type ApiProbe = {
  ok: boolean;
  detail: string;
  latencyMs: number;
  /** Human-readable runtime/language list for the admin panel. */
  languages: string[];
  /** Canonical languages the engine actually advertises. */
  available: Language[];
};

export interface ProviderAdapter {
  readonly flavour: "PISTON" | "JUDGE0";
  /** Cheap API probe: reachability + JSON shape + language catalogue. */
  probeApi(target: EngineTarget): Promise<ApiProbe>;
  /** One compile+run. Throws ExecutionServiceError only for infrastructure faults. */
  execute(target: EngineTarget, input: ExecInput): Promise<ExecResult>;
}

function requireBaseUrl(target: EngineTarget): string {
  const resolved = resolveBaseUrl(target.baseUrl ?? "");
  if (!resolved.baseUrl) {
    throw new ExecutionServiceError(
      NOT_CONFIGURED_MESSAGE,
      `${target.name}: no valid http(s) Base URL is configured.`,
    );
  }
  return resolved.baseUrl;
}

function requireLanguage(target: EngineTarget, language: unknown): Language {
  const canonical = normalizeLanguage(language);
  if (!canonical) {
    throw new ExecutionServiceError(
      `${String(language)} is not available on this platform.`,
      `unsupported language ${String(language)}`,
    );
  }
  return canonical;
}

/* ================================================================== */
/* Piston                                                              */
/* ================================================================== */

type PistonStage = {
  stdout?: string;
  stderr?: string;
  output?: string;
  code?: number | null;
  signal?: string | null;
  status?: string | null;
  memory?: number | null;
};

export type Runtime = { language: string; version: string; aliases?: string[] };

/**
 * Per-node timeout ceilings, learned from the node's own HTTP 400 answer and
 * cached for the process so later executions are accepted on the first try.
 */
const runLimits = new Map<string, number>();
const compileLimits = new Map<string, number>();
/** Piston's stock configuration; used until a node tells us otherwise. */
const DEFAULT_RUN_LIMIT_MS = 3_000;
const DEFAULT_COMPILE_LIMIT_MS = 10_000;

function runLimitFor(baseUrl: string): number {
  return runLimits.get(baseUrl) ?? DEFAULT_RUN_LIMIT_MS;
}

function compileLimitFor(baseUrl: string): number {
  return compileLimits.get(baseUrl) ?? DEFAULT_COMPILE_LIMIT_MS;
}

function rememberLimit(store: Map<string, number>, baseUrl: string, value: number) {
  if (Number.isFinite(value) && value > 0) store.set(baseUrl, value);
}

/** Extracts "<run|compile>_timeout cannot exceed the configured limit of N". */
/**
 * Turns Piston's "<lang>-* runtime is unknown" answer into a clear
 * language-availability error instead of an infrastructure failure.
 */
function asLanguageError(err: unknown, target: EngineTarget, language: Language): unknown {
  const text = err instanceof ExecutionServiceError ? err.detail : err instanceof Error ? err.message : "";
  if (!/runtime is unknown/i.test(text)) return err;
  return new LanguageUnavailableError(
    `${LANGUAGE_LABELS[language]} is not installed on the execution engine. Please contact the event administrator.`,
    `${target.name}: ${text}`,
  );
}

function parseTimeoutLimits(err: unknown): { run?: number; compile?: number } | null {
  const text = err instanceof ExecutionServiceError ? err.detail : err instanceof Error ? err.message : "";
  if (!text) return null;
  const out: { run?: number; compile?: number } = {};
  const run = /run_timeout cannot exceed the configured limit of (\d+)/i.exec(text);
  const compile = /compile_timeout cannot exceed the configured limit of (\d+)/i.exec(text);
  if (run?.[1]) out.run = Number(run[1]);
  if (compile?.[1]) out.compile = Number(compile[1]);
  return out.run === undefined && out.compile === undefined ? null : out;
}

export const pistonAdapter: ProviderAdapter = {
  flavour: "PISTON",

  async probeApi(target) {
    const baseUrl = requireBaseUrl(target);
    const started = Date.now();
    const body = await providerJson(
      `${baseUrl}/api/v2/runtimes`,
      { headers: { accept: "application/json" } },
      target.timeoutMs,
      `${target.name} runtimes`,
      "GET {BASE_URL}/api/v2/runtimes",
    );
    const latencyMs = Date.now() - started;
    if (!Array.isArray(body)) {
      throw new ExecutionServiceError(
        SERVICE_UNAVAILABLE_MESSAGE,
        `${target.name}: /api/v2/runtimes did not return a JSON array of runtimes.`,
      );
    }
    const runtimes = body as Runtime[];
    const available: Language[] = [];
    for (const [lang, spec] of Object.entries(PISTON_LANGUAGES) as [Language, { piston: string }][]) {
      const match = runtimes.some(
        (rt) =>
          String(rt.language ?? "").toLowerCase() === spec.piston ||
          rt.aliases?.some((alias) => String(alias).toLowerCase() === spec.piston),
      );
      if (match) available.push(lang);
    }
    return {
      ok: true,
      detail: `Piston API reachable with ${runtimes.length} runtimes.`,
      latencyMs,
      languages: runtimes.map((rt) => `${rt.language} ${rt.version}`),
      available,
    };
  },

  async execute(target, input) {
    const baseUrl = requireBaseUrl(target);
    const language = requireLanguage(target, input.language);
    const spec = PISTON_LANGUAGES[language];
    // Piston instances enforce their own ceilings (commonly 3000ms run /
    // 10000ms compile). Asking for more makes the API answer HTTP 400 and the
    // whole execution fails, so we clamp up-front and adapt to whatever limit
    // the node reports.
    const requestedRunMs = Math.min(Math.max((input.timeLimitSec ?? 2) * 1000, 500), 15_000);
    let runTimeoutMs = Math.min(requestedRunMs, runLimitFor(baseUrl));
    let compileTimeoutMs = Math.min(10_000, compileLimitFor(baseUrl));
    const memoryBytes = Math.min(Math.max(input.memoryLimitMb ?? 128, 16), 512) * 1024 * 1024;
    const started = Date.now();

    const send = async () =>
      (await providerJson(
        `${baseUrl}/api/v2/execute`,
        {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({
            language: spec.piston,
            version: "*",
            files: [{ name: spec.file, content: input.code }],
            stdin: input.stdin ?? "",
            compile_timeout: compileTimeoutMs,
            run_timeout: runTimeoutMs,
            run_memory_limit: memoryBytes,
          }),
        },
        target.timeoutMs,
        `${target.name} execute`,
        undefined,
        true,
      )) as { compile?: PistonStage; run?: PistonStage } | null;

    let payload: { compile?: PistonStage; run?: PistonStage } | null;
    try {
      payload = await send();
    } catch (err) {
      // "run_timeout cannot exceed the configured limit of 3000" — learn the
      // node's ceiling, remember it and retry once with a valid payload.
      const limits = parseTimeoutLimits(err);
      if (!limits) throw asLanguageError(err, target, language);
      if (limits.run !== undefined) {
        rememberLimit(runLimits, baseUrl, limits.run);
        runTimeoutMs = Math.min(runTimeoutMs, limits.run);
      }
      if (limits.compile !== undefined) {
        rememberLimit(compileLimits, baseUrl, limits.compile);
        compileTimeoutMs = Math.min(compileTimeoutMs, limits.compile);
      }
      try {
        payload = await send();
      } catch (retryErr) {
        throw asLanguageError(retryErr, target, language);
      }
    }

    const durationMs = Date.now() - started;
    const compile = payload?.compile ?? null;
    const run = payload?.run ?? null;
    const compileOutput = truncate(compile?.stderr || compile?.output || "");

    if (compile && ((compile.code ?? 0) !== 0 || (compile.status && compile.status !== "SUCCESS"))) {
      return finalize({
        outcome: "compilation_error",
        stdout: "",
        stderr: compileOutput,
        compileOutput,
        exitCode: compile.code ?? 1,
        durationMs,
        memoryKb: 0,
        message: "Compilation failed.",
      });
    }

    if (!run) {
      throw new ExecutionServiceError(
        SERVICE_UNAVAILABLE_MESSAGE,
        `${target.name}: execute response contained no run stage.`,
      );
    }

    const stdout = truncate(run.stdout ?? "");
    const stderr = truncate(run.stderr ?? "");
    const memoryKb = Math.max(0, Math.round(Number(run.memory ?? 0) / 1024));
    const signal = String(run.signal ?? "");
    const status = String(run.status ?? "");
    const base = {
      stdout,
      stderr,
      compileOutput,
      exitCode: run.code ?? 0,
      durationMs,
      memoryKb,
      ...(signal ? { signal } : {}),
    };

    if (status === "TO" || (signal === "SIGKILL" && durationMs >= runTimeoutMs)) {
      return finalize({ ...base, outcome: "timeout", message: "Time limit exceeded." });
    }
    if (status === "OL") return finalize({ ...base, outcome: "output_limit", message: "Output limit exceeded." });
    if (status === "EL")
      return finalize({ ...base, outcome: "output_limit", message: "Error output limit exceeded." });
    if (status === "XX") {
      throw new ExecutionServiceError(
        SERVICE_UNAVAILABLE_MESSAGE,
        `${target.name}: the engine reported an internal error.`,
      );
    }
    if (signal === "SIGSEGV" || /out of memory|std::bad_alloc/i.test(stderr)) {
      return finalize({ ...base, outcome: "memory", message: "Memory limit exceeded or invalid memory access." });
    }
    if ((run.code ?? 0) !== 0 || signal) {
      return finalize({ ...base, outcome: "runtime_error", message: "Program terminated with a runtime error." });
    }
    return finalize({ ...base, outcome: "ok", message: "Execution successful." });
  },
};

/* ================================================================== */
/* Judge0                                                              */
/* ================================================================== */

type Judge0Submission = {
  stdout?: string | null;
  stderr?: string | null;
  compile_output?: string | null;
  message?: string | null;
  time?: string | number | null;
  memory?: number | null;
  exit_code?: number | null;
  exit_signal?: number | null;
  status?: { id?: number; description?: string } | null;
  token?: string | null;
};

function judge0Headers(target: EngineTarget): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
  };
  const key = (target.apiKey ?? "").trim();
  if (key) {
    // Self-hosted Judge0 uses X-Auth-Token; hosted (RapidAPI) needs its own header.
    if (/rapidapi/i.test(target.baseUrl)) {
      headers["X-RapidAPI-Key"] = key;
      try {
        headers["X-RapidAPI-Host"] = new URL(target.baseUrl).host;
      } catch {
        /* base URL already validated elsewhere */
      }
    } else {
      headers["X-Auth-Token"] = key;
    }
  }
  return headers;
}

/**
 * The single place in the codebase that speaks the Judge0 HTTP submission API.
 * Everything else goes through the adapter / router.
 */
export const judge0Service = {
  async listLanguages(target: EngineTarget): Promise<{ id: number; name: string }[]> {
    const baseUrl = requireBaseUrl(target);
    const body = await providerJson(
      `${baseUrl}/languages`,
      { headers: judge0Headers(target) },
      target.timeoutMs,
      `${target.name} languages`,
      "GET {BASE_URL}/languages",
    );
    if (!Array.isArray(body)) {
      throw new ExecutionServiceError(
        SERVICE_UNAVAILABLE_MESSAGE,
        `${target.name}: /languages did not return a JSON array.`,
      );
    }
    return (body as { id?: number; name?: string }[])
      .filter((item) => typeof item?.id === "number")
      .map((item) => ({ id: Number(item.id), name: String(item.name ?? item.id) }));
  },

  async about(target: EngineTarget): Promise<Record<string, unknown>> {
    const baseUrl = requireBaseUrl(target);
    return (await providerJson(
      `${baseUrl}/about`,
      { headers: judge0Headers(target) },
      target.timeoutMs,
      `${target.name} about`,
      "GET {BASE_URL}/about",
    )) as Record<string, unknown>;
  },

  /**
   * POST /submissions?base64_encoded=false&wait=true — one synchronous
   * compile+run. Returns the raw Judge0 payload; normalisation happens in the
   * adapter so the mapping lives in exactly one place.
   */
  async executeSubmission(
    target: EngineTarget,
    submission: {
      language: Language;
      sourceCode: string;
      stdin?: string;
      cpuTimeLimitSec?: number;
      memoryLimitMb?: number;
    },
  ): Promise<Judge0Submission> {
    const baseUrl = requireBaseUrl(target);
    const languageId = JUDGE0_LANGUAGE_IDS[submission.language];
    const cpu = Math.min(Math.max(submission.cpuTimeLimitSec ?? 2, 1), 15);
    const memoryKb = Math.min(Math.max(submission.memoryLimitMb ?? 128, 16), 512) * 1024;

    const body: Record<string, unknown> = {
      language_id: languageId,
      source_code: submission.sourceCode,
      cpu_time_limit: cpu,
      wall_time_limit: Math.min(cpu * 2 + 3, 20),
      memory_limit: memoryKb,
    };
    // Only send stdin when the problem actually supplies one.
    if (submission.stdin) body["stdin"] = submission.stdin;

    const payload = (await providerJson(
      `${baseUrl}/submissions?base64_encoded=false&wait=true`,
      { method: "POST", headers: judge0Headers(target), body: JSON.stringify(body) },
      target.timeoutMs,
      `${target.name} submissions`,
      "POST {BASE_URL}/submissions",
      true,
    )) as Judge0Submission | null;
    if (!payload || typeof payload !== "object") {
      throw new ExecutionServiceError(
        SERVICE_UNAVAILABLE_MESSAGE,
        `${target.name}: submission response was not a JSON object.`,
      );
    }
    return payload;
  },
};

export const judge0Adapter: ProviderAdapter = {
  flavour: "JUDGE0",

  async probeApi(target) {
    const started = Date.now();
    const languages = await judge0Service.listLanguages(target);
    const latencyMs = Date.now() - started;
    const available: Language[] = [];
    for (const [lang, id] of Object.entries(JUDGE0_LANGUAGE_IDS) as [Language, number][]) {
      if (languages.some((entry) => entry.id === id)) available.push(lang);
    }
    return {
      ok: true,
      detail: `Judge0 API reachable with ${languages.length} languages.`,
      latencyMs,
      languages: languages.map((entry) => entry.name),
      available,
    };
  },

  async execute(target, input) {
    const language = requireLanguage(target, input.language);
    const started = Date.now();
    const payload = await judge0Service.executeSubmission(target, {
      language,
      sourceCode: input.code,
      ...(input.stdin ? { stdin: input.stdin } : {}),
      ...(input.timeLimitSec ? { cpuTimeLimitSec: input.timeLimitSec } : {}),
      ...(input.memoryLimitMb ? { memoryLimitMb: input.memoryLimitMb } : {}),
    });
    const durationMs = Date.now() - started;

    const statusId = Number(payload.status?.id ?? 0);
    const statusText = String(payload.status?.description ?? "");
    const stdout = truncate(payload.stdout ?? "");
    const stderr = truncate(payload.stderr ?? "");
    const compileOutput = truncate(payload.compile_output ?? "");
    const message = truncate(payload.message ?? "", 500);
    const reportedMs = Math.round(Number(payload.time ?? 0) * 1000);
    const memoryKb = Math.max(0, Math.round(Number(payload.memory ?? 0)));
    const exitCode = Number(payload.exit_code ?? 0);
    const signal = payload.exit_signal ? `SIG${payload.exit_signal}` : "";
    const base = {
      stdout,
      stderr,
      compileOutput,
      exitCode,
      durationMs: reportedMs > 0 ? reportedMs : durationMs,
      memoryKb,
      ...(signal ? { signal } : {}),
    };

    // 1 = In Queue, 2 = Processing: `wait=true` should never return these.
    // 13 = Internal Error, 14 = Exec Format Error → the sandbox itself failed,
    // so this is an infrastructure fault and the router must fail over.
    if (statusId === 13 || statusId === 1 || statusId === 2) {
      throw new ExecutionServiceError(
        SERVICE_UNAVAILABLE_MESSAGE,
        `${target.name}: Judge0 status ${statusId} (${statusText || "Internal Error"})` +
          (message ? ` — ${message}` : ""),
      );
    }

    switch (statusId) {
      case 3: // Accepted
        return finalize({ ...base, outcome: "ok", message: "Execution successful." });
      case 4: // Wrong Answer (only when expected_output was sent)
        return finalize({ ...base, outcome: "ok", status: "WRONG_ANSWER", message: "Output did not match." });
      case 5: // Time Limit Exceeded
        return finalize({ ...base, outcome: "timeout", message: "Time limit exceeded." });
      case 6: // Compilation Error
        return finalize({
          ...base,
          stdout: "",
          stderr: compileOutput || stderr,
          outcome: "compilation_error",
          message: "Compilation failed.",
        });
      case 7: // SIGSEGV
      case 9: // SIGFPE is 8; 9 = SIGABRT in Judge0's table
        return finalize({
          ...base,
          outcome: "memory",
          message: "Memory limit exceeded or invalid memory access.",
        });
      case 8:
      case 10:
      case 11:
      case 12:
      case 14:
        return finalize({
          ...base,
          outcome: "runtime_error",
          message: statusText ? `Runtime error (${statusText}).` : "Program terminated with a runtime error.",
        });
      default:
        throw new ExecutionServiceError(
          SERVICE_UNAVAILABLE_MESSAGE,
          `${target.name}: unexpected Judge0 status ${statusId} ${statusText}`,
        );
    }
  },
};

/** Fills in the normalized status when the adapter did not override it. */
function finalize(result: Omit<ExecResult, "status"> & { status?: ExecResult["status"] }): ExecResult {
  return { ...result, status: result.status ?? outcomeToStatus(result.outcome) };
}

export function adapterFor(provider: Provider): ProviderAdapter {
  return providerFlavour(provider) === "JUDGE0" ? judge0Adapter : pistonAdapter;
}

/* ================================================================== */
/* Reference C compilation test used by every health check             */
/* ================================================================== */

export type CompilerTest = {
  ok: boolean;
  status: string;
  output: string;
  compileOutput: string;
  executionTimeMs: number;
  memoryKb: number;
  detail: string;
};

/** Compiles and runs the reference C program. This is what makes an engine READY. */
export async function runCompilerTest(target: EngineTarget): Promise<CompilerTest> {
  const adapter = adapterFor(target.provider);
  try {
    const result = await adapter.execute(target, {
      language: "C",
      code: ENGINE_TEST_PROGRAM,
      timeLimitSec: 5,
      memoryLimitMb: 128,
    });
    // Success is decided exactly as specified: the run must be accepted, stdout
    // must trim to the expected banner and the compiler must have said nothing.
    const output = normalizeOutput(result.stdout).trim();
    const compileOutput = (result.compileOutput ?? "").trim();
    const ok = result.outcome === "ok" && output === ENGINE_TEST_EXPECTED && !compileOutput;
    const diagnostics = [
      compileOutput ? `compile_output: ${compileOutput.slice(0, 500)}` : "",
      result.stderr ? `stderr: ${result.stderr.slice(0, 500)}` : "",
      result.message ? `message: ${String(result.message).slice(0, 300)}` : "",
      !compileOutput && !result.stderr ? `stdout: ${JSON.stringify(result.stdout.slice(0, 300))}` : "",
    ]
      .filter(Boolean)
      .join(" | ");
    return {
      ok,
      status: result.status ?? "INTERNAL_ERROR",
      output: result.stdout,
      compileOutput: result.compileOutput,
      executionTimeMs: result.durationMs,
      memoryKb: result.memoryKb,
      detail: ok
        ? "C compilation and execution succeeded."
        : `C test program failed (${result.status ?? result.outcome}). ${diagnostics}`.trim(),
    };
  } catch (err) {
    const detail = err instanceof ExecutionServiceError ? err.detail : err instanceof Error ? err.message : "unknown";
    return {
      ok: false,
      status: "EXECUTION_SERVICE_UNAVAILABLE",
      output: "",
      compileOutput: "",
      executionTimeMs: 0,
      memoryKb: 0,
      detail,
    };
  }
}

export function describeLanguages(languages: Language[]): string {
  return languages.map((lang) => LANGUAGE_LABELS[lang]).join(", ");
}
