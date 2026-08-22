import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { Row } from "./comp.server";
import { apiMetrics } from "./api-metrics";

const answerInput = z.object({
  questionId: z.string().min(1),
  optionKey: z.string().trim().max(8).optional(),
  answerText: z.string().max(4000).optional(),
});

const codeInput = z.object({
  problemId: z.string().min(1),
  language: z.string().trim().min(1).max(20),
  code: z.string().min(1, "Write some code first").max(100_000),
});

/** Round payload for the student. Answer keys and hidden tests never leave the server. */
export const getRoundPlay = createServerFn({ method: "POST" }).middleware([apiMetrics("student.getRoundPlay")])
  .inputValidator((input: { roundId: string }) =>
    z.object({ roundId: z.string().min(1) }).parse(input),
  )
  .handler(async ({ data }) => {
    const { requireStudent } = await import("./app-session.server");
    const { ownDb } = await import("./own-db.server");
    const { attemptState, getRound, nextRoundInfo, num, str } = await import("./comp.server");
    const claims = await requireStudent();
    const db = ownDb();

    const round = await getRound(data.roundId);
    if (!round) throw new Error("Round not found.");
    const type = str(round["type"]);

    // Attempt state, the next-round pointer and the event settings do not
    // depend on each other — fetch them in one batch instead of three serial
    // round trips.
    const [state, nextRound, { data: settings }] = await Promise.all([
      attemptState(claims.studentId, round),
      nextRoundInfo(round),
      db.from("event_settings").select("fullscreenViolationLimit").limit(1),
    ]);

    const shell = {
      round: {
        id: str(round["id"]),
        name: str(round["name"]),
        type,
        durationMinutes: num(round["durationMinutes"]),
        maxMarks: num(round["maxMarks"]),
        state: state.gate.state,
      },
      gate: state.gate,
      status: state.status,
      canPlay: state.canPlay,
      remainingSeconds: state.remainingSeconds,
      violationLimit: settings?.[0]
        ? num((settings[0] as Row)["fullscreenViolationLimit"], 3)
        : 3,
      nextRound,
    };

    if (type === "ROUND1") {
      const { data: questions } = await db
        .from("questions")
        .select("id, type, prompt, codeSnippet, marks, negativeMarks, orderNo")
        .eq("roundId", data.roundId)
        .eq("isEnabled", true)
        .order("orderNo", { ascending: true });
      const ids = (questions ?? []).map((q) => str((q as Row)["id"]));
      const [{ data: options }, { data: mine }] = await Promise.all([
        ids.length
          ? db
              .from("question_options")
              .select("questionId, optionKey, optionText, orderNo")
              .in("questionId", ids)
              .order("orderNo", { ascending: true })
          : Promise.resolve({ data: [] as Row[] }),
        db
          .from("student_answers")
          .select("questionId, selectedOptionKey, answerText")
          .eq("studentId", claims.studentId)
          .eq("roundId", data.roundId),
      ]);
      // Bucket answers and options by question once instead of rescanning both
      // lists for every question on the paper.
      const answerByQuestion = new Map(
        (mine ?? []).map((a) => [str((a as Row)["questionId"]), a as Row]),
      );
      const optionsByQuestion = new Map<string, { key: string; text: string }[]>();
      for (const o of options ?? []) {
        const row = o as Row;
        const key = str(row["questionId"]);
        const list = optionsByQuestion.get(key) ?? [];
        list.push({ key: str(row["optionKey"]), text: str(row["optionText"]) });
        optionsByQuestion.set(key, list);
      }
      return {
        ...shell,
        questions: (questions ?? []).map((q) => {
          const row = q as Row;
          const id = str(row["id"]);
          const answer = answerByQuestion.get(id);
          return {
            id,
            type: str(row["type"]),
            prompt: str(row["prompt"]),
            codeSnippet: (row["codeSnippet"] as string | null) ?? null,
            marks: num(row["marks"]),
            negativeMarks: num(row["negativeMarks"]),
            options: optionsByQuestion.get(id) ?? [],
            selectedOptionKey: (answer?.["selectedOptionKey"] as string | null) ?? null,
            answerText: (answer?.["answerText"] as string | null) ?? null,
          };
        }),
        debugProblems: [],
        codeProblems: [],
      };
    }

    if (type === "ROUND2") {
      const { data: problems } = await db
        .from("debugging_problems")
        .select("id, title, marks, orderNo")
        .eq("roundId", data.roundId)
        .eq("isEnabled", true)
        .order("orderNo", { ascending: true });
      const ids = (problems ?? []).map((p) => str((p as Row)["id"]));
      const [{ data: awards }, { data: subs }] = await Promise.all([
        ids.length
          ? db
              .from("bug_awards")
              .select("problemId, marksAwarded")
              .eq("studentId", claims.studentId)
              .in("problemId", ids)
          : Promise.resolve({ data: [] as Row[] }),
        ids.length
          ? db
              .from("debugging_submissions")
              .select("problemId")
              .eq("studentId", claims.studentId)
              .in("problemId", ids)
          : Promise.resolve({ data: [] as Row[] }),
      ]);
      return {
        ...shell,
        questions: [],
        debugProblems: (problems ?? []).map((p) => {
          const id = str((p as Row)["id"]);
          const mine = (awards ?? []).filter((a) => str((a as Row)["problemId"]) === id);
          return {
            id,
            title: str((p as Row)["title"]),
            marks: num((p as Row)["marks"]),
            earned: mine.reduce((s, a) => s + num((a as Row)["marksAwarded"]), 0),
            bugsFound: mine.length,
            attempts: (subs ?? []).filter((s) => str((s as Row)["problemId"]) === id).length,
          };
        }),
        codeProblems: [],
      };
    }

    const { data: problems } = await db
      .from("programming_problems")
      .select("id, title, marks, orderNo, timeLimitSec, memoryLimitMb")
      .eq("roundId", data.roundId)
      .eq("isEnabled", true)
      .order("orderNo", { ascending: true });
    const ids = (problems ?? []).map((p) => str((p as Row)["id"]));
    const { data: subs } = ids.length
      ? await db
          .from("programming_submissions")
          .select("problemId, score, status, passedTests, totalTests")
          .eq("studentId", claims.studentId)
          .in("problemId", ids)
      : { data: [] as Row[] };
    return {
      ...shell,
      questions: [],
      debugProblems: [],
      codeProblems: (problems ?? []).map((p) => {
        const id = str((p as Row)["id"]);
        const mine = (subs ?? []).filter((s) => str((s as Row)["problemId"]) === id);
        return {
          id,
          title: str((p as Row)["title"]),
          marks: num((p as Row)["marks"]),
          bestScore: mine.reduce((m, s) => Math.max(m, num((s as Row)["score"])), 0),
          attempts: mine.length,
          solved: mine.some((s) => str((s as Row)["status"]) === "ACCEPTED"),
        };
      }),
    };
  });

