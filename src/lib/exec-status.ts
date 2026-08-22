/**
 * Client-safe presentation helpers for compiler-style status labels. The server
 * remains the only authority for outcomes; this only maps them to wording.
 */
export type ExecOutcomeName =
  | "ok"
  | "compilation_error"
  | "runtime_error"
  | "timeout"
  | "memory"
  | "output_limit"
  | "service_error";

export type StatusTone = "ok" | "error" | "warn";

export function outcomeStatus(outcome: string): { label: string; tone: StatusTone } {
  switch (outcome) {
    case "ok":
      return { label: "SUCCESS", tone: "ok" };
    case "compilation_error":
      return { label: "COMPILATION ERROR", tone: "error" };
    case "runtime_error":
      return { label: "RUNTIME ERROR", tone: "error" };
    case "timeout":
      return { label: "TIME LIMIT EXCEEDED", tone: "error" };
    case "memory":
      return { label: "MEMORY LIMIT EXCEEDED", tone: "error" };
    case "output_limit":
      return { label: "OUTPUT LIMIT EXCEEDED", tone: "error" };
    default:
      return { label: "EXECUTION ENGINE ERROR", tone: "warn" };
  }
}

/** Infers a compiler-style status when only textual fields are available. */
export function inferStatus(input: {
  compileOutput?: string;
  error?: string;
  compiled?: boolean;
  serviceAvailable?: boolean;
  status?: string;
}): { label: string; tone: StatusTone } {
  if (input.serviceAvailable === false) return { label: "EXECUTION ENGINE ERROR", tone: "warn" };
  if (input.compiled === false) return { label: "COMPILATION ERROR", tone: "error" };
  const raw = (input.status ?? "").toLowerCase();
  if (raw.includes("time")) return { label: "TIME LIMIT EXCEEDED", tone: "error" };
  if (raw.includes("compil") && raw.includes("error"))
    return { label: "COMPILATION ERROR", tone: "error" };
  if (raw.includes("runtime")) return { label: "RUNTIME ERROR", tone: "error" };
  if (input.error) return { label: "RUNTIME ERROR", tone: "error" };
  return { label: "SUCCESS", tone: "ok" };
}
