/**
 * Pure, client-safe vocabulary of the execution layer: languages, provider
 * kinds, normalized statuses and the per-provider language mapping tables.
 *
 * Nothing here performs I/O and nothing here contains a URL, key or secret, so
 * it is safe for both the server adapters and the admin UI to import.
 */

/* ------------------------------------------------------------------ */
/* Languages                                                           */
/* ------------------------------------------------------------------ */

export const EXECUTABLE_LANGUAGES = ["C", "CPP", "JAVA", "PYTHON", "JAVASCRIPT"] as const;
export type Language = (typeof EXECUTABLE_LANGUAGES)[number];

export const LANGUAGE_LABELS: Record<Language, string> = {
  C: "C",
  CPP: "C++",
  JAVA: "Java",
  PYTHON: "Python",
  JAVASCRIPT: "JavaScript",
};

/** Piston language names and source file names. The only Piston mapping. */
export const PISTON_LANGUAGES: Record<Language, { piston: string; file: string }> = {
  C: { piston: "c", file: "main.c" },
  CPP: { piston: "c++", file: "main.cpp" },
  JAVA: { piston: "java", file: "Main.java" },
  PYTHON: { piston: "python", file: "main.py" },
  JAVASCRIPT: { piston: "javascript", file: "main.js" },
};

/** Judge0 language ids. The only Judge0 mapping. */
export const JUDGE0_LANGUAGE_IDS: Record<Language, number> = {
  C: 50,
  CPP: 54,
  JAVA: 62,
  PYTHON: 71,
  JAVASCRIPT: 63,
};

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

export function normalizeLanguage(language: unknown): Language | null {
  const key = String(language ?? "").trim().toUpperCase();
  return ALIASES[key] ?? null;
}

export function isExecutable(language: string): boolean {
  return normalizeLanguage(language) !== null;
}

export const DEFAULT_ROUND3_LANGUAGES: Language[] = ["C"];

/** Parses a stored language allow-list, always returning at least one entry. */
export function parseLanguageList(value: unknown, fallback: Language[] = DEFAULT_ROUND3_LANGUAGES): Language[] {
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
  if (!Array.isArray(raw)) return [...fallback];
  const out: Language[] = [];
  for (const item of raw) {
    const lang = normalizeLanguage(item);
    if (lang && !out.includes(lang)) out.push(lang);
  }
  return out.length ? out : [...fallback];
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

/* ------------------------------------------------------------------ */
/* Providers                                                           */
/* ------------------------------------------------------------------ */

/**
 * PROVIDER3 speaks the Piston HTTP API, PROVIDER4 speaks the Judge0 HTTP API.
 * They exist so an administrator can add two more engines of either flavour
 * without a code change.
 */
export const PROVIDERS = ["PISTON", "JUDGE0", "PROVIDER3", "PROVIDER4"] as const;
export type Provider = (typeof PROVIDERS)[number];

/** CodeArena routes across at most three configured execution engines. */
export const MAX_ENGINES = 3;

export const PROVIDER_LABELS: Record<Provider, string> = {
  PISTON: "Piston",
  JUDGE0: "Judge0",
  PROVIDER3: "Provider 3 (Piston-compatible)",
  PROVIDER4: "Provider 4 (Judge0-compatible)",
};

export function normalizeProvider(value: unknown): Provider {
  const key = String(value ?? "").trim().toUpperCase();
  return (PROVIDERS as readonly string[]).includes(key) ? (key as Provider) : "PISTON";
}

/** Which HTTP protocol an engine speaks. */
export function providerFlavour(provider: Provider): "PISTON" | "JUDGE0" {
  return provider === "JUDGE0" || provider === "PROVIDER4" ? "JUDGE0" : "PISTON";
}

/* ------------------------------------------------------------------ */
/* Base URL normalization — ONE implementation for every provider      */
/* ------------------------------------------------------------------ */

/** Why a configured Base URL cannot be used. */
export type BaseUrlProblem = "missing" | "invalid_url" | "local_url";

/** Provider API paths that must never be part of the stored Base URL. */
const PROVIDER_API_SUFFIX =
  /\/(api\/v[0-9]+(\/.*)?|runtimes|execute|languages|submissions|submissions\/batch|about|system_info|statuses|config_info|workers)\/?$/i;

/**
 * The single normalizer for every execution provider Base URL.
 *
 * - trims whitespace and removes trailing slashes
 * - rejects empty, non-http(s) and malformed URLs
 * - rejects localhost / 127.0.0.1 / ::1 — the cloud backend cannot reach them
 * - strips provider API paths so `/api/v2/runtimes` or `/languages` is never
 *   appended twice
 * - preserves the scheme (https stays https)
 */
export function normalizeProviderBaseUrl(raw: unknown): {
  baseUrl: string;
  problem: BaseUrlProblem | null;
} {
  let value = String(raw ?? "").trim();
  if (!value) return { baseUrl: "", problem: "missing" };

  // Strip API paths repeatedly: ".../api/v2/runtimes" → ".../api/v2" → "...".
  value = value.replace(/\/+$/, "");
  for (let i = 0; i < 4; i += 1) {
    const next = value.replace(PROVIDER_API_SUFFIX, "").replace(/\/+$/, "");
    if (next === value) break;
    value = next;
  }

  if (!/^https?:\/\/[^\s/]+/i.test(value)) return { baseUrl: "", problem: "invalid_url" };

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { baseUrl: "", problem: "invalid_url" };
  }
  const host = parsed.hostname.toLowerCase();
  if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]" || host === "0.0.0.0") {
    return { baseUrl: "", problem: "local_url" };
  }

  const path = parsed.pathname.replace(/\/+$/, "");
  return { baseUrl: `${parsed.protocol}//${parsed.host}${path}`, problem: null };
}