/** Grades and stores one Round 1 answer. Grading only ever happens here. */
export const saveAnswer = createServerFn({ method: "POST" })
  .inputValidator((input: z.infer<typeof answerInput>) => answerInput.parse(input))
  .handler(async ({ data }) => {
    const { requireStudent } = await import("./app-session.server");
    const { newId, nowIso, ownDb } = await import("./own-db.server");
    const { getRound, num, requireWritableAttempt, str } = await import("./comp.server");
    const { recalcRoundScore } = await import("./scoring.server");
    const claims = await requireStudent();
    const db = ownDb();

    const { data: question } = await db
      .from("questions")
      .select("*")
      .eq("id", data.questionId)
      .maybeSingle();
    if (!question) throw new Error("Question not found.");
    const q = question as Row;
    if (!q["isEnabled"]) throw new Error("This question is no longer active.");

    const round = await getRound(str(q["roundId"]));
    if (!round) throw new Error("Round not found.");
    await requireWritableAttempt(claims.studentId, round);

    let awarded = 0;
    let selectedOptionKey: string | null = null;
    let answerText: string | null = null;

    if (str(q["type"]) === "MCQ") {
      const key = (data.optionKey ?? "").trim();
      if (!key) throw new Error("Select an option first.");
      const { data: option } = await db
        .from("question_options")
        .select("optionKey")
        .eq("questionId", str(q["id"]))
        .eq("optionKey", key)
        .maybeSingle();
      if (!option) throw new Error("Invalid option selected.");
      selectedOptionKey = key;
      awarded = key === str(q["correctOptionKey"]) ? num(q["marks"]) : -num(q["negativeMarks"]);
    } else {
      const text = data.answerText ?? "";
      answerText = text.slice(0, 4000);
      const method = str(q["comparisonMethod"], "TRIMMED_OUTPUT");
      const expected = str(q["expectedOutput"]);
      const normalise = (v: string) =>
        method === "EXACT_MATCH" ? v.replace(/\r\n/g, "\n") : v.replace(/\r\n/g, "\n").trim();
      const correct = normalise(answerText) === normalise(expected);
      awarded = correct ? num(q["marks"]) : -num(q["negativeMarks"]);
    }

    const now = nowIso();
    const { error } = await db.from("student_answers").upsert(
      {
        id: newId(),
        studentId: claims.studentId,
        roundId: str(q["roundId"]),
        questionId: str(q["id"]),
        selectedOptionKey,
        answerText,
        isFinal: false,
        awardedMarks: awarded,
        createdAt: now,
        updatedAt: now,
      },
      { onConflict: "studentId,questionId" },
    );
    if (error) {
      console.error("[answer] upsert failed", error.message);
      throw new Error("Could not save your answer. Please try again.");
    }

    await recalcRoundScore(claims.studentId, round);
    return { ok: true as const, saved: true };
  });

/** Final submit for a round: locks the attempt and recomputes the score. */
export const submitRound = createServerFn({ method: "POST" }).middleware([apiMetrics("student.submitRound")])
  .inputValidator((input: { roundId: string }) =>
    z.object({ roundId: z.string().min(1) }).parse(input),
  )
  .handler(async ({ data }) => {
    const { requireStudent } = await import("./app-session.server");
    const { nowIso, ownDb, audit } = await import("./own-db.server");
    const { getRound, str } = await import("./comp.server");
    const { recalcRoundScore } = await import("./scoring.server");
    const claims = await requireStudent();
    const db = ownDb();

    const round = await getRound(data.roundId);
    if (!round) throw new Error("Round not found.");

    const { data: progressRow } = await db
      .from("round_progress")
      .select("*")
      .eq("studentId", claims.studentId)
      .eq("roundId", data.roundId)
      .maybeSingle();
    const progress = (progressRow as Row | null) ?? null;
    const alreadyFinal =
      progress && (str(progress["status"]) === "SUBMITTED" || str(progress["status"]) === "LOCKED");

    // Round 2: evaluate whatever the student last had in the editor before locking.
    if (!alreadyFinal && str(round["type"]) === "ROUND2") {
      const { finalizeRound2 } = await import("./bughunt.server");
      await finalizeRound2(claims.studentId, round, progress);
    }

    const now = nowIso();
    await db
      .from("student_answers")
      .update({ isFinal: true, updatedAt: now })
      .eq("studentId", claims.studentId)
      .eq("roundId", data.roundId);
    const { error } = await db
      .from("round_progress")
      .update({ status: "SUBMITTED", submittedAt: now, updatedAt: now })
      .eq("studentId", claims.studentId)
      .eq("roundId", data.roundId);
    if (error) {
      console.error("[round] submit failed", error.message);
      throw new Error("Could not submit this round. Please try again.");
    }

    const score = await recalcRoundScore(claims.studentId, round);
    if (!alreadyFinal) {
      await audit({
        actorUserId: claims.sub,
        action: "round.submitted",
        entityType: "rounds",
        entityId: data.roundId,
        metadata: { score, roundType: str(round["type"]) },
      });
    }
    return { ok: true as const, score, alreadySubmitted: Boolean(alreadyFinal) };
  });

