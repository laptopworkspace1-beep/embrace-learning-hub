/**
 * Round 3 test-case evaluation. Every participant program is compiled and run
 * by the shared CodeExecutionService (Piston) on the server — never in the
 * browser and never on the application server itself. The backend is the only
 * authority for pass counts and scores.
 */
import {
  EXECUTABLE_LANGUAGES,
  ExecutionServiceError,
  SERVICE_UNAVAILABLE_MESSAGE,
  executeCode,
  isExecutable,
  normalizeOutput,
} from "./execution.server";
import { num, str, type Row } from "./comp.server";

export { EXECUTABLE_LANGUAGES, isExecutable };
export type Language = (typeof EXECUTABLE_LANGUAGES)[number];

export type SubmissionStatus =
  | "ACCEPTED"
  | "WRONG_ANSWER"
  | "COMPILE_ERROR"
  | "RUNTIME_ERROR"
  | "TIME_LIMIT"
  | "MEMORY_LIMIT"
  | "SERVICE_UNAVAILABLE"
  | "INTERNAL_ERROR";

export type TestOutcome = {
  index: number;
  hidden: boolean;
  passed: boolean;
  durationMs: number;
  status?: string;
  input?: string;
  expected?: string;
  actual?: string;
  error?: string;
};

export type JudgeResult = {
  status: SubmissionStatus;
  score: number;
  passed: number;
  failed: number;
  total: number;
  durationMs: number;
  memoryKb: number;
  compileOutput: string;
  executionOutput: string;
  message: string;
  results: TestOutcome[];
};