export function describeBaseUrlProblem(problem: BaseUrlProblem): string {
  switch (problem) {
    case "missing":
      return "No Base URL is configured. Enter the API root of an execution service this backend can reach.";
    case "invalid_url":
      return "The Base URL is not a valid http(s) URL, for example https://judge0.example.com.";
    case "local_url":
      return "localhost and 127.0.0.1 cannot be reached from the CodeArena backend. Use a publicly reachable address (for example a public Codespaces forwarded port).";
  }
}

/** The API endpoint the health checker calls for a given provider. */
export function healthEndpointFor(provider: Provider, baseUrl: string): string {
  return providerFlavour(provider) === "JUDGE0" ? `${baseUrl}/languages` : `${baseUrl}/api/v2/runtimes`;
}

/* ------------------------------------------------------------------ */
/* Health and routing                                                  */
/* ------------------------------------------------------------------ */

export type EngineHealth = "HEALTHY" | "DEGRADED" | "UNAVAILABLE" | "DISABLED" | "UNKNOWN";
export type ExecutionMode = "AUTO_FAILOVER" | "LOAD_BALANCED";

export function normalizeExecutionMode(value: unknown): ExecutionMode {
  return String(value ?? "").trim().toUpperCase() === "LOAD_BALANCED" ? "LOAD_BALANCED" : "AUTO_FAILOVER";
}

/* ------------------------------------------------------------------ */
/* Normalized execution result                                         */
/* ------------------------------------------------------------------ */

export type NormalizedStatus =
  | "ACCEPTED"
  | "WRONG_ANSWER"
  | "COMPILATION_ERROR"
  | "RUNTIME_ERROR"
  | "TIME_LIMIT_EXCEEDED"
  | "MEMORY_LIMIT_EXCEEDED"
  | "INTERNAL_ERROR"
  | "EXECUTION_SERVICE_UNAVAILABLE";

export type ExecOutcome =
  | "ok"
  | "compilation_error"
  | "runtime_error"
  | "timeout"
  | "memory"
  | "output_limit"
  | "service_error";

/** outcome (legacy, used by the judge) ⇄ normalized status (spec wording). */
export function outcomeToStatus(outcome: ExecOutcome): NormalizedStatus {
  switch (outcome) {
    case "ok":
      return "ACCEPTED";
    case "compilation_error":
      return "COMPILATION_ERROR";
    case "runtime_error":
      return "RUNTIME_ERROR";
    case "timeout":
      return "TIME_LIMIT_EXCEEDED";
    case "memory":
      return "MEMORY_LIMIT_EXCEEDED";
    case "output_limit":
      return "RUNTIME_ERROR";
    default:
      return "EXECUTION_SERVICE_UNAVAILABLE";
  }
}

/** Engine record as it is safe to show the administrator (never the API key). */
export type EngineSummary = {
  id: string;
  name: string;
  provider: Provider;
  baseUrl: string;
  apiKeySet: boolean;
  enabled: boolean;
  priority: number;
  timeoutMs: number;
  supportedLanguages: Language[];
  /** Overall status (kept for existing screens): worst of the two below. */
  healthStatus: EngineHealth;
  healthDetail: string;
  /** `/languages` (Judge0) or `/api/v2/runtimes` (Piston) answered correctly. */
  apiHealth: EngineHealth;
  /** The reference C program actually compiled and ran on the engine. */
  executionHealth: EngineHealth;
  /** Last infrastructure error, in administrator-readable terms. */
  lastError: string;

  lastHealthCheck: string | null;
  lastLatencyMs: number;
  requestCount: number;
  successCount: number;
  failureCount: number;
  createdAt: string;
  updatedAt: string;
};