/** Bug Hunt problem detail. Bug fix patterns and solutions never leave the server. */
export const getDebugProblem = createServerFn({ method: "POST" })
  .inputValidator((input: { problemId: string }) =>
    z.object({ problemId: z.string().min(1) }).parse(input),
  )
  .handler(async ({ data }) => {
    const { requireStudent } = await import("./app-session.server");
    const { ownDb } = await import("./own-db.server");
    const { attemptState, getRound, nextRoundInfo, num, str } = await import("./comp.server");
    const { readDrafts } = await import("./bughunt.server");
    const claims = await requireStudent();
    const db = ownDb();

    const { data: found } = await db
      .from("debugging_problems")
      .select("*")
      .eq("id", data.problemId)
      .maybeSingle();
    if (!found || !(found as Row)["isEnabled"]) throw new Error("Problem not found.");
    const problem = found as Row;

    const round = await getRound(str(problem["roundId"]));
    if (!round) throw new Error("Round not found.");
    const state = await attemptState(claims.studentId, round);
    if (!state.gate.open && state.status === "NOT_STARTED")
      throw new Error(state.gate.reason || "This round is not open yet.");

    const [{ data: bugs }, { data: awards }, { data: subs }, { data: siblingRows }, { data: tests }] =
      await Promise.all([
        db
          .from("bug_definitions")
          .select("id, bugCode, title, description, marks, orderNo, isActive")
          .eq("problemId", data.problemId)
          .order("orderNo", { ascending: true }),
        db
          .from("bug_awards")
          .select("bugDefinitionId, marksAwarded, createdAt")
          .eq("studentId", claims.studentId)
          .eq("problemId", data.problemId),
        db
          .from("debugging_submissions")
          .select("id, score, message, testsPassed, testsTotal, status, createdAt")
          .eq("studentId", claims.studentId)
          .eq("problemId", data.problemId)
          .order("createdAt", { ascending: false })
          .limit(20),
        db
          .from("debugging_problems")
          .select("id, title, orderNo")
          .eq("roundId", str(problem["roundId"]))
          .eq("isEnabled", true)
          .order("orderNo", { ascending: true }),
        // Hidden cases are never sent to the browser — only their count, so the
        // query deliberately does not even read `input`/`expectedOutput`.
        db
          .from("debug_test_cases")
          .select("id, isEnabled")
          .eq("problemId", data.problemId)
          .order("orderNo", { ascending: true }),

      ]);


    const awardedIds = new Set((awards ?? []).map((a) => str((a as Row)["bugDefinitionId"])));
    const activeBugs = (bugs ?? []).filter((b) => (b as Row)["isActive"] !== false);
    const drafts = readDrafts(state.progress);
    const lastSubmitted = (subs ?? [])[0] as Row | undefined;
    let savedCode = drafts[data.problemId] ?? "";
    if (!savedCode && lastSubmitted) {
      const { data: latest } = await db
        .from("debugging_submissions")
        .select("sourceCode")
        .eq("id", str(lastSubmitted["id"]))
        .maybeSingle();
      savedCode = str((latest as Row | null)?.["sourceCode"] ?? "");
    }
    // Bug Hunt: the administrator's buggy code is exactly what the student gets.
    if (!savedCode) savedCode = str(problem["buggyCode"]);

    return {
      problem: {
        id: str(problem["id"]),
        roundId: str(problem["roundId"]),
        title: str(problem["title"]),
        description: str(problem["description"]),
        language: str(problem["language"]) || "C",
        expectedBehavior: str(problem["expectedBehavior"]),
        buggyCode: str(problem["buggyCode"]),
        marks: num(problem["marks"]),
        baseMarks: num(problem["baseMarks"]),
        publicInput: str(problem["publicInput"]),
        publicExpectedOutput: str(problem["publicExpectedOutput"]),
      },

      round: {
        id: str(round["id"]),
        name: str(round["name"]),
        type: str(round["type"]),
        state: state.gate.state,
      },
      nextRound: await nextRoundInfo(round),
      gate: state.gate,
      canPlay: state.canPlay,
      status: state.status,
      remainingSeconds: state.remainingSeconds,
      // Only safe, student-facing bug information — never patterns or solutions.
      bugs: activeBugs.map((b) => ({
        id: str((b as Row)["id"]),
        bugCode: str((b as Row)["bugCode"]),
        title: str((b as Row)["title"]),
        description: str((b as Row)["description"]),
        marks: num((b as Row)["marks"]),
        awarded: awardedIds.has(str((b as Row)["id"])),
      })),
      totalBugs: activeBugs.length,
      fixedBugs: activeBugs.filter((b) => awardedIds.has(str((b as Row)["id"]))).length,
      earned: (awards ?? []).reduce((s, a) => s + num((a as Row)["marksAwarded"]), 0),
      savedCode,
      // Sibling problems in this round, so the workspace can offer Previous/Next.
      siblings: (siblingRows ?? []).map((p) => ({
        id: str((p as Row)["id"]),
        title: str((p as Row)["title"]),
      })),

      // Round 2 test cases are always hidden: counted, never revealed.
      visibleTests: [] as { id: string; input: string; expectedOutput: string }[],
      hiddenTestCount: (tests ?? []).filter((t) => (t as Row)["isEnabled"] !== false).length,
      totalTests: (tests ?? []).filter((t) => (t as Row)["isEnabled"] !== false).length,

      submissions: (subs ?? []).map((s) => ({
        id: str((s as Row)["id"]),
        score: num((s as Row)["score"]),
        message: str((s as Row)["message"]),
        status: str((s as Row)["status"]),
        testsPassed: num((s as Row)["testsPassed"]),
        testsTotal: num((s as Row)["testsTotal"]),
        createdAt: str((s as Row)["createdAt"]),
      })),
    };
  });


/** Autosaves the student's working code so it survives navigation and refresh. */
export const saveDebugDraft = createServerFn({ method: "POST" })
  .inputValidator((input: { problemId: string; sourceCode: string }) =>
    z.object({ problemId: z.string().min(1), sourceCode: z.string().max(100_000) }).parse(input),
  )
  .handler(async ({ data }) => {
    const { requireStudent } = await import("./app-session.server");
    const { ownDb } = await import("./own-db.server");
    const { getRound, requireWritableAttempt, str } = await import("./comp.server");
    const { saveDraft } = await import("./bughunt.server");
    const claims = await requireStudent();

    const { data: found } = await ownDb()
      .from("debugging_problems")
      .select("id, roundId, isEnabled")
      .eq("id", data.problemId)
      .maybeSingle();
    if (!found || !(found as Row)["isEnabled"]) throw new Error("Problem not found.");
    const round = await getRound(str((found as Row)["roundId"]));
    if (!round) throw new Error("Round not found.");
    const state = await requireWritableAttempt(claims.studentId, round);
    if (!state.progress) throw new Error("Your attempt for this round is not active.");
    await saveDraft(state.progress, data.problemId, data.sourceCode);
    return { ok: true as const };
  });

