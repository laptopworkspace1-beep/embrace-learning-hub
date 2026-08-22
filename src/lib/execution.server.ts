/**
 * CodeExecutionService — the single server-side execution/judging entry point
 * used by Round 2 (Bug Hunt) and Round 3 (Code Sprint).
 *
 * Untrusted participant code is NEVER executed in the browser and never on the
 * application server itself. Every compilation and execution is delegated to a
 * configured external execution engine (Piston, Judge0, …) through the
 * multi-engine router in exec-router.server.ts, which handles health checking,
 * priority ordering and automatic failover.
 *
 * This module keeps the historical Piston-oriented API (settings, connection
 * test, executeCode) so existing callers keep working unchanged.
 */
import { ownDb } from "./own-db.server";
import { num, str, type Row } from "./comp.server";
import {
  ExecutionServiceError,
  NOT_CONFIGURED_MESSAGE,
  SERVICE_UNAVAILABLE_MESSAGE,
  type ExecResult,
} from "./exec-error.server";

/**
 * No hard-coded default. The endpoint is whatever the administrator saved in
 * the event settings (falling back to the PISTON_BASE_URL env var), and its
 * validity is decided by actually calling the Piston API — never by hostname.
 */
export const DEFAULT_PISTON_BASE_URL = "";


export type ExecOutcome =
  | "ok"
  | "compilation_error"
  | "runtime_error"
  | "timeout"
  | "memory"
  | "output_limit"
  | "service_error";

export type { ExecResult };

export { SERVICE_UNAVAILABLE_MESSAGE, NOT_CONFIGURED_MESSAGE };

/**
 * Every language the platform can execute. These are the platform's own
 * identifiers; the Piston names live in the single mapping table below and
 * nowhere else in the codebase.
 */
export const EXECUTABLE_LANGUAGES = ["C", "CPP", "JAVA", "PYTHON", "JAVASCRIPT"] as const;
export type Language = (typeof EXECUTABLE_LANGUAGES)[number];

/** Human labels for the admin panel and the student language picker. */
export const LANGUAGE_LABELS: Record<Language, string> = {
  C: "C",
  CPP: "C++",
  JAVA: "Java",
  PYTHON: "Python",
  JAVASCRIPT: "JavaScript",
};

const LANGUAGES: Record<Language, { piston: string; file: string }> = {
  C: { piston: "c", file: "main.c" },
  CPP: { piston: "c++", file: "main.cpp" },
  JAVA: { piston: "java", file: "Main.java" },
  PYTHON: { piston: "python", file: "main.py" },
  JAVASCRIPT: { piston: "javascript", file: "main.js" },
};

/** Aliases accepted from stored data / older records. Never from raw client trust. */
const ALIASES: Record<string, Language> = {
  C: "C",
  CPP: "CPP",
  "C++": "CPP",
  CXX: "CPP",
  JAVA: "JAVA",
  PYTHON: "PYTHON",
  PY: "PYTHON",
  PYTHON3: "PYTHON",
  JAVASCRIPT: "JAVASCRIPT",
  JS: "JAVASCRIPT",
  NODE: "JAVASCRIPT",
};

/** Canonicalises any incoming language string, or null when unsupported. */
export function normalizeLanguage(language: unknown): Language | null {
  const key = String(language ?? "").trim().toUpperCase();
  return ALIASES[key] ?? null;
}

/** Application language → Piston language. The single mapping in the project. */
export function mapLanguage(language: unknown): { piston: string; file: string } | null {
  const canonical = normalizeLanguage(language);
  return canonical ? LANGUAGES[canonical] : null;
}

export function isExecutable(language: string): boolean {
  return normalizeLanguage(language) !== null;
}

export const DEFAULT_ROUND3_LANGUAGES: Language[] = ["C"];

/** Parses the stored Round 3 allow-list, always returning at least one language. */
export function parseLanguageList(value: unknown): Language[] {
  let raw: unknown = value;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      raw = String(value)
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean);
    }
  }
  if (!Array.isArray(raw)) return [...DEFAULT_ROUND3_LANGUAGES];
  const out: Language[] = [];
  for (const item of raw) {
    const lang = normalizeLanguage(item);
    if (lang && !out.includes(lang)) out.push(lang);
  }
  return out.length ? out : [...DEFAULT_ROUND3_LANGUAGES];
}

/** Why the engine is unusable, in terms safe to show an administrator. */
export type ConfigProblem = "missing" | "invalid_url" | "disabled";