/** The reference program every engine must compile and run to become HEALTHY. */
export const ENGINE_TEST_PROGRAM = `#include <stdio.h>

int main() {
    printf("CodeArena Engine Test\\n");
    return 0;
}
`;
export const ENGINE_TEST_EXPECTED = "CodeArena Engine Test";

/* ------------------------------------------------------------------ */
/* Hosting egress port restrictions                                    */
/* ------------------------------------------------------------------ */

/**
 * The CodeArena backend runs on Cloudflare's serverless runtime. Outbound
 * `fetch()` from that runtime may only use a fixed set of destination ports —
 * requests to any other port are rejected *at the edge* with HTTP 403 before
 * they ever reach the target machine. That is why a Piston VM can answer 200
 * to a laptop and still look "403 / requires authentication" to the backend.
 */
export const EGRESS_ALLOWED_HTTP_PORTS = [80, 8080, 8880, 2052, 2082, 2086, 2095];
export const EGRESS_ALLOWED_HTTPS_PORTS = [443, 2053, 2083, 2087, 2096, 8443];

/** Returns the port a base URL will actually be dialled on, or null. */
export function urlPort(raw: string): { port: number; https: boolean } | null {
  try {
    const url = new URL(raw);
    const https = url.protocol === "https:";
    return { port: Number(url.port || (https ? 443 : 80)), https };
  } catch {
    return null;
  }
}

/** True when this backend cannot dial that address at all. */
export function isEgressBlockedPort(raw: string): boolean {
  const info = urlPort(raw);
  if (!info) return false;
  const allowed = info.https ? EGRESS_ALLOWED_HTTPS_PORTS : EGRESS_ALLOWED_HTTP_PORTS;
  return !allowed.includes(info.port);
}

/** Administrator-facing explanation + the ports that would work. */
export function describeEgressPortProblem(raw: string): string {
  const info = urlPort(raw);
  const port = info ? info.port : 0;
  return (
    `Port ${port} cannot be reached from the CodeArena backend. The hosting platform only allows outbound ` +
    `HTTP on ports ${EGRESS_ALLOWED_HTTP_PORTS.join(", ")} and HTTPS on ports ` +
    `${EGRESS_ALLOWED_HTTPS_PORTS.join(", ")}; anything else is refused with HTTP 403 at the network edge, ` +
    `which is why the VM answers normally from your laptop but not from here. ` +
    `Expose this Piston instance on one of those ports (for example http://HOST:8080 or https://HOST) — ` +
    `no change to Piston itself or any authentication is needed.`
  );
}

/* ------------------------------------------------------------------ */
/* Direct-IP egress restriction (Cloudflare error code 1003)           */
/* ------------------------------------------------------------------ */

/** True when the base URL addresses a bare IPv4/IPv6 literal instead of a hostname. */
export function isDirectIpHost(raw: string): boolean {
  try {
    const host = new URL(raw).hostname;
    return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith("[");
  } catch {
    return false;
  }
}

/**
 * The backend's outbound `fetch()` leaves through Cloudflare's edge. A request
 * addressed to a bare IP literal is refused there with
 * `HTTP 403 / text/plain / "error code: 1003"` (direct IP access not allowed)
 * before it ever reaches the VM — which is exactly why the very same URL
 * answers HTTP 200 from a laptop. Piston authentication is not involved.
 */
export function describeDirectIpProblem(raw: string): string {
  const info = urlPort(raw);
  const port = info ? info.port : 8080;
  return (
    `The backend could not reach this node because the address is a bare IP. Outbound requests from the ` +
    `CodeArena hosting runtime pass through Cloudflare, which refuses direct-IP destinations with ` +
    `"HTTP 403 – error code: 1003" before the request reaches the VM. Piston itself is fine and needs no ` +
    `authentication. Fix: give the VM a DNS hostname (for example piston1.your-domain.com pointing at this ` +
    `machine) and configure the node as http://piston1.your-domain.com:${port} — or https://piston1.your-domain.com ` +
    `if you terminate TLS. Nothing on the VM, Docker, Piston or its ports has to change.`
  );
}