const debugRunInput = z.object({
  problemId: z.string().min(1),
  sourceCode: z.string().min(1).max(100_000),
  language: z.string().trim().min(1).max(20).optional(),
  stdin: z.string().max(20_000).optional(),
  mode: z.enum(["COMPILE", "RUN"]).optional(),
});

/**
 * Round 2 Compile / Run. The program is compiled and executed by the
 * server-side CodeExecutionService (Piston). Never awards marks.
 */
export const runDebugCode = createServerFn({ method: "POST" }).middleware([apiMetrics("student.runDebugCode")])
  .inputValidator((input: z.infer<typeof debugRunInput>) => debugRunInput.parse(input))
  .handler(async ({ data }) => {
    const t0 = Date.now();
    const { requireStudent } = await import("./app-session.server");
    const { ownDb } = await import("./own-db.server");
    const { getRound, requireWritableAttempt, str } = await import("./comp.server");
    const { checkDebugCode } = await import("./bughunt.server");
    const { recordAttempt } = await import("./execution.server");
    const claims = await requireStudent();
    const { enforceRateLimit } = await import("./rate-limit.server");
    enforceRateLimit("run", claims.studentId);

    const { data: found } = await ownDb()
      .from("debugging_problems")
      .select("*")
      .eq("id", data.problemId)
      .maybeSingle();
    if (!found || !(found as Row)["isEnabled"]) throw new Error("Problem not found.");
    const problem = found as Row;
    const round = await getRound(str(problem["roundId"]));
    if (!round) throw new Error("Round not found.");
    // Server-side round state + deadline check; a manipulated browser cannot bypass it.
    await requireWritableAttempt(claims.studentId, round);

    const compileOnly = data.mode === "COMPILE";
    // Written concurrently with the execution below; it is a counter, never a
    // precondition of the run.
    const attemptCounted = recordAttempt(
      claims.studentId,
      data.problemId,
      "DEBUG",
      compileOnly ? "compileAttempts" : "runAttempts",
    );

    // The Bug Hunt language is fixed by the problem definition; a client-supplied
    // language is never trusted here.
    const result = await checkDebugCode(problem, data.sourceCode, {
      ...(data.stdin !== undefined ? { stdin: data.stdin } : {}),
      compileOnly,
      studentId: claims.studentId,
    });
    await attemptCounted;
    console.info(
      `[run-timing] runDebugCode student=${claims.studentId} problem=${data.problemId} ` +
        `mode=${compileOnly ? "COMPILE" : "RUN"} status=${result.status} totalMs=${Date.now() - t0}`,
    );
    return {
      status: result.status,
      compiled: result.compiled,
      serviceAvailable: result.serviceAvailable,
      output: result.output,
      compileOutput: result.compileOutput,
      error: result.error,
      memoryKb: result.memoryKb,
      durationMs: result.durationMs,
      message: result.message,
    };
  });

/**
 * Evaluates a Bug Hunt submission against the administrator's configured bug
 * patterns. Marks for a bug are awarded at most once per student and problem.
 */