export type ExecutionConfig = {
  baseUrl: string;
  enabled: boolean;
  timeoutMs: number;
  configured: boolean;
  round3Languages: Language[];
  /** Set when the endpoint cannot be used from this backend. */
  problem: ConfigProblem | null;
};

let cache: { at: number; config: ExecutionConfig } | null = null;

/** Strips trailing slashes and any accidental /api/v2 suffix. */
export function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "").replace(/\/api\/v2(\/.*)?$/i, "").replace(/\/+$/, "");
}

/**
 * Validates only the *shape* of a base URL. Reachability is never guessed from
 * the hostname — it is decided by calling GET {baseUrl}/api/v2/runtimes.
 */
export function resolveBaseUrl(raw: string): { baseUrl: string; problem: ConfigProblem | null } {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return { baseUrl: "", problem: "missing" };
  const candidate = normalizeBaseUrl(trimmed);
  if (!/^https?:\/\/[^\s/]+/i.test(candidate)) return { baseUrl: "", problem: "invalid_url" };
  try {
    new URL(candidate);
  } catch {
    return { baseUrl: "", problem: "invalid_url" };
  }
  return { baseUrl: candidate, problem: null };
}

/**
 * Reads server-owned engine settings (cached briefly). The base URL comes from
 * the administrator-saved value in event_settings, falling back to the
 * PISTON_BASE_URL environment variable when nothing has been saved yet.
 */
export async function getExecutionConfig(force = false): Promise<ExecutionConfig> {
  if (!force && cache && Date.now() - cache.at < 10_000) return cache.config;

  let row: Row | null = null;
  try {
    const { data } = await ownDb()
      .from("event_settings")
      .select('pistonBaseUrl, pistonEnabled, pistonTimeoutMs, round3Languages')
      .limit(1);
    row = (data?.[0] as Row | undefined) ?? null;
  } catch (err) {
    console.error("[execution] could not read engine settings", err);
  }

  const saved = String(row?.["pistonBaseUrl"] ?? "").trim();
  const raw = saved || (process.env["PISTON_BASE_URL"] || DEFAULT_PISTON_BASE_URL).trim();
  const resolved = resolveBaseUrl(raw);
  let problem = resolved.problem;
  const baseUrl = resolved.baseUrl;

  const enabled = row?.["pistonEnabled"] === undefined ? true : Boolean(row["pistonEnabled"]);
  if (!problem && !enabled) problem = "disabled";
  const timeoutMs = Math.min(Math.max(num(row?.["pistonTimeoutMs"], 20_000), 2_000), 60_000);
  const config: ExecutionConfig = {
    baseUrl,
    enabled,
    timeoutMs,
    configured: Boolean(baseUrl) && enabled,
    round3Languages: parseLanguageList(row?.["round3Languages"]),
    problem,
  };
  cache = { at: Date.now(), config };
  return config;
}

/** Administrator-facing explanation of a configuration problem. No secrets. */
export function describeConfigProblem(problem: ConfigProblem): string {
  switch (problem) {
    case "missing":
      return "No Piston Base URL is configured. Enter the address of a Piston instance this backend can reach and save the engine settings.";
    case "invalid_url":
      return "The Piston Base URL is not a valid http(s) URL, for example https://my-piston-host or http://localhost:2001.";
    case "disabled":
      return "The execution engine is switched off in these settings.";
  }
}


/** Languages the administrator currently offers for Round 3. */
export async function getRound3Languages(): Promise<Language[]> {
  return (await getExecutionConfig()).round3Languages;
}

/**
 * Server-side authority for Round 3 language choice. The client list is only a
 * convenience; this check is what actually decides.
 */
export async function assertRound3Language(language: unknown): Promise<Language> {
  const canonical = normalizeLanguage(language);
  const allowed = await getRound3Languages();
  if (!canonical || !allowed.includes(canonical)) {
    throw new Error("That programming language is not available for this round.");
  }
  return canonical;
}


export function invalidateExecutionConfig() {
  cache = null;
}

/**
 * `ExecutionServiceError` now lives in exec-error.server.ts so the router, the
 * provider adapters and the legacy call sites all share one class (and one
 * working `instanceof`). Re-exported here for existing importers.
 */
export { ExecutionServiceError };

