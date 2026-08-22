/**
 * Round 2 — Bug Hunt engine (server only).
 *
 * The backend is the sole authority for bug detection, bug awards and Round 2
 * scores. Nothing here trusts client input: the student only ever supplies the
 * source code, and every award decision is made from the administrator's
 * configured bug definitions stored in the event database.
 */
import { newId, nowIso, ownDb } from "./own-db.server";
import { num, str, type Row } from "./comp.server";
import {
  ExecutionServiceError,
  SERVICE_UNAVAILABLE_MESSAGE,
  executeCode,
  normalizeLanguage,
  normalizeOutput,
  statusLabel,
} from "./execution.server";

import type { JudgeResult, TestOutcome } from "./judge.server";
import { redactForStudent } from "./judge.server";

export type BugFixSummary = { bugCode: string; title: string; marks: number };

export type TestCaseAward = {
  testCaseId: string;
  name: string;
  hidden: boolean;
  status: string;
  marks: number;
  marksAwarded: number;
  durationMs: number;
  actualOutput?: string;
  error?: string;
};

export type ScoreBreakdown = {
  maxMarks: number;
  baseMarks: number;
  baseScore: number;
  basePassed: boolean;
  testCaseScore: number;
  totalScore: number;
  testCases: TestCaseAward[];
};

export type DebugEvaluation = {
  submissionId: string;
  awardedNow: number;
  newlyFixed: BugFixSummary[];
  compiled: boolean;
  executionOk: boolean;
  serviceAvailable: boolean;
  compileOutput: string;
  output: string;
  durationMs: number;
  memoryKb: number;
  message: string;
  /** Marks from the administrator's Round 2 test cases. */
  score: number;
  passed: number;
  total: number;
  status: string;
  /** Hidden cases disclose pass/fail only. */
  results: TestOutcome[];
  /** Two-level Round 2 scoring: base marks + passed test-case marks. */
  baseMarks: number;
  baseScore: number;
  basePassed: boolean;
  testCaseScore: number;
  maxMarks: number;
};


/**
 * Compiles and runs the participant's program through the shared
 * CodeExecutionService (Piston). Infrastructure failures surface as a safe
 * service message and never as a technical stack trace.
 */
export async function checkDebugCode(
  problem: Row,
  sourceCode: string,
  options: {
    language?: string;
    stdin?: string;
    compileOnly?: boolean;
    studentId?: string | null;
    roundId?: string | null;
  } = {},
) {
  const language =
    normalizeLanguage(options.language) ?? normalizeLanguage(problem["language"]) ?? "C";
  try {
    const run = await executeCode({
      language,
      code: sourceCode,
      stdin: options.stdin ?? str(problem["publicInput"]),
      timeLimitSec: num(problem["timeLimitSec"], 2),
      memoryLimitMb: num(problem["memoryLimitMb"], 128),
      studentId: options.studentId ?? null,
      roundId: options.roundId ?? str(problem["roundId"]),
    });
    return {
      status: options.compileOnly && run.outcome === "ok" ? "Compilation successful" : statusLabel(run.outcome),
      compiled: run.outcome !== "compilation_error",
      executionOk: run.outcome === "ok",
      serviceAvailable: true,
      output: normalizeOutput(run.stdout).slice(0, 4000),
      compileOutput: run.compileOutput.slice(0, 4000),
      error: (run.outcome === "compilation_error" ? run.compileOutput : run.stderr).slice(0, 2000),
      memoryKb: run.memoryKb,
      durationMs: run.durationMs,
      message: run.message,
    };
  } catch (err) {
    console.error(
      "[bughunt] execution service failure",
      err instanceof ExecutionServiceError ? err.detail : err,
    );
    return {
      status: "Judge error",
      compiled: false,
      executionOk: false,
      serviceAvailable: false,
      output: "",
      compileOutput: "",
      error: "",
      memoryKb: 0,
      durationMs: 0,
      message: err instanceof ExecutionServiceError ? err.message : SERVICE_UNAVAILABLE_MESSAGE,
    };
  }
}

/** True when the configured bug is fixed in this source code. */
function isBugFixed(bug: Row, sourceCode: string): boolean {
  const pattern = bug["fixPattern"] ? str(bug["fixPattern"]) : null;
  const forbidden = bug["mustNotMatch"] ? str(bug["mustNotMatch"]) : null;
  if (!pattern && !forbidden) return false; // not configured for automatic evaluation
  try {
    if (pattern && !new RegExp(pattern, "m").test(sourceCode)) return false;
    if (forbidden && new RegExp(forbidden, "m").test(sourceCode)) return false;
    return true;
  } catch (err) {
    console.error("[bughunt] invalid bug pattern", str(bug["id"]), err);
    return false;
  }
}

/**
 * Records a submission, judges it against the administrator's Round 2 test
 * cases (the primary marking rule) and additionally awards any legacy bug
 * definitions that are configured for the problem. Both mechanisms are
 * server-side only.
 */