export const submitDebugFix = createServerFn({ method: "POST" }).middleware([apiMetrics("student.submitDebugFix")])
  .inputValidator((input: { problemId: string; sourceCode: string; language?: string }) =>
    z
      .object({
        problemId: z.string().min(1),
        sourceCode: z.string().min(1).max(100_000),
        language: z.string().trim().min(1).max(20).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const { requireStudent } = await import("./app-session.server");
    const { ownDb } = await import("./own-db.server");
    const { getRound, requireWritableAttempt, str } = await import("./comp.server");
    const { evaluateDebugSubmission, saveDraft } = await import("./bughunt.server");
    const { recalcRoundScore } = await import("./scoring.server");
    const claims = await requireStudent();
    const { enforceRateLimit } = await import("./rate-limit.server");
    enforceRateLimit("submit", claims.studentId);

    const { data: found } = await ownDb()
      .from("debugging_problems")
      .select("*")
      .eq("id", data.problemId)
      .maybeSingle();
    if (!found || !(found as Row)["isEnabled"]) throw new Error("Problem not found.");
    const problem = found as Row;

    const round = await getRound(str(problem["roundId"]));
    if (!round) throw new Error("Round not found.");
    const state = await requireWritableAttempt(claims.studentId, round);

    const evaluation = await evaluateDebugSubmission({
      studentId: claims.studentId,
      problem,
      sourceCode: data.sourceCode,
    });
    if (state.progress) await saveDraft(state.progress, data.problemId, data.sourceCode);
    const roundScore = await recalcRoundScore(claims.studentId, round);

    // Safe feedback only: no bug identifiers, patterns or solution details, and
    // hidden test cases report pass/fail without inputs or expected output.
    return {
      ok: true as const,
      compiled: evaluation.compiled,
      executionOk: evaluation.executionOk,
      serviceAvailable: evaluation.serviceAvailable,
      compileOutput: evaluation.compileOutput,
      output: evaluation.output,
      durationMs: evaluation.durationMs,
      memoryKb: evaluation.memoryKb,
      message: evaluation.message,
      status: evaluation.status,
      score: evaluation.score,
      // Safe scoring summary: totals only, never hidden inputs/expected output.
      maxMarks: evaluation.maxMarks,
      baseMarks: evaluation.baseMarks,
      baseScore: evaluation.baseScore,
      basePassed: evaluation.basePassed,
      testCaseScore: evaluation.testCaseScore,
      passed: evaluation.passed,
      total: evaluation.total,
      results: evaluation.results,
      roundScore,
    };
  });


/** Code Sprint problem detail. Hidden test cases are never returned. */
export const getCodeProblem = createServerFn({ method: "POST" }).middleware([apiMetrics("student.getCodeProblem")])
  .inputValidator((input: { problemId: string }) =>
    z.object({ problemId: z.string().min(1) }).parse(input),
  )
  .handler(async ({ data }) => {
    const { requireStudent } = await import("./app-session.server");
    const { ownDb } = await import("./own-db.server");
    const { attemptState, getRound, nextRoundInfo, num, readCodeDrafts, str } =
      await import("./comp.server");

    const { getRound3Languages } = await import("./execution.server");
    const claims = await requireStudent();
    const db = ownDb();

    const { data: found } = await db
      .from("programming_problems")
      .select("*")
      .eq("id", data.problemId)
      .maybeSingle();
    if (!found || !(found as Row)["isEnabled"]) throw new Error("Problem not found.");
    const problem = found as Row;

    const round = await getRound(str(problem["roundId"]));
    if (!round) throw new Error("Round not found.");
    const state = await attemptState(claims.studentId, round);

    const [{ data: visible }, { count: hiddenCount }, { data: subs }, { data: siblingRows }] =
      await Promise.all([
        // Only sample (visible) cases go to the browser. Hidden cases stay on
        // the server and are reported as a count; scoring uses all of them.
        db
          .from("test_cases")
          .select("id, input, expectedOutput, isHidden, orderNo")
          .eq("problemId", data.problemId)
          .eq("isHidden", false)
          .order("orderNo", { ascending: true }),

        db
          .from("test_cases")
          .select("id", { count: "exact", head: true })
          .eq("problemId", data.problemId)
          .eq("isHidden", true),
        db
          .from("programming_submissions")
          .select("id, language, status, score, passedTests, totalTests, executionMs, createdAt")
          .eq("studentId", claims.studentId)
          .eq("problemId", data.problemId)
          .order("createdAt", { ascending: false })
          .limit(20),
        db
          .from("programming_problems")
          .select("id, title, orderNo")
          .eq("roundId", str(problem["roundId"]))
          .eq("isEnabled", true)
          .order("orderNo", { ascending: true }),
      ]);

    return {
      problem: {
        id: str(problem["id"]),
        roundId: str(problem["roundId"]),
        title: str(problem["title"]),
        description: str(problem["description"]),
        inputFormat: str(problem["inputFormat"]),
        outputFormat: str(problem["outputFormat"]),
        constraints: str(problem["constraints"]),
        examples: str(problem["examples"]),
        starterCode: str(problem["starterCode"]),
        marks: num(problem["marks"]),
        timeLimitSec: num(problem["timeLimitSec"], 2),
        memoryLimitMb: num(problem["memoryLimitMb"], 128),
      },
      round: {
        id: str(round["id"]),
        name: str(round["name"]),
        type: str(round["type"]),
        state: state.gate.state,
      },
      nextRound: await nextRoundInfo(round),
      gate: state.gate,
      canPlay: state.canPlay,
      status: state.status,
      remainingSeconds: state.remainingSeconds,
      languages: await getRound3Languages(),
      // Sibling problems in this round, so the workspace can offer Previous/Next.
      siblings: (siblingRows ?? []).map((p) => ({
        id: str((p as Row)["id"]),
        title: str((p as Row)["title"]),
      })),
      // The student's last autosaved program for this problem, if any.
      // Draft first, then the admin's starter code, then a safe C template so the
      // editor is never empty when the student opens the problem.
      savedCode:
        readCodeDrafts(state.progress)[data.problemId] ||
        str(problem["starterCode"]) ||
        "#include <stdio.h>\n\nint main() {\n    // Write your code here\n    return 0;\n}\n",

      visibleTests: (visible ?? []).map((t, i) => ({
        index: i + 1,
        input: str((t as Row)["input"]),
        expectedOutput: str((t as Row)["expectedOutput"]),
      })),
      hiddenTestCount: hiddenCount ?? 0,
      submissions: (subs ?? []).map((s) => ({
        id: str((s as Row)["id"]),
        language: str((s as Row)["language"]),
        status: str((s as Row)["status"]),
        score: num((s as Row)["score"]),
        passedTests: num((s as Row)["passedTests"]),
        totalTests: num((s as Row)["totalTests"]),
        executionMs: num((s as Row)["executionMs"]),
        createdAt: str((s as Row)["createdAt"]),
      })),
    };
  });

/** Autosaves a Round 3 program so switching problems or refreshing keeps it. */
export const saveCodeDraft = createServerFn({ method: "POST" })
  .inputValidator((input: { problemId: string; sourceCode: string }) =>
    z.object({ problemId: z.string().min(1), sourceCode: z.string().max(100_000) }).parse(input),
  )
  .handler(async ({ data }) => {
    const { requireStudent } = await import("./app-session.server");
    const { ownDb } = await import("./own-db.server");
    const { getRound, requireWritableAttempt, saveCodeDraftRow, str } =
      await import("./comp.server");
    const claims = await requireStudent();

    const { data: found } = await ownDb()
      .from("programming_problems")
      .select("id, roundId, isEnabled")
      .eq("id", data.problemId)
      .maybeSingle();
    if (!found || !(found as Row)["isEnabled"]) throw new Error("Problem not found.");
    const round = await getRound(str((found as Row)["roundId"]));
    if (!round) throw new Error("Round not found.");
    const state = await requireWritableAttempt(claims.studentId, round);
    if (!state.progress) throw new Error("Your attempt for this round is not active.");
    await saveCodeDraftRow(state.progress, data.problemId, data.sourceCode);
    return { ok: true as const };
  });

/**
 * Round 3 Compile. Compiles the program through the CodeExecutionService
 * without running any test case. Nothing is scored.
 */
export const compileCode = createServerFn({ method: "POST" }).middleware([apiMetrics("student.compileCode")])
  .inputValidator((input: z.infer<typeof codeInput>) => codeInput.parse(input))
  .handler(async ({ data }) => {
    const { requireStudent } = await import("./app-session.server");
    const { ownDb } = await import("./own-db.server");
    const { getRound, requireWritableAttempt, str } = await import("./comp.server");
    const {
      ExecutionServiceError,
      SERVICE_UNAVAILABLE_MESSAGE,
      assertRound3Language,
      executeCode,
      recordAttempt,
      statusLabel,
    } = await import("./execution.server");
    const language = await assertRound3Language(data.language);
    const { num } = await import("./comp.server");
    const claims = await requireStudent();
    const { enforceRateLimit } = await import("./rate-limit.server");
    enforceRateLimit("run", claims.studentId);
    const db = ownDb();

    const { data: found } = await db
      .from("programming_problems")
      .select("*")
      .eq("id", data.problemId)
      .maybeSingle();
    if (!found) throw new Error("Problem not found.");
    const problem = found as Row;
    const round = await getRound(str(problem["roundId"]));
    if (!round) throw new Error("Round not found.");
    await requireWritableAttempt(claims.studentId, round);
    await recordAttempt(claims.studentId, data.problemId, "CODE", "compileAttempts");

    const t0 = Date.now();
    try {
      const run = await executeCode({
        language,
        code: data.code,
        stdin: "",
        timeLimitSec: num(problem["timeLimitSec"], 2),
        memoryLimitMb: num(problem["memoryLimitMb"], 128),
        studentId: claims.studentId,
        roundId: str(problem["roundId"]),
      });
      console.info(
        `[run-timing] compileCode student=${claims.studentId} problem=${data.problemId} ` +
          `outcome=${run.outcome} execMs=${Date.now() - t0}`,
      );
      return {
        serviceAvailable: true,
        compiled: run.outcome !== "compilation_error",
        status:
          run.outcome === "compilation_error" ? "Compilation error" : "Compilation successful",
        detail: statusLabel(run.outcome),
        compileOutput: run.compileOutput,
        output: run.stdout,
        error: run.outcome === "compilation_error" ? run.compileOutput : run.stderr,
        durationMs: run.durationMs,
        memoryKb: run.memoryKb,
        message: run.outcome === "compilation_error" ? "Compilation failed." : run.message,
      };
    } catch (err) {
      console.error(
        "[compile] execution service failure",
        err instanceof ExecutionServiceError ? err.detail : err,
      );
      return {
        serviceAvailable: false,
        compiled: false,
        status: "Judge error",
        detail: "Judge error",
        compileOutput: "",
        output: "",
        error: "",
        durationMs: 0,
        memoryKb: 0,
        message: err instanceof ExecutionServiceError ? err.message : SERVICE_UNAVAILABLE_MESSAGE,
      };
    }
  });

/** Trial run against visible test cases only. Nothing is stored or scored. */
export const runCode = createServerFn({ method: "POST" }).middleware([apiMetrics("student.runCode")])
  .inputValidator((input: z.infer<typeof codeInput>) => codeInput.parse(input))
  .handler(async ({ data }) => {
    const { requireStudent } = await import("./app-session.server");
    const { ownDb } = await import("./own-db.server");
    const { getRound, requireWritableAttempt, str } = await import("./comp.server");
    const { judgeSubmission } = await import("./judge.server");
    const { assertRound3Language, recordAttempt } = await import("./execution.server");
    const language = await assertRound3Language(data.language);
    const claims = await requireStudent();
    const { enforceRateLimit } = await import("./rate-limit.server");
    enforceRateLimit("run", claims.studentId);
    const db = ownDb();

    // The problem row and its visible test cases are independent reads keyed by
    // the same problem id, so they travel to the database together instead of
    // one after the other. A trial run only uses the sample (visible) cases;
    // hidden cases are reserved for the graded submission.
    const [{ data: problem }, { data: tests }] = await Promise.all([
      db.from("programming_problems").select("*").eq("id", data.problemId).maybeSingle(),
      db
        .from("test_cases")
        .select("*")
        .eq("problemId", data.problemId)
        .eq("isHidden", false)
        .order("orderNo", { ascending: true }),
    ]);
    if (!problem) throw new Error("Problem not found.");

    const round = await getRound(str((problem as Row)["roundId"]));
    if (!round) throw new Error("Round not found.");
    await requireWritableAttempt(claims.studentId, round);
    // The attempt counter is authoritative but not a precondition of the run:
    // it is written while the program executes instead of before it.
    const attemptCounted = recordAttempt(claims.studentId, data.problemId, "CODE", "runAttempts");

    const t0 = Date.now();
    const result = await judgeSubmission(
      language,
      data.code,
      (tests ?? []) as Row[],
      problem as Row,
      { studentId: claims.studentId, roundId: str(problem["roundId"]) },
    );
    await attemptCounted;
    console.info(
      `[run-timing] runCode student=${claims.studentId} problem=${data.problemId} ` +
        `tests=${(tests ?? []).length} status=${result.status} judgeMs=${Date.now() - t0}`,
    );


    return {
      status: result.status,
      message: result.message,
      passed: result.passed,
      total: result.total,
      durationMs: result.durationMs,
      memoryKb: result.memoryKb,
      compileOutput: result.compileOutput,
      results: result.results,
    };
  });

/**
 * Round 3 custom-input run. The student's program is executed once with the
 * exact stdin they typed. Nothing is stored or scored.
 */
export const runCodeWithInput = createServerFn({ method: "POST" }).middleware([apiMetrics("student.runCodeWithInput")])
  .inputValidator((input: z.infer<typeof codeInput> & { stdin?: string }) =>
    codeInput.extend({ stdin: z.string().max(20_000).optional() }).parse(input),
  )
  .handler(async ({ data }) => {
    const { requireStudent } = await import("./app-session.server");
    const { ownDb } = await import("./own-db.server");
    const { getRound, num, requireWritableAttempt, str } = await import("./comp.server");
    const {
      ExecutionServiceError,
      SERVICE_UNAVAILABLE_MESSAGE,
      assertRound3Language,
      executeCode,
      recordAttempt,
      statusLabel,
    } = await import("./execution.server");
    const language = await assertRound3Language(data.language);
    const claims = await requireStudent();
    const { enforceRateLimit } = await import("./rate-limit.server");
    enforceRateLimit("run", claims.studentId);

    const { data: found } = await ownDb()
      .from("programming_problems")
      .select("*")
      .eq("id", data.problemId)
      .maybeSingle();
    if (!found || !(found as Row)["isEnabled"]) throw new Error("Problem not found.");
    const problem = found as Row;
    const round = await getRound(str(problem["roundId"]));
    if (!round) throw new Error("Round not found.");
    await requireWritableAttempt(claims.studentId, round);
    // Counted while the program runs, not before it: the counter is written
    // either way and no longer costs the student a serial round trip.
    const attemptCounted = recordAttempt(claims.studentId, data.problemId, "CODE", "runAttempts");

    const stdin = data.stdin ?? "";
    const t0 = Date.now();
    try {
      const run = await executeCode({
        language,
        code: data.code,
        stdin,
        timeLimitSec: num(problem["timeLimitSec"], 2),
        memoryLimitMb: num(problem["memoryLimitMb"], 128),
        studentId: claims.studentId,
        roundId: str(problem["roundId"]),
      });
      await attemptCounted;
      console.info(
        `[run-timing] runCodeWithInput student=${claims.studentId} problem=${data.problemId} ` +
          `outcome=${run.outcome} execMs=${Date.now() - t0}`,
      );
      return {
        serviceAvailable: true,
        outcome: run.outcome,
        status: statusLabel(run.outcome),
        stdin,
        output: run.stdout,
        compileOutput: run.compileOutput,
        error: run.outcome === "compilation_error" ? run.compileOutput : run.stderr,
        durationMs: run.durationMs,
        memoryKb: run.memoryKb,
        message: run.message,
      };
    } catch (err) {
      console.error(
        "[run] execution service failure",
        err instanceof ExecutionServiceError ? err.detail : err,
      );
      return {
        serviceAvailable: false,
        outcome: "service_error" as const,
        status: "Judge error",
        stdin,
        output: "",
        compileOutput: "",
        error: "",
        durationMs: 0,
        memoryKb: 0,
        message: err instanceof ExecutionServiceError ? err.message : SERVICE_UNAVAILABLE_MESSAGE,
      };
    }
  });

/** Full judged submission: every test case runs, the score is stored server-side. */
export const submitCode = createServerFn({ method: "POST" }).middleware([apiMetrics("student.submitCode")])
  .inputValidator((input: z.infer<typeof codeInput>) => codeInput.parse(input))
  .handler(async ({ data }) => {
    const { requireStudent } = await import("./app-session.server");
    const { newId, nowIso, ownDb } = await import("./own-db.server");
    const { getRound, requireWritableAttempt, str } = await import("./comp.server");
    const { judgeSubmission, redactForStudent } = await import("./judge.server");
    const { assertRound3Language } = await import("./execution.server");
    const { recalcRoundScore } = await import("./scoring.server");
    const language = await assertRound3Language(data.language);
    const claims = await requireStudent();
    const { enforceRateLimit } = await import("./rate-limit.server");
    enforceRateLimit("submit", claims.studentId);
    const db = ownDb();

    const { data: found } = await db
      .from("programming_problems")
      .select("*")
      .eq("id", data.problemId)
      .maybeSingle();
    if (!found || !(found as Row)["isEnabled"]) throw new Error("Problem not found.");
    const problem = found as Row;

    const round = await getRound(str(problem["roundId"]));
    if (!round) throw new Error("Round not found.");
    await requireWritableAttempt(claims.studentId, round);

    const now = nowIso();
    const submissionId = newId();
    const { error: insertError } = await db.from("programming_submissions").insert({
      id: submissionId,
      studentId: claims.studentId,
      problemId: data.problemId,
      sourceCode: data.code,
      language,
      status: "RUNNING",
      score: 0,
      isFinal: false,
      submittedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    if (insertError) {
      console.error("[submit] insert failed", insertError.message);
      throw new Error("Could not record your submission. Please try again.");
    }

    const { data: tests } = await db
      .from("test_cases")
      .select("*")
      .eq("problemId", data.problemId)
      .order("orderNo", { ascending: true });

    const result = await judgeSubmission(language, data.code, (tests ?? []) as Row[], problem, {
      studentId: claims.studentId,
      roundId: str(problem["roundId"]),
      submissionId,
    });

    const { error: updateError } = await db
      .from("programming_submissions")
      .update({
        status: result.status,
        score: result.score,
        passedTests: result.passed,
        totalTests: result.total,
        executionMs: result.durationMs,
        memoryKb: result.memoryKb,
        compileOutput: result.compileOutput,
        executionOutput: result.executionOutput,
        resultJson: {
          message: result.message,
          passed: result.passed,
          failed: result.failed,
          total: result.total,
          durationMs: result.durationMs,
          memoryKb: result.memoryKb,
          memoryLimitMb: problem["memoryLimitMb"] ?? null,
          tests: result.results.map((r) => ({
            index: r.index,
            hidden: r.hidden,
            passed: r.passed,
            status: r.status ?? "",
          })),
        },
        updatedAt: nowIso(),
      })
      .eq("id", submissionId);
    if (updateError) console.error("[submit] update failed", updateError.message);

    const roundScore = await recalcRoundScore(claims.studentId, round);

    return {
      submissionId,
      status: result.status,
      score: result.score,
      passed: result.passed,
      failed: result.failed,
      total: result.total,
      durationMs: result.durationMs,
      message: result.message,
      results: redactForStudent(result.results),
      roundScore,
    };
  });

/** Records an anti-cheating violation for the current round. */
export const reportViolation = createServerFn({ method: "POST" })
  .inputValidator((input: { roundId: string; type: string; details?: string }) =>
    z
      .object({
        roundId: z.string().min(1),
        type: z.enum([
          "FULLSCREEN_EXIT",
          "TAB_HIDDEN",
          "WINDOW_BLUR",
          "MULTIPLE_SESSION",
          "COPY_PASTE",
        ]),
        details: z.string().max(500).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const { requireStudent } = await import("./app-session.server");
    const { newId, nowIso, ownDb } = await import("./own-db.server");
    const { num } = await import("./comp.server");
    const claims = await requireStudent();
    const { enforceRateLimit } = await import("./rate-limit.server");
    enforceRateLimit("violation", claims.studentId);
    const db = ownDb();

    await db.from("violations").insert({
      id: newId(),
      studentId: claims.studentId,
      roundId: data.roundId,
      type: data.type,
      count: 1,
      details: data.details ?? "",
      createdAt: nowIso(),
    });

    const [{ count }, { data: settings }] = await Promise.all([
      db
        .from("violations")
        .select("id", { count: "exact", head: true })
        .eq("studentId", claims.studentId)
        .eq("roundId", data.roundId),
      db.from("event_settings").select("fullscreenViolationLimit").limit(1),
    ]);
    const limit = num((settings?.[0] as Row | undefined)?.["fullscreenViolationLimit"], 3);
    const total = count ?? 0;

    if (total >= limit) {
      const now = nowIso();
      await db
        .from("round_progress")
        .update({ status: "LOCKED", lockedAt: now, updatedAt: now })
        .eq("studentId", claims.studentId)
        .eq("roundId", data.roundId)
        .eq("status", "IN_PROGRESS");
    }
    return { total, limit, locked: total >= limit };
  });

/** Round-by-round results for the signed-in student. */
export const getMyResults = createServerFn({ method: "GET" }).handler(async () => {
  const { requireStudent } = await import("./app-session.server");
  const { ownDb } = await import("./own-db.server");
  const { num, str } = await import("./comp.server");
  const claims = await requireStudent();
  const db = ownDb();

  const [
    { data: rounds },
    { data: scores },
    { data: final },
    { data: visibility },
    { count: participants },
  ] = await Promise.all([
    db.from("rounds").select("id, name, type, orderNo, maxMarks, state").order("orderNo"),
    db
      .from("round_scores")
      .select("roundId, score, maxMarks, evaluatedAt")
      .eq("studentId", claims.studentId),
    db
      .from("final_scores")
      .select("totalScore, maxScore, rank")
      .eq("studentId", claims.studentId)
      .maybeSingle(),
    db.from("visibility_settings").select("showResults, showAnswers").limit(1),
    db.from("students").select("id", { count: "exact", head: true }),
  ]);

  const published = Boolean((visibility?.[0] as Row | undefined)?.["showResults"]);
  const scoreByRound = new Map((scores ?? []).map((s) => [str((s as Row)["roundId"]), s as Row]));
  return {
    published,
    participants: participants ?? 0,
    total: num((final as Row | null)?.["totalScore"]),
    max: num(
      (final as Row | null)?.["maxScore"] ??
        (rounds ?? []).reduce((s, r) => s + num((r as Row)["maxMarks"]), 0),
    ),
    rank: published ? (((final as Row | null)?.["rank"] as number | null) ?? null) : null,
    rounds: (rounds ?? []).map((r) => {
      const row = r as Row;
      const mine = scoreByRound.get(str(row["id"]));
      return {
        id: str(row["id"]),
        name: str(row["name"]),
        type: str(row["type"]),
        maxMarks: num(row["maxMarks"]),
        score: mine ? num(mine["score"]) : null,
        evaluatedAt: (mine?.["evaluatedAt"] as string | null) ?? null,
      };
    }),
  };
});

/** Complete submission history (Bug Hunt + Code Sprint) for the student. */
export const getMySubmissions = createServerFn({ method: "GET" }).middleware([apiMetrics("student.getMySubmissions")]).handler(async () => {
  const { requireStudent } = await import("./app-session.server");
  const { ownDb } = await import("./own-db.server");
  const { num, str } = await import("./comp.server");
  const claims = await requireStudent();
  const db = ownDb();

  const [{ data: prog }, { data: debug }, { data: progProblems }, { data: debugProblems }] =
    await Promise.all([
      db
        .from("programming_submissions")
        .select(
          "id, problemId, language, status, score, passedTests, totalTests, executionMs, createdAt",
        )
        .eq("studentId", claims.studentId)
        .order("createdAt", { ascending: false })
        .limit(100),
      db
        .from("debugging_submissions")
        .select("id, problemId, score, message, createdAt")
        .eq("studentId", claims.studentId)
        .order("createdAt", { ascending: false })
        .limit(100),
      db.from("programming_problems").select("id, title"),
      db.from("debugging_problems").select("id, title"),
    ]);

  // Title lookups indexed once; 100 submissions x every problem row added up.
  const progTitles = new Map(
    (progProblems ?? []).map((r) => [str((r as Row)["id"]), str((r as Row)["title"], "Problem")]),
  );
  const debugTitles = new Map(
    (debugProblems ?? []).map((r) => [str((r as Row)["id"]), str((r as Row)["title"], "Problem")]),
  );
  const titleOf = (rows: Row[] | null | undefined, id: string) =>
    (rows === (progProblems as Row[]) ? progTitles : debugTitles).get(id) ?? "Problem";

  return {
    code: (prog ?? []).map((s) => {
      const row = s as Row;
      return {
        id: str(row["id"]),
        title: titleOf(progProblems as Row[], str(row["problemId"])),
        language: str(row["language"]),
        status: str(row["status"]),
        score: num(row["score"]),
        passedTests: num(row["passedTests"]),
        totalTests: num(row["totalTests"]),
        executionMs: num(row["executionMs"]),
        createdAt: str(row["createdAt"]),
      };
    }),
    debug: (debug ?? []).map((s) => {
      const row = s as Row;
      return {
        id: str(row["id"]),
        title: titleOf(debugProblems as Row[], str(row["problemId"])),
        score: num(row["score"]),
        message: str(row["message"]),
        createdAt: str(row["createdAt"]),
      };
    }),
  };
});

/** Profile card data for the signed-in student. */
export const getMyProfile = createServerFn({ method: "GET" }).handler(async () => {
  const { requireStudent } = await import("./app-session.server");
  const { ownDb } = await import("./own-db.server");
  const { num, str } = await import("./comp.server");
  const claims = await requireStudent();
  const db = ownDb();

  const { data: student } = await db
    .from("students")
    .select("id, fullName, status, batchId, createdAt")
    .eq("id", claims.studentId)
    .maybeSingle();
  const row = (student as Row | null) ?? {};
  const [{ data: user }, { data: batch }, { count: sessions }] = await Promise.all([
    db.from("users").select("studentId, username").eq("id", claims.sub).maybeSingle(),
    row["batchId"]
      ? db.from("batches").select("code, name").eq("id", str(row["batchId"])).maybeSingle()
      : Promise.resolve({ data: null }),
    db
      .from("sessions")
      .select("id", { count: "exact", head: true })
      .eq("studentId", claims.studentId)
      .eq("isRevoked", false),
  ]);

  return {
    fullName: str(row["fullName"], "Student"),
    studentCode: str((user as Row | null)?.["studentId"], "—"),
    batchNumber: str((batch as Row | null)?.["code"], "—"),
    status: str(row["status"], "ACTIVE"),
    joinedAt: str(row["createdAt"]),
    activeSessions: num(sessions),
  };
});