async function pistonFetch(
  path: string,
  init: RequestInit,
  timeoutMs: number,
  overrideBaseUrl?: string,
): Promise<Response> {
  const config = await getExecutionConfig();
  let baseUrl = config.baseUrl;
  if (overrideBaseUrl) {
    const resolved = resolveBaseUrl(overrideBaseUrl);
    if (!resolved.baseUrl) {
      throw new ExecutionServiceError(NOT_CONFIGURED_MESSAGE, describeConfigProblem(resolved.problem ?? "missing"));
    }
    baseUrl = resolved.baseUrl;
  } else if (!config.configured) {
    throw new ExecutionServiceError(
      NOT_CONFIGURED_MESSAGE,
      describeConfigProblem(config.problem ?? "missing"),
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || config.timeoutMs);
  try {
    return await fetch(`${baseUrl}${path}`, { ...init, signal: controller.signal });
  } catch (err) {
    throw new ExecutionServiceError(
      SERVICE_UNAVAILABLE_MESSAGE,
      err instanceof Error ? err.message : "network failure",
    );
  } finally {
    clearTimeout(timer);
  }
}

export type Runtime = { language: string; version: string; aliases?: string[] };

/**
 * Reads a Piston response as JSON *defensively*. A misconfigured base URL (for
 * example a Codespaces forwarded URL behind a login page, or a reverse proxy)
 * answers with an HTML document — parsing that blindly is what produced the
 * infamous `Unexpected token '<'` error. We inspect status and content-type
 * first and only ever keep a short, server-side diagnostic snippet.
 */
async function readPistonJson(res: Response, label: string): Promise<unknown> {
  const contentType = res.headers.get("content-type") ?? "unknown";
  const looksJson = /json/i.test(contentType);

  if (!res.ok || !looksJson) {
    const snippet = (await res.text().catch(() => "")).slice(0, 200).replace(/\s+/g, " ").trim();
    const html = /^\s*<(!doctype|html)/i.test(snippet);
    const detail =
      `${label}: Piston endpoint returned HTTP ${res.status} with content-type ${contentType}` +
      (html
        ? ". The address served a web page instead of the Piston JSON API."
        : `. Body starts with: ${snippet}`);
    console.error("[execution] non-JSON response from Piston —", detail);
    throw new ExecutionServiceError(SERVICE_UNAVAILABLE_MESSAGE, detail);
  }

  try {
    return await res.json();
  } catch {
    const detail = `${label}: response advertised JSON but could not be parsed (status ${res.status})`;
    console.error("[execution]", detail);
    throw new ExecutionServiceError(SERVICE_UNAVAILABLE_MESSAGE, detail);
  }
}

export async function getRuntimes(overrideBaseUrl?: string): Promise<Runtime[]> {
  const config = await getExecutionConfig(true);
  const res = await pistonFetch(
    "/api/v2/runtimes",
    { method: "GET" },
    Math.min(config.timeoutMs, 15_000),
    overrideBaseUrl,
  );
  const body = await readPistonJson(res, "runtimes");
  if (!Array.isArray(body)) {
    throw new ExecutionServiceError(SERVICE_UNAVAILABLE_MESSAGE, "runtimes response was not a JSON list");
  }
  return body as Runtime[];
}

/**
 * Health check. When `overrideBaseUrl` is given the entered address is tested
 * immediately, without having to save it first.
 */
export async function testConnection(overrideBaseUrl?: string): Promise<{
  connected: boolean;
  runtimes: Runtime[];
  cRuntimeAvailable: boolean;
  cRuntimeVersion?: string;
  executionVerified: boolean;
  /** Non-secret, admin-facing next step when the engine is unreachable. */
  hint?: string;
  error?: string;
  detail?: string;
}> {
  const config = await getExecutionConfig(true);
  const override = overrideBaseUrl?.trim() ? resolveBaseUrl(overrideBaseUrl) : null;
  try {
    if (override) {
      if (!override.baseUrl) {
        throw new ExecutionServiceError(
          NOT_CONFIGURED_MESSAGE,
          describeConfigProblem(override.problem ?? "missing"),
        );
      }
    } else if (!config.configured) {
      throw new ExecutionServiceError(
        NOT_CONFIGURED_MESSAGE,
        describeConfigProblem(config.problem ?? "missing"),
      );
    }
    const baseUrl = override?.baseUrl;
    const runtimes = await getRuntimes(baseUrl);
    const cRuntime = runtimes.find(
      (runtime) =>
        runtime.language.toLowerCase() === "c" ||
        runtime.aliases?.some((alias) => alias.toLowerCase() === "c"),
    );
    if (!cRuntime) {
      throw new ExecutionServiceError(SERVICE_UNAVAILABLE_MESSAGE, "C runtime is not installed in Piston.");
    }
    const probe = await executeCode({
      language: "C",
      code: '#include <stdio.h>\nint main(){int a=10;int b=20;printf("%d\\n",a+b);return 0;}',
      timeLimitSec: 2,
      memoryLimitMb: 64,
      ...(baseUrl ? { baseUrl } : {}),
    });
    const executionVerified = probe.outcome === "ok" && normalizeOutput(probe.stdout) === "30";
    if (!executionVerified) {
      throw new ExecutionServiceError(
        SERVICE_UNAVAILABLE_MESSAGE,
        `C execution probe failed with outcome ${probe.outcome}.`,
      );
    }
    return {
      connected: true,
      runtimes,
      cRuntimeAvailable: true,
      cRuntimeVersion: cRuntime.version,
      executionVerified,
    };
  } catch (err) {
    const detail =
      err instanceof ExecutionServiceError
        ? err.detail
        : err instanceof Error
          ? err.message
          : "unknown error";
    console.error("[execution] test connection failed", detail);
    const problem = override ? override.problem : config.problem;
    const hint = problem
      ? describeConfigProblem(problem)
      : "The Piston address did not answer with its JSON API from this backend. Confirm the service is running and reachable from where CodeArena is deployed.";
    return {
      connected: false,
      runtimes: [],
      cRuntimeAvailable: false,
      executionVerified: false,
      hint,
      error: err instanceof ExecutionServiceError ? err.message : SERVICE_UNAVAILABLE_MESSAGE,
      detail,
    };
  }
}
/**
 * Compiles and runs one program with one stdin payload.
 *
 * The signature is unchanged, but the work is now delegated to the multi-engine
 * router: it picks the highest-priority healthy engine that supports the
 * language and fails over to the next one when the *infrastructure* fails.
 * Participant errors (compile errors, runtime errors, TLE) are returned as-is
 * and never trigger a failover.
 *
 * `baseUrl` is still honoured for admin connection tests: it bypasses routing
 * and talks to that single Piston address directly.
 */
export async function executeCode(input: {
  language: string;
  code: string;
  stdin?: string;
  timeLimitSec?: number;
  memoryLimitMb?: number;
  /** Admin health-check only: run against an unsaved Piston base URL. */
  baseUrl?: string;
  submissionId?: string | null;
  /** Stable student identity used for sticky Piston node assignment. */
  studentId?: string | null;
  /** Round/session identifier used for sticky Piston node assignment. */
  roundId?: string | null;
  purpose?: "RUN" | "SUBMIT" | "HEALTH" | "TEST";
}): Promise<ExecResult> {
  if (input.baseUrl?.trim()) {
    const { pistonAdapter } = await import("./engine-adapters.server");
    const config = await getExecutionConfig();
    return pistonAdapter.execute(
      {
        name: "Piston (ad-hoc test)",
        provider: "PISTON",
        baseUrl: input.baseUrl,
        timeoutMs: config.timeoutMs,
      },
      input,
    );
  }
  const { routeExecution } = await import("./exec-router.server");
  return routeExecution(input);
}


/** Deterministic output comparison used by every round. */
export function normalizeOutput(value: string): string {
  return String(value ?? "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/\n+$/, "");
}

/** Maps an execution outcome to the student-facing status label. */
export function statusLabel(outcome: ExecOutcome): string {
  switch (outcome) {
    case "ok":
      return "Execution successful";
    case "compilation_error":
      return "Compilation error";
    case "runtime_error":
      return "Runtime error";
    case "timeout":
      return "Time limit exceeded";
    case "memory":
      return "Memory limit exceeded";
    case "output_limit":
      return "Output limit exceeded";
    default:
      return "Judge error";
  }
}

/**
 * Increments a compile or run counter for a participant and problem.
 * Called only from explicit Compile/Run actions — autosave never touches it.
 */
export async function recordAttempt(
  studentId: string,
  problemId: string,
  kind: "DEBUG" | "CODE",
  field: "compileAttempts" | "runAttempts",
): Promise<number> {
  try {
    const db = ownDb();
    const { data } = await db
      .from("code_attempts")
      .select("id, compileAttempts, runAttempts")
      .eq("studentId", studentId)
      .eq("problemId", problemId)
      .maybeSingle();
    const now = new Date().toISOString();
    if (data) {
      const next = num((data as Row)[field]) + 1;
      await db
        .from("code_attempts")
        .update({ [field]: next, updatedAt: now })
        .eq("id", str((data as Row)["id"]));
      return next;
    }
    await db.from("code_attempts").insert({
      id: crypto.randomUUID(),
      studentId,
      problemId,
      kind,
      compileAttempts: field === "compileAttempts" ? 1 : 0,
      runAttempts: field === "runAttempts" ? 1 : 0,
      updatedAt: now,
    });
    return 1;
  } catch (err) {
    console.error("[execution] attempt counter failed", err);
    return 0;
  }
}