export async function evaluateDebugSubmission(input: {
  studentId: string;
  problem: Row;
  sourceCode: string;
  isFinal?: boolean;
  language?: string;
}): Promise<DebugEvaluation> {
  const db = ownDb();
  const problemId = str(input.problem["id"]);
  const now = nowIso();
  const submissionId = newId();

  const language =
    normalizeLanguage(input.language) ?? normalizeLanguage(input.problem["language"]) ?? "C";

  // Administrator-configured test cases decide the marks for this problem.
  // Disabled cases are ignored entirely (never executed, never marked).
  const { data: testRows } = await db
    .from("debug_test_cases")
    .select("*")
    .eq("problemId", problemId)
    .order("orderNo", { ascending: true });
  const tests = ((testRows ?? []) as Row[]).filter((t) => t["isEnabled"] !== false);

  const maxMarks = num(input.problem["marks"], 0);
  const baseMarks = Math.max(0, Math.min(num(input.problem["baseMarks"], 0), maxMarks));

  /*
   * Base evaluation: the fixed program is compiled and run once with the
   * administrator's public input, and its output is compared with the public
   * expected output. Compiling alone never earns the base marks.
   */
  const publicExpected = normalizeOutput(str(input.problem["publicExpectedOutput"]));
  const execution = await checkDebugCode(input.problem, input.sourceCode, {
    language,
    stdin: str(input.problem["publicInput"]),
    studentId: input.studentId,
  });

  let judged: JudgeResult | null = null;
  if (tests.length) {
    const { judgeSubmission } = await import("./judge.server");
    judged = await judgeSubmission(language, input.sourceCode, tests, input.problem, {
      studentId: input.studentId,
      roundId: str(input.problem["roundId"]),
      submissionId,
    });
  }

  /*
   * Two-level Round 2 scoring, computed here on the server only:
   *   base marks   — awarded when the program compiles, runs and matches the
   *                  configured public expected output;
   *   test marks   — the marks of every passed enabled hidden test case.
   * The total can never exceed the problem's maximum marks.
   */
  const outcomeByIndex = new Map((judged?.results ?? []).map((r) => [r.index, r]));
  const testCases: TestCaseAward[] = tests.map((t, i) => {
    const outcome = outcomeByIndex.get(i + 1);
    const marks = Math.max(0, num(t["marks"], 1));
    const passed = Boolean(outcome?.passed);
    return {
      testCaseId: str(t["id"]),
      name: str(t["name"]) || `Test case ${i + 1}`,
      hidden: Boolean(t["isHidden"]),
      status: !outcome
        ? judged?.status === "COMPILE_ERROR"
          ? "COMPILATION_ERROR"
          : "NOT_RUN"
        : passed
          ? "PASS"
          : /time/i.test(outcome.status ?? "")
            ? "TIME_LIMIT_EXCEEDED"
            : /compil/i.test(outcome.status ?? "")
              ? "COMPILATION_ERROR"
              : /runtime|error/i.test(outcome.status ?? "")
                ? "RUNTIME_ERROR"
                : "FAIL",
      marks,
      marksAwarded: passed ? marks : 0,
      durationMs: outcome?.durationMs ?? 0,
      ...(outcome?.actual !== undefined ? { actualOutput: outcome.actual } : {}),
      ...(outcome?.error ? { error: outcome.error.slice(0, 2000) } : {}),
    };
  });

  const compiled = execution.compiled && execution.serviceAvailable;
  // Compilation alone is never enough: the program must run and, when a public
  // expected output is configured, produce exactly that output.
  const basePassed =
    compiled &&
    execution.executionOk &&
    (publicExpected ? normalizeOutput(execution.output) === publicExpected : true);
  const baseScore = basePassed ? baseMarks : 0;
  const testCaseScore = testCases.reduce((s, t) => s + t.marksAwarded, 0);
  const totalScore = Math.max(0, Math.min(baseScore + testCaseScore, maxMarks || baseScore + testCaseScore));

  const breakdown: ScoreBreakdown = {
    maxMarks,
    baseMarks,
    baseScore,
    basePassed,
    testCaseScore,
    totalScore,
    testCases,
  };

  const { error: subError } = await db.from("debugging_submissions").insert({
    id: submissionId,
    studentId: input.studentId,
    problemId,
    // Immutable snapshot: the editor buffer is stored byte-for-byte, never
    // formatted, trimmed or normalised.
    sourceCode: input.sourceCode,
    language,
    isFinal: input.isFinal ?? false,
    submittedAt: now,
    score: 0,
    baseScore,
    testCaseScore,
    resultJson: breakdown,
    message: "",
    status: judged?.status ?? execution.status,
    testsPassed: judged?.passed ?? 0,
    testsTotal: judged?.total ?? 0,
    compileOutput: execution.compileOutput,
    executionOutput: execution.output,
    executionMs: execution.durationMs,
    memoryKb: execution.memoryKb,
    createdAt: now,
    updatedAt: now,
  });
  if (subError) {
    console.error("[bughunt] submission insert failed", subError.message);
    throw new Error("Could not record your submission. Please try again.");
  }

  const [{ data: bugs }, { data: awards }] = await Promise.all([
    db.from("bug_definitions").select("*").eq("problemId", problemId).order("orderNo"),
    db
      .from("bug_awards")
      .select("bugDefinitionId")
      .eq("studentId", input.studentId)
      .eq("problemId", problemId),
  ]);
  const already = new Set((awards ?? []).map((a) => str((a as Row)["bugDefinitionId"])));

  const newlyFixed: BugFixSummary[] = [];
  let awardedNow = 0;

  if (execution.serviceAvailable && execution.compiled) {
    for (const raw of bugs ?? []) {
      const bug = raw as Row;
      const bugId = str(bug["id"]);
      if (bug["isActive"] === false) continue;
      if (already.has(bugId)) continue;
      if (!isBugFixed(bug, input.sourceCode)) continue;

      const marks = num(bug["marks"]);
      const { error } = await db.from("bug_awards").insert({
        id: newId(),
        studentId: input.studentId,
        problemId,
        submissionId,
        bugDefinitionId: bugId,
        marksAwarded: marks,
        createdAt: nowIso(),
      });
      // 23505 = a concurrent submission already awarded this bug; never award twice.
      if (error) {
        if (error.code !== "23505") console.error("[bughunt] award insert failed", error.message);
        continue;
      }
      awardedNow += marks;
      newlyFixed.push({ bugCode: str(bug["bugCode"]), title: str(bug["title"]), marks });
    }
  }

  const baseText = `Base ${baseScore}/${baseMarks}`;
  const message = !execution.serviceAvailable
    ? `Submission saved. ${execution.message}`
    : judged
      ? `${baseText} · ${judged.passed}/${judged.total} hidden test case(s) passed.`
      : execution.compiled
        ? `${baseText} · no hidden test cases configured.`
        : "Submission recorded — compilation failed.";

  await db
    .from("debugging_submissions")
    .update({ score: totalScore, message, updatedAt: nowIso() })
    .eq("id", submissionId);

  return {
    submissionId,
    awardedNow,
    newlyFixed,
    compiled: execution.compiled,
    executionOk: execution.executionOk,
    serviceAvailable: execution.serviceAvailable,
    compileOutput: execution.compileOutput,
    output: execution.output,
    durationMs: execution.durationMs,
    memoryKb: execution.memoryKb,
    message,
    score: totalScore,
    baseMarks,
    baseScore,
    basePassed,
    testCaseScore,
    maxMarks,
    passed: judged?.passed ?? 0,
    total: judged?.total ?? 0,
    status: judged?.status ?? execution.status,
    results: judged ? redactForStudent(judged.results) : [],
  };
}