export async function judgeSubmission(
  language: string,
  code: string,
  tests: Row[],
  problem: Row,
  /** Optional execution context: drives sticky Piston node assignment + logging. */
  ctx: {
    studentId?: string | null;
    roundId?: string | null;
    submissionId?: string | null;
    /**
     * The caller already compiled this exact source successfully (Round 2 base
     * execution), so the extra sequential compile probe is skipped and every
     * test case starts in the first parallel wave.
     */
    assumeCompiled?: boolean;
    /** Upper bound on simultaneous test-case runs across the VM pool. */
    concurrency?: number;
  } = {},

): Promise<JudgeResult> {
  const total = tests.length;
  const base = {
    score: 0,
    passed: 0,
    failed: total,
    total,
    durationMs: 0,
    memoryKb: 0,
    compileOutput: "",
    executionOutput: "",
    results: [] as TestOutcome[],
  };

  if (!isExecutable(language)) {
    return {
      ...base,
      status: "INTERNAL_ERROR",
      message: `${language} cannot be executed by the configured execution service.`,
    };
  }
  if (total === 0) {
    return { ...base, status: "INTERNAL_ERROR", message: "This problem has no test cases configured yet." };
  }

  const timeLimitSec = num(problem["timeLimitSec"], 2);
  const memoryLimitMb = num(problem["memoryLimitMb"], 128);
  const maxMarks = num(problem["marks"], 0);

  const results: TestOutcome[] = [];
  let passed = 0;
  let passedWeight = 0;
  let totalWeight = 0;
  let durationMs = 0;
  let memoryKb = 0;
  let compileOutput = "";
  let executionOutput = "";
  let status: SubmissionStatus = "ACCEPTED";
  let message = "All test cases passed.";

  /*
   * Test cases are independent programs, so they are spread across the four
   * Piston VMs by a continuous worker pool instead of lock-step waves: as soon
   * as one test finishes its worker picks up the next queued test. The pool
   * still enforces each VM's maxConcurrentJobs, so this can never oversubscribe
   * a node. A compilation failure stops the whole evaluation immediately.
   */
  const JUDGE_CONCURRENCY = Math.max(1, Math.min(ctx.concurrency ?? 8, 12));
  type Run = Awaited<ReturnType<typeof executeCode>>;
  const runs = new Array<Run | undefined>(tests.length);
  let infra: unknown = null;
  let compileFailed = false;
  const startedAt = Date.now();

  const execAt = async (i: number) => {
    const test = tests[i] as Row;
    try {
      const run = await executeCode({
        language,
        code,
        stdin: str(test["input"]),
        timeLimitSec,
        memoryLimitMb,
        studentId: ctx.studentId ?? null,
        roundId: ctx.roundId ?? null,
        submissionId: ctx.submissionId ?? null,
        purpose: "SUBMIT",
      });
      runs[i] = run;
      if (run.outcome === "compilation_error") compileFailed = true;
    } catch (err) {
      infra ??= err;
    }
  };

  let compileProbeMs = 0;
  let next = 0;
  if (!ctx.assumeCompiled) {
    // Unknown compilation state: the first test runs on its own so a program
    // that does not compile never spends pool capacity on the other tests.
    await execAt(0);
    compileProbeMs = Date.now() - startedAt;
    next = 1;
  }
  if (!infra && !compileFailed) {
    const worker = async () => {
      while (!infra && !compileFailed) {
        const i = next++;
        if (i >= tests.length) return;
        await execAt(i);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(JUDGE_CONCURRENCY, Math.max(0, tests.length - next)) }, worker),
    );
  }
  console.info(
    `[judge] tests=${tests.length} concurrency=${JUDGE_CONCURRENCY} compileProbeMs=${compileProbeMs} totalMs=${Date.now() - startedAt}${compileFailed ? " compileFailed" : ""}`,
  );


  if (infra) {
    // Infrastructure failure: the participant is never penalised for it.
    console.error(
      "[judge] execution service failure",
      infra instanceof ExecutionServiceError ? infra.detail : infra,
    );
    return {
      ...base,
      durationMs,
      status: "SERVICE_UNAVAILABLE",
      message: infra instanceof ExecutionServiceError ? infra.message : SERVICE_UNAVAILABLE_MESSAGE,
      results,
    };
  }

  for (let i = 0; i < tests.length; i++) {
    const test = tests[i] as Row;
    const run = runs[i];
    // Never executed (compilation failed on the first test): not counted.
    if (!run) continue;
    const hidden = Boolean(test["isHidden"]);
    const weight = Math.max(1, num(test["marks"], 1));
    totalWeight += weight;

    durationMs += run.durationMs;
    memoryKb = Math.max(memoryKb, run.memoryKb);
    if (run.compileOutput && !compileOutput) compileOutput = run.compileOutput;



    if (run.outcome !== "ok") {
      const mapped: SubmissionStatus =
        run.outcome === "timeout"
          ? "TIME_LIMIT"
          : run.outcome === "compilation_error"
            ? "COMPILE_ERROR"
            : run.outcome === "memory"
              ? "MEMORY_LIMIT"
              : "RUNTIME_ERROR";
      if (status === "ACCEPTED") {
        status = mapped;
        message = run.message;
      }
      results.push({
        index: i + 1,
        hidden,
        passed: false,
        durationMs: run.durationMs,
        status: run.message,
        ...(hidden
          ? {}
          : {
              input: str(test["input"]),
              expected: normalizeOutput(str(test["expectedOutput"])),
              actual: normalizeOutput(run.stdout),
            }),
        error: run.outcome === "compilation_error" ? run.compileOutput : run.stderr,
      });
      if (run.outcome === "compilation_error") break;
      continue;
    }

    const actual = normalizeOutput(run.stdout);
    const expected = normalizeOutput(str(test["expectedOutput"]));
    if (!executionOutput) executionOutput = actual;
    const ok = actual === expected;
    if (ok) {
      passed += 1;
      passedWeight += weight;
    } else if (status === "ACCEPTED") {
      status = "WRONG_ANSWER";
      message = `Failed on test case ${i + 1}.`;
    }

    results.push({
      index: i + 1,
      hidden,
      passed: ok,
      durationMs: run.durationMs,
      status: ok ? "Passed" : "Wrong answer",
      ...(hidden ? {} : { input: str(test["input"]), expected, actual }),
    });
  }

  if (status === "ACCEPTED" && passed !== total) {
    status = "WRONG_ANSWER";
    message = "Some test cases failed.";
  }

  const score = totalWeight > 0 ? Math.round((passedWeight / totalWeight) * maxMarks) : 0;
  return {
    status,
    score,
    passed,
    failed: total - passed,
    total,
    durationMs,
    memoryKb,
    compileOutput,
    executionOutput,
    message,
    results,
  };
}

/** Hidden cases disclose pass/fail only — never inputs or expected outputs. */
export function redactForStudent(results: TestOutcome[]): TestOutcome[] {
  return results.map((r) =>
    r.hidden
      ? { index: r.index, hidden: true, passed: r.passed, durationMs: r.durationMs, status: r.status ?? "" }
      : r,
  );
}
