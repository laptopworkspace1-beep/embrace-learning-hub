/**
 * Shared low-level plumbing for every execution provider: the error type, the
 * student-facing messages, base-URL validation, the guarded fetch and the
 * defensive JSON reader.
 *
 * This module is the single definition of `ExecutionServiceError`, so
 * `instanceof` works consistently across the router, the adapters and the
 * legacy `execution.server` entry points that re-export it.
 */
import {
  describeBaseUrlProblem,
  normalizeProviderBaseUrl,
  type BaseUrlProblem,
  type ExecOutcome,
  type NormalizedStatus,
} from "./exec-engines";

export const SERVICE_UNAVAILABLE_MESSAGE =
  "Code execution is temporarily unavailable. Please contact the event administrator.";
export const NOT_CONFIGURED_MESSAGE = "Code execution service is not configured.";
export const ALL_ENGINES_DOWN_MESSAGE =
  "All execution engines are currently unavailable. Please contact the event administrator.";

/** Raised for infrastructure failures only — never for participant mistakes. */
export class ExecutionServiceError extends Error {
  /**
   * `uncertain` is true when the request may have executed on the provider even
   * though we never saw the answer (network abort / timeout). The router must
   * NOT retry an uncertain attempt on another engine.
   */
  constructor(
    message: string,
    readonly detail: string,
    readonly uncertain = false,
  ) {
    super(message);
    this.name = "ExecutionServiceError";
  }
}

/** Why an engine is unusable, in terms safe to show an administrator. */
export type ConfigProblem = BaseUrlProblem | "disabled";

/**
 * The engine is healthy but simply does not have that language installed.
 * This is a configuration fact, not a node fault: it must never mark a node
 * unhealthy and never trigger a failover to another node.
 */
export class LanguageUnavailableError extends ExecutionServiceError {
  constructor(message: string, detail: string) {
    super(message, detail);
    this.name = "LanguageUnavailableError";
  }
}

/**
 * Strips trailing slashes and any provider API suffix. Thin wrapper over the one
 * shared normalizer so server and admin UI can never diverge.
 */
export function normalizeBaseUrl(value: string): string {
  return normalizeProviderBaseUrl(value).baseUrl;
}

/**
 * Validates only the *shape* of a base URL. Reachability is never guessed from
 * the hostname — it is always decided by calling the provider's API.
 */
export function resolveBaseUrl(raw: string): { baseUrl: string; problem: ConfigProblem | null } {
  return normalizeProviderBaseUrl(raw);
}

export function describeConfigProblem(problem: ConfigProblem): string {
  return problem === "disabled" ? "This execution engine is switched off." : describeBaseUrlProblem(problem);
}