/** Draft code the student is currently editing, stored on their progress row. */
export function readDrafts(progress: Row | null): Record<string, string> {
  const saved = (progress?.["savedData"] ?? {}) as Record<string, unknown>;
  const drafts = (saved["debugDrafts"] ?? {}) as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(drafts)) out[key] = String(value ?? "");
  return out;
}

export async function saveDraft(progress: Row, problemId: string, sourceCode: string) {
  const saved = ((progress["savedData"] ?? {}) as Record<string, unknown>) || {};
  const drafts = { ...readDrafts(progress), [problemId]: sourceCode };
  await ownDb()
    .from("round_progress")
    .update({ savedData: { ...saved, debugDrafts: drafts }, updatedAt: nowIso() })
    .eq("id", str(progress["id"]));
}

/**
 * Final evaluation for Round 2: every unevaluated draft is judged once more so
 * the stored score reflects the student's last state. Idempotent — repeated
 * calls cannot produce duplicate awards because awards are unique per bug.
 */
export async function finalizeRound2(studentId: string, round: Row, progress: Row | null) {
  const db = ownDb();
  const { data: problems } = await db
    .from("debugging_problems")
    .select("*")
    .eq("roundId", str(round["id"]))
    .eq("isEnabled", true);
  const drafts = readDrafts(progress);

  for (const raw of problems ?? []) {
    const problem = raw as Row;
    const problemId = str(problem["id"]);
    const draft = drafts[problemId];
    if (!draft || !draft.trim()) continue;

    const { data: last } = await db
      .from("debugging_submissions")
      .select("sourceCode")
      .eq("studentId", studentId)
      .eq("problemId", problemId)
      .order("createdAt", { ascending: false })
      .limit(1);
    const lastCode = str((last?.[0] as Row | undefined)?.["sourceCode"] ?? "");
    if (lastCode === draft) continue; // already evaluated in this exact state

    try {
      await evaluateDebugSubmission({ studentId, problem, sourceCode: draft, isFinal: true });
    } catch (err) {
      console.error("[bughunt] finalize failed", problemId, err);
    }
  }

  await db
    .from("debugging_submissions")
    .update({ isFinal: true, updatedAt: nowIso() })
    .eq("studentId", studentId)
    .in("problemId", (problems ?? []).map((p) => str((p as Row)["id"])));
}