export function truncate(value: unknown, max = 4000): string {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, max)}\n… output truncated` : text;
}

/**
 * fetch with a hard timeout. `isExecution` marks the call as state-changing, so
 * a timeout becomes an *uncertain* failure that must never be retried blindly.
 */
export async function providerFetch(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  isExecution = false,
): Promise<Response> {
  const controller = new AbortController();
  const budget = Math.min(Math.max(timeoutMs || 20_000, 2_000), 60_000);
  const timer = setTimeout(() => controller.abort(), budget);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    const aborted = err instanceof Error && (err.name === "AbortError" || /abort/i.test(err.message));
    throw new ExecutionServiceError(
      SERVICE_UNAVAILABLE_MESSAGE,
      aborted ? `request timed out after ${budget}ms` : err instanceof Error ? err.message : "network failure",
      aborted && isExecution,
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reads a provider response as JSON *defensively*. A misconfigured base URL
 * (a forwarded URL behind a login page, or a reverse proxy) answers with an
 * HTML document — parsing that blindly is what produces `Unexpected token '<'`.
 * Status and content-type are inspected first and only a short server-side
 * diagnostic snippet is kept.
 */
export async function readProviderJson(res: Response, label: string, expectedPath?: string): Promise<unknown> {
  const contentType = res.headers.get("content-type") ?? "unknown";
  const looksJson = /json/i.test(contentType);

  if (!res.ok || !looksJson) {
    const snippet = (await res.text().catch(() => "")).slice(0, 300).replace(/\s+/g, " ").trim();
    const html = /^\s*<(!doctype|html)/i.test(snippet);
    const codespaces = /github\.dev|githubpreview|codespaces/i.test(snippet) || res.headers.has("x-github-request-id");
    const cloudflare = /cloudflare|cf-ray/i.test(snippet) || res.headers.has("cf-ray");

    let hint = "";
    if (res.status === 401 || res.status === 403) {
      const edgeBlocked =
        /error code: 100\d/i.test(snippet) || (res.headers.has("cf-ray") && !/json/i.test(contentType));
      hint = edgeBlocked
        ? " The request was refused by the hosting platform's outbound network edge before it reached the engine" +
          (/error code: 1003/i.test(snippet)
            ? " (Cloudflare error 1003 — direct IP destinations are not allowed; use a DNS hostname for the engine)."
            : " (Cloudflare edge rejection). This is a network/egress problem, not engine authentication.")
        : codespaces
        ? " The forwarded Codespaces port is PRIVATE — set the port visibility to Public, or the engine requires an API key."
        : " The engine requires authentication — configure its API key / token, or make the endpoint publicly reachable.";
    } else if (res.status === 404) {
      hint = expectedPath
        ? ` Expected ${expectedPath} to exist. Check that the Base URL points at the API root (no /api/v2, /languages or /submissions suffix).`
        : " Check that the Base URL points at the API root.";
    } else if (res.status === 502 || res.status === 503 || res.status === 504) {
      hint = " The engine is not answering — the service or forwarded port is probably not running.";
    } else if (html) {
      hint = codespaces
        ? " A Codespaces error page was served instead of JSON — the port is not running or not public."
        : cloudflare
          ? " A Cloudflare page was served instead of JSON — the request never reached the engine."
          : " The address served a web page instead of the JSON API — check the URL and that the port is public.";
    }

    const detail =
      `${label}: endpoint returned HTTP ${res.status} with content-type ${contentType}.` +
      hint +
      (html || hint ? "" : ` Body starts with: ${snippet}`);
    console.error("[execution] non-JSON response —", detail);
    throw new ExecutionServiceError(SERVICE_UNAVAILABLE_MESSAGE, detail);
  }

  try {
    return await res.json();
  } catch {
    const detail = `${label}: response advertised JSON but could not be parsed (invalid JSON, status ${res.status})`;
    console.error("[execution]", detail);
    throw new ExecutionServiceError(SERVICE_UNAVAILABLE_MESSAGE, detail);
  }
}

/**
 * fetch + read in one step, so a `Response` object never becomes a variable an
 * adapter could hold on to. The body is consumed inside the very call that
 * created it and only plain, serializable data is handed back — the hosting
 * runtime refuses I/O objects that outlive their own request.
 */
export async function providerJson(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  label: string,
  expectedPath?: string,
  isExecution = false,
): Promise<unknown> {
  const response = await providerFetch(url, init, timeoutMs, isExecution);
  return readProviderJson(response, label, expectedPath);
}



/** One compile+run request, provider independent. */
export type ExecInput = {
  language: string;
  code: string;
  stdin?: string;
  timeLimitSec?: number;
  memoryLimitMb?: number;
  /** Admin health-check only: run against an unsaved base URL. */
  baseUrl?: string;
  /** Optional correlation for the execution audit trail. */
  submissionId?: string | null;
  /** Stable server-side student identity — drives sticky Piston node assignment. */
  studentId?: string | null;
  /** Round/session the execution belongs to, for sticky assignment. */
  roundId?: string | null;
  purpose?: "RUN" | "SUBMIT" | "HEALTH" | "TEST";
};

/** The normalized result every provider must produce. */
export interface ExecResult {
  outcome: ExecOutcome;
  stdout: string;
  stderr: string;
  compileOutput: string;
  exitCode: number;
  durationMs: number;
  memoryKb: number;
  /** Safe, student-facing message. Never contains infrastructure detail. */
  message: string;
  /** Spec-wording status. */
  status?: NormalizedStatus;
  /** Which engine served the request (filled in by the router). */
  engineName?: string;
  provider?: string;
  signal?: string;
}
