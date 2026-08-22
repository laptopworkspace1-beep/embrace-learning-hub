import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { Row } from "./comp.server";

/* ------------------------------------------------------------------ */
/* Overview + live monitoring                                          */
/* ------------------------------------------------------------------ */

export const getAdminOverview = createServerFn({ method: "GET" }).handler(async () => {
  const { requireAdmin } = await import("./app-session.server");
  const { ownDb } = await import("./own-db.server");
  const { num, str } = await import("./comp.server");
  await requireAdmin();
  const db = ownDb();

  const count = async (table: string) => {
    const { count: c } = await db.from(table).select("id", { count: "exact", head: true });
    return c ?? 0;
  };

  // One single round-trip fan-out instead of four sequential stages: every
  // read below is independent, so waiting on them one group at a time only
  // added latency to the admin overview.
  const [
    students,
    batches,
    violations,
    progSubs,
    debugSubs,
    { data: rounds },
    { data: event },
    { count: liveSessions },
    { data: progress },
    { data: recent },
    { data: recentViolations },
  ] = await Promise.all([
    count("students"),
    count("batches"),
    count("violations"),
    count("programming_submissions"),
    count("debugging_submissions"),
    db.from("rounds").select("*").order("orderNo"),
    db.from("events").select("*").order("createdAt").limit(1),
    db.from("sessions").select("id", { count: "exact", head: true }).eq("isRevoked", false),
    db.from("round_progress").select("roundId, status"),
    db
      .from("programming_submissions")
      .select("id, status, score, language, createdAt, studentId, passedTests, totalTests")
      .order("createdAt", { ascending: false })
      .limit(12),
    db
      .from("violations")
      .select("id, studentId, roundId, type, details, createdAt")
      .order("createdAt", { ascending: false })
      .limit(12),
  ]);

  // Both name lookups depend on the rows above, but not on each other.
  const ids = [...new Set((recent ?? []).map((r) => str((r as Row)["studentId"])))];
  const vIds = [...new Set((recentViolations ?? []).map((r) => str((r as Row)["studentId"])))];
  const [{ data: names }, { data: vNames }] = await Promise.all([
    ids.length ? db.from("students").select("id, fullName").in("id", ids) : { data: [] as Row[] },
    vIds.length ? db.from("students").select("id, fullName").in("id", vIds) : { data: [] as Row[] },
  ]);

  // Index once, read many: the previous version scanned the name list for
  // every rendered row.
  const nameIndex = (rows: Row[] | null | undefined) =>
    new Map((rows ?? []).map((n) => [str(n["id"]), str(n["fullName"], "Unknown student")]));
  const nameMaps = new WeakMap<object, Map<string, string>>();
  const nameOf = (rows: Row[] | null | undefined, id: string) => {
    const key = (rows ?? []) as object;
    let map = nameMaps.get(key);
    if (!map) {
      map = nameIndex(rows);
      nameMaps.set(key, map);
    }
    return map.get(id) ?? "Unknown student";
  };

  // Round progress bucketed once instead of re-filtered per round.
  const progressByRound = new Map<string, { inProgress: number; submitted: number }>();
  for (const p of progress ?? []) {
    const row = p as Row;
    const key = str(row["roundId"]);
    const bucket = progressByRound.get(key) ?? { inProgress: 0, submitted: 0 };
    const status = str(row["status"]);
    if (status === "IN_PROGRESS") bucket.inProgress += 1;
    else if (status === "SUBMITTED") bucket.submitted += 1;
    progressByRound.set(key, bucket);
  }

  return {
    students,
    batches,
    violations,
    submissions: progSubs + debugSubs,
    liveSessions: liveSessions ?? 0,
    event: event?.[0]
      ? {
          id: str((event[0] as Row)["id"]),
          title: str((event[0] as Row)["title"]),
          status: str((event[0] as Row)["status"]),
        }
      : null,
    rounds: (rounds ?? []).map((r) => {
      const row = r as Row;
      const mine = progressByRound.get(str(row["id"])) ?? { inProgress: 0, submitted: 0 };
      return {
        id: str(row["id"]),
        name: str(row["name"]),
        type: str(row["type"]),
        state: str(row["state"]),
        durationMinutes: num(row["durationMinutes"]),
        maxMarks: num(row["maxMarks"]),
        inProgress: mine.inProgress,
        submitted: mine.submitted,
      };
    }),
    recentSubmissions: (recent ?? []).map((r) => {
      const row = r as Row;
      return {
        id: str(row["id"]),
        student: nameOf(names as Row[], str(row["studentId"])),
        status: str(row["status"]),
        score: num(row["score"]),
        language: str(row["language"]),
        passedTests: num(row["passedTests"]),
        totalTests: num(row["totalTests"]),
        createdAt: str(row["createdAt"]),
      };
    }),
    recentViolations: (recentViolations ?? []).map((r) => {
      const row = r as Row;
      return {
        id: str(row["id"]),
        student: nameOf(vNames as Row[], str(row["studentId"])),
        type: str(row["type"]),
        details: str(row["details"]),
        createdAt: str(row["createdAt"]),
      };
    }),
  };
});

/* ------------------------------------------------------------------ */
/* Students                                                            */
/* ------------------------------------------------------------------ */

export const listStudents = createServerFn({ method: "POST" })
  .inputValidator((input: { search?: string; batch?: string }) =>
    z.object({ search: z.string().max(120).optional(), batch: z.string().max(20).optional() }).parse(input),
  )
  .handler(async ({ data }) => {
    const { requireAdmin } = await import("./app-session.server");
    const { ownDb } = await import("./own-db.server");
    const { num, str } = await import("./comp.server");
    await requireAdmin();
    const db = ownDb();

    const [{ data: students }, { data: users }, { data: batches }, { data: scores }, { data: sessions }] =
      await Promise.all([
        db.from("students").select("*").order("createdAt", { ascending: false }).limit(2000),
        db.from("users").select("id, studentId, username, isActive, role"),
        db.from("batches").select("id, code, name"),
        db.from("final_scores").select("studentId, totalScore, rank"),
        db.from("sessions").select("studentId, isRevoked, expiresAt").eq("isRevoked", false),
      ]);

    // Indexed joins: with 2000 students the per-row scans below were the
    // dominant cost of this endpoint.
    const batchById = new Map((batches ?? []).map((b) => [str((b as Row)["id"]), b as Row]));
    const userById = new Map((users ?? []).map((u) => [str((u as Row)["id"]), u as Row]));
    const scoreByStudent = new Map((scores ?? []).map((f) => [str((f as Row)["studentId"]), f as Row]));
    const now = Date.now();
    const liveByStudent = new Map<string, number>();
    for (const x of sessions ?? []) {
      const row = x as Row;
      if (new Date(str(row["expiresAt"])).getTime() <= now) continue;
      const key = str(row["studentId"]);
      liveByStudent.set(key, (liveByStudent.get(key) ?? 0) + 1);
    }
    const batchOf = (id: string) => batchById.get(id);
    const rows = (students ?? []).map((s) => {
      const row = s as Row;
      const user = userById.get(str(row["userId"]));
      const score = scoreByStudent.get(str(row["id"]));
      const live = liveByStudent.get(str(row["id"])) ?? 0;
      return {
        id: str(row["id"]),
        userId: str(row["userId"]),
        fullName: str(row["fullName"]),
        studentCode: str(user?.["studentId"], "—"),
        batchNumber: str(batchOf(str(row["batchId"]))?.["code"], "—"),
        status: str(row["status"]),
        active: Boolean(user?.["isActive"]),
        totalScore: num(score?.["totalScore"]),
        rank: (score?.["rank"] as number | null) ?? null,
        activeSessions: live,
        createdAt: str(row["createdAt"]),
      };
    });

    const term = (data.search ?? "").trim().toLowerCase();
    const filtered = rows.filter((r) => {
      const matchesTerm =
        !term ||
        r.fullName.toLowerCase().includes(term) ||
        r.studentCode.toLowerCase().includes(term) ||
        r.batchNumber.toLowerCase().includes(term);
      const matchesBatch = !data.batch || data.batch === "all" || r.batchNumber === data.batch;
      return matchesTerm && matchesBatch;
    });

    return {
      students: filtered,
      batches: (batches ?? [])
        .map((b) => str((b as Row)["code"]))
        .sort((a, b) => a.localeCompare(b)),
      total: rows.length,
    };
  });

export const setStudentActive = createServerFn({ method: "POST" })
  .inputValidator((input: { userId: string; active: boolean }) =>
    z.object({ userId: z.string().min(1), active: z.boolean() }).parse(input),
  )
  .handler(async ({ data }) => {
    const { requireAdmin } = await import("./app-session.server");
    const { audit, nowIso, ownDb } = await import("./own-db.server");
    const claims = await requireAdmin();
    const db = ownDb();
    const { error } = await db
      .from("users")
      .update({ isActive: data.active, updatedAt: nowIso() })
      .eq("id", data.userId);
    if (error) throw new Error("Could not update this student.");
    if (!data.active) {
      await db
        .from("sessions")
        .update({ isRevoked: true, revokedAt: nowIso(), updatedAt: nowIso() })
        .eq("userId", data.userId)
        .eq("isRevoked", false);
      (await import("./app-session.server")).invalidateSessionCache();
    }

    await audit({
      actorUserId: claims.sub,
      targetUserId: data.userId,
      action: data.active ? "student.enabled" : "student.disabled",
      entityType: "users",
      entityId: data.userId,
    });
    return { ok: true as const };
  });

/** Frees a student who is stuck behind an old session on another device. */
export const revokeStudentSessions = createServerFn({ method: "POST" })
  .inputValidator((input: { userId: string }) => z.object({ userId: z.string().min(1) }).parse(input))
  .handler(async ({ data }) => {
    const { requireAdmin } = await import("./app-session.server");
    const { audit, nowIso, ownDb } = await import("./own-db.server");
    const claims = await requireAdmin();
    const { error } = await ownDb()
      .from("sessions")
      .update({ isRevoked: true, revokedAt: nowIso(), updatedAt: nowIso() })
      .eq("userId", data.userId)
      .eq("isRevoked", false);
    (await import("./app-session.server")).invalidateSessionCache();

    if (error) throw new Error("Could not clear those sessions.");
    await audit({
      actorUserId: claims.sub,
      targetUserId: data.userId,
      action: "session.revoked",
      entityType: "sessions",
      entityId: data.userId,
    });
    return { ok: true as const };
  });

/* ------------------------------------------------------------------ */
/* Event + round control                                               */
/* ------------------------------------------------------------------ */

export const getAdminRounds = createServerFn({ method: "GET" }).handler(async () => {
  const { requireAdmin } = await import("./app-session.server");
  const { ownDb } = await import("./own-db.server");
  const { num, str } = await import("./comp.server");
  await requireAdmin();
  const db = ownDb();

  const [
    { data: event },
    { data: rounds },
    { data: questions },
    { data: debugProblems },
    { data: codeProblems },
    { data: progress },
    { data: settings },
  ] = await Promise.all([
    db.from("events").select("*").order("createdAt").limit(1),
    db.from("rounds").select("*").order("orderNo"),
    db.from("questions").select("id, roundId, isEnabled"),
    db.from("debugging_problems").select("id, roundId, isEnabled"),
    db.from("programming_problems").select("id, roundId, isEnabled"),
    db.from("round_progress").select("roundId, status"),
    db.from("visibility_settings").select("*").limit(1),
  ]);

  return {
    event: event?.[0]
      ? {
          id: str((event[0] as Row)["id"]),
          title: str((event[0] as Row)["title"]),
          status: str((event[0] as Row)["status"]),
        }
      : null,
    resultsPublished: Boolean((settings?.[0] as Row | undefined)?.["showResults"]),
    answersPublished: Boolean((settings?.[0] as Row | undefined)?.["showAnswers"]),
    rounds: (rounds ?? []).map((r) => {
      const row = r as Row;
      const id = str(row["id"]);
      const mine = (progress ?? []).filter((p) => str((p as Row)["roundId"]) === id);
      const items =
        str(row["type"]) === "ROUND1"
          ? (questions ?? []).filter((q) => str((q as Row)["roundId"]) === id).length
          : str(row["type"]) === "ROUND2"
            ? (debugProblems ?? []).filter((q) => str((q as Row)["roundId"]) === id).length
            : (codeProblems ?? []).filter((q) => str((q as Row)["roundId"]) === id).length;
      return {
        id,
        name: str(row["name"]),
        type: str(row["type"]),
        orderNo: num(row["orderNo"]),
        state: str(row["state"]),
        durationMinutes: num(row["durationMinutes"]),
        maxMarks: num(row["maxMarks"]),
        startTime: (row["startTime"] as string | null) ?? null,
        endTime: (row["endTime"] as string | null) ?? null,
        itemCount: items,
        inProgress: mine.filter((p) => str((p as Row)["status"]) === "IN_PROGRESS").length,
        submitted: mine.filter((p) => str((p as Row)["status"]) === "SUBMITTED").length,
      };
    }),
  };
});

/**
 * Round lifecycle. Resuming shifts every in-flight deadline by the paused
 * duration, so no student loses time while the event is halted.
 */
export const controlRound = createServerFn({ method: "POST" })
  .inputValidator((input: { roundId: string; action: "start" | "pause" | "resume" | "end" | "reset" }) =>
    z
      .object({
        roundId: z.string().min(1),
        action: z.enum(["start", "pause", "resume", "end", "reset"]),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const { requireAdmin } = await import("./app-session.server");
    const { audit, nowIso, ownDb } = await import("./own-db.server");
    const { num, str } = await import("./comp.server");
    const claims = await requireAdmin();
    const db = ownDb();

    const { data: found } = await db.from("rounds").select("*").eq("id", data.roundId).maybeSingle();
    if (!found) throw new Error("Round not found.");
    const round = found as Row;
    const now = new Date();
    const nowStr = now.toISOString();
    let patch: Record<string, unknown> = { updatedAt: nowStr };

    const { parseTs } = await import("./comp.server");

    if (data.action === "start") {
      // One universal deadline, written once, read by admin and every student.
      const deadline = new Date(now.getTime() + num(round["durationMinutes"], 30) * 60_000);
      patch = {
        ...patch,
        state: "LIVE",
        startTime: nowStr,
        endTime: null,
        deadlineAt: deadline.toISOString(),
        pausedAt: null,
        totalPausedSeconds: 0,
      };
      await db
        .from("round_progress")
        .update({ endsAt: deadline.toISOString(), updatedAt: nowStr })
        .eq("roundId", data.roundId)
        .eq("status", "IN_PROGRESS");
    } else if (data.action === "pause") {
      if (str(round["state"]) !== "LIVE") throw new Error("Only a live round can be paused.");
      patch = { ...patch, state: "PAUSED", pausedAt: nowStr };
    } else if (data.action === "resume") {
      if (str(round["state"]) !== "PAUSED") throw new Error("Only a paused round can be resumed.");
      const pausedAtMs = parseTs(round["pausedAt"]) ?? now.getTime();
      const pausedSeconds = Math.max(0, Math.floor((now.getTime() - pausedAtMs) / 1000));
      const currentDeadline = parseTs(round["deadlineAt"]);
      patch = {
        ...patch,
        state: "LIVE",
        pausedAt: null,
        totalPausedSeconds: num(round["totalPausedSeconds"]) + pausedSeconds,
        ...(currentDeadline
          ? { deadlineAt: new Date(currentDeadline + pausedSeconds * 1000).toISOString() }
          : {}),
      };
      const { data: attempts } = await db
        .from("round_progress")
        .select("id, endsAt")
        .eq("roundId", data.roundId)
        .eq("status", "IN_PROGRESS");
      for (const attempt of attempts ?? []) {
        const row = attempt as Row;
        const endsAtMs = parseTs(row["endsAt"]);
        if (!endsAtMs) continue;
        const shifted = new Date(endsAtMs + pausedSeconds * 1000);
        await db
          .from("round_progress")
          .update({ endsAt: shifted.toISOString(), updatedAt: nowStr })
          .eq("id", str(row["id"]));
      }
    } else if (data.action === "end") {
      patch = { ...patch, state: "ENDED", endTime: nowStr, pausedAt: null, deadlineAt: nowStr };
      const { data: attempts } = await db
        .from("round_progress")
        .select("studentId")
        .eq("roundId", data.roundId)
        .eq("status", "IN_PROGRESS");
      await db
        .from("round_progress")
        .update({ status: "SUBMITTED", submittedAt: nowStr, updatedAt: nowStr })
        .eq("roundId", data.roundId)
        .eq("status", "IN_PROGRESS");
      const { recalcRoundScoresFor, rebuildRanks } = await import("./scoring.server");
      await recalcRoundScoresFor(
        (attempts ?? []).map((attempt) => str((attempt as Row)["studentId"])),
        round,
      );
      await rebuildRanks();

    } else {
      // Restart timer: same round, brand new universal clock for everyone.
      const wasLive = str(round["state"]) === "LIVE" || str(round["state"]) === "PAUSED";
      const deadline = new Date(now.getTime() + num(round["durationMinutes"], 30) * 60_000);
      patch = {
        ...patch,
        state: wasLive ? "LIVE" : "READY",
        startTime: wasLive ? nowStr : null,
        endTime: null,
        deadlineAt: wasLive ? deadline.toISOString() : null,
        pausedAt: null,
        totalPausedSeconds: 0,
      };
      await db
        .from("round_progress")
        .update({ endsAt: wasLive ? deadline.toISOString() : null, updatedAt: nowStr })
        .eq("roundId", data.roundId)
        .eq("status", "IN_PROGRESS");
    }

    const { error } = await db.from("rounds").update(patch).eq("id", data.roundId);
    if (error) throw new Error("Could not update the round.");
    await audit({
      actorUserId: claims.sub,
      action: `round.${data.action}`,
      entityType: "rounds",
      entityId: data.roundId,
      metadata: { name: str(round["name"]) },
    });
    return { ok: true as const, state: str(patch["state"]) };
  });

export const updateRound = createServerFn({ method: "POST" })
  .inputValidator(
    (input: { roundId: string; name: string; durationMinutes: number; maxMarks: number }) =>
      z
        .object({
          roundId: z.string().min(1),
          name: z.string().trim().min(2).max(160),
          durationMinutes: z.coerce.number().int().min(1).max(600),
          maxMarks: z.coerce.number().int().min(1).max(10_000),
        })
        .parse(input),
  )
  .handler(async ({ data }) => {
    const { requireAdmin } = await import("./app-session.server");
    const { audit, nowIso, ownDb } = await import("./own-db.server");
    const claims = await requireAdmin();
    const { error } = await ownDb()
      .from("rounds")
      .update({
        name: data.name,
        durationMinutes: data.durationMinutes,
        maxMarks: data.maxMarks,
        updatedAt: nowIso(),
      })
      .eq("id", data.roundId);
    if (error) throw new Error("Could not save the round.");
    await audit({
      actorUserId: claims.sub,
      action: "round.updated",
      entityType: "rounds",
      entityId: data.roundId,
      metadata: { ...data },
    });
    return { ok: true as const };
  });

export const setResultsVisibility = createServerFn({ method: "POST" })
  .inputValidator((input: { showResults: boolean; showAnswers: boolean }) =>
    z.object({ showResults: z.boolean(), showAnswers: z.boolean() }).parse(input),
  )
  .handler(async ({ data }) => {
    const { requireAdmin } = await import("./app-session.server");
    const { nowIso, ownDb } = await import("./own-db.server");
    const { str } = await import("./comp.server");
    await requireAdmin();
    const db = ownDb();
    const { data: existing } = await db.from("visibility_settings").select("id").limit(1);
    const id = str((existing?.[0] as Row | undefined)?.["id"]);
    if (!id) throw new Error("Visibility settings are missing for this event.");
    const { error } = await db
      .from("visibility_settings")
      .update({ showResults: data.showResults, showAnswers: data.showAnswers, updatedAt: nowIso() })
      .eq("id", id);
    if (error) throw new Error("Could not update result visibility.");
    return { ok: true as const };
  });

/* ------------------------------------------------------------------ */
/* Round 1 — questions                                                 */
/* ------------------------------------------------------------------ */

const questionInput = z.object({
  id: z.string().min(1).optional(),
  roundId: z.string().min(1),
  type: z.enum(["MCQ", "OUTPUT"]),
  prompt: z.string().trim().min(3).max(4000),
  codeSnippet: z.string().max(4000).optional(),
  expectedOutput: z.string().max(2000).optional(),
  correctOptionKey: z.string().trim().max(8).optional(),
  marks: z.coerce.number().int().min(1).max(1000),
  negativeMarks: z.coerce.number().int().min(0).max(1000),
  orderNo: z.coerce.number().int().min(1).max(1000),
  isEnabled: z.boolean(),
  options: z
    .array(z.object({ optionKey: z.string().trim().min(1).max(8), optionText: z.string().trim().min(1).max(1000) }))
    .max(8),
});

export const listQuestions = createServerFn({ method: "POST" })
  .inputValidator((input: { roundId: string }) => z.object({ roundId: z.string().min(1) }).parse(input))
  .handler(async ({ data }) => {
    const { requireAdmin } = await import("./app-session.server");
    const { ownDb } = await import("./own-db.server");
    const { num, str } = await import("./comp.server");
    await requireAdmin();
    const db = ownDb();
    const { data: questions } = await db
      .from("questions")
      .select("*")
      .eq("roundId", data.roundId)
      .order("orderNo");
    const ids = (questions ?? []).map((q) => str((q as Row)["id"]));
    const { data: options } = ids.length
      ? await db.from("question_options").select("*").in("questionId", ids).order("orderNo")
      : { data: [] as Row[] };
    return (questions ?? []).map((q) => {
      const row = q as Row;
      return {
        id: str(row["id"]),
        type: str(row["type"]),
        prompt: str(row["prompt"]),
        codeSnippet: str(row["codeSnippet"]),
        expectedOutput: str(row["expectedOutput"]),
        correctOptionKey: str(row["correctOptionKey"]),
        marks: num(row["marks"]),
        negativeMarks: num(row["negativeMarks"]),
        orderNo: num(row["orderNo"]),
        isEnabled: Boolean(row["isEnabled"]),
        options: (options ?? [])
          .filter((o) => str((o as Row)["questionId"]) === str(row["id"]))
          .map((o) => ({
            optionKey: str((o as Row)["optionKey"]),
            optionText: str((o as Row)["optionText"]),
          })),
      };
    });
  });

export const saveQuestion = createServerFn({ method: "POST" })
  .inputValidator((input: z.infer<typeof questionInput>) => questionInput.parse(input))
  .handler(async ({ data }) => {
    const { requireAdmin } = await import("./app-session.server");
    const { audit, newId, nowIso, ownDb } = await import("./own-db.server");
    const claims = await requireAdmin();
    const db = ownDb();

    if (data.type === "MCQ") {
      if (data.options.length < 2) throw new Error("Add at least two options.");
      if (!data.correctOptionKey || !data.options.some((o) => o.optionKey === data.correctOptionKey))
        throw new Error("Choose which option is the correct answer.");
    } else if (!data.expectedOutput?.trim()) {
      throw new Error("Enter the expected output for this question.");
    }

    const now = nowIso();
    const row = {
      roundId: data.roundId,
      type: data.type,
      prompt: data.prompt,
      codeSnippet: data.codeSnippet ?? null,
      expectedOutput: data.type === "OUTPUT" ? (data.expectedOutput ?? "") : null,
      comparisonMethod: "TRIMMED_OUTPUT",
      correctOptionKey: data.type === "MCQ" ? (data.correctOptionKey ?? null) : null,
      marks: data.marks,
      negativeMarks: data.negativeMarks,
      orderNo: data.orderNo,
      isEnabled: data.isEnabled,
      updatedAt: now,
    };

    const questionId = data.id ?? newId();
    const result = data.id
      ? await db.from("questions").update(row).eq("id", data.id)
      : await db.from("questions").insert({ id: questionId, ...row, createdAt: now });
    if (result.error) {
      console.error("[admin] question save failed", result.error.message);
      throw new Error("Could not save the question.");
    }

    await db.from("question_options").delete().eq("questionId", questionId);
    if (data.type === "MCQ" && data.options.length) {
      const { error } = await db.from("question_options").insert(
        data.options.map((o, index) => ({
          id: newId(),
          questionId,
          optionKey: o.optionKey,
          optionText: o.optionText,
          orderNo: index + 1,
          createdAt: now,
          updatedAt: now,
        })),
      );
      if (error) throw new Error("Could not save the answer options.");
    }

    await audit({
      actorUserId: claims.sub,
      action: data.id ? "question.updated" : "question.created",
      entityType: "questions",
      entityId: questionId,
    });
    return { ok: true as const, id: questionId };
  });

export const deleteQuestion = createServerFn({ method: "POST" })
  .inputValidator((input: { id: string }) => z.object({ id: z.string().min(1) }).parse(input))
  .handler(async ({ data }) => {
    const { requireAdmin } = await import("./app-session.server");
    const { audit, nowIso, ownDb } = await import("./own-db.server");
    const claims = await requireAdmin();
    const db = ownDb();
    const { count } = await db
      .from("student_answers")
      .select("id", { count: "exact", head: true })
      .eq("questionId", data.id);
    if ((count ?? 0) > 0) {
      // Answers exist: never destroy competition data, deactivate instead.
      const { error } = await db
        .from("questions")
        .update({ isEnabled: false, updatedAt: nowIso() })
        .eq("id", data.id);
      if (error) throw new Error("Could not deactivate the question.");
      await audit({
        actorUserId: claims.sub,
        action: "question.deactivated",
        entityType: "questions",
        entityId: data.id,
      });
      return { ok: true as const, deactivated: true };
    }
    await db.from("question_options").delete().eq("questionId", data.id);
    const { error } = await db.from("questions").delete().eq("id", data.id);
    if (error) throw new Error("Could not delete the question.");
    await audit({
      actorUserId: claims.sub,
      action: "question.deleted",
      entityType: "questions",
      entityId: data.id,
    });
    return { ok: true as const, deactivated: false };
  });

/* ------------------------------------------------------------------ */
/* Round 2 — debugging problems + bug definitions                      */
/* ------------------------------------------------------------------ */

export const listDebugProblems = createServerFn({ method: "GET" }).handler(async () => {
  const { requireAdmin } = await import("./app-session.server");
  const { ownDb } = await import("./own-db.server");
  const { num, str } = await import("./comp.server");
  await requireAdmin();
  const db = ownDb();
  const [{ data: problems }, { data: bugs }, { data: tests }, { data: subs }, { data: rounds }] =
    await Promise.all([
      db.from("debugging_problems").select("*").order("orderNo"),
      db.from("bug_definitions").select("*").order("orderNo"),
      db.from("debug_test_cases").select("*").order("orderNo"),
      db.from("debugging_submissions").select("problemId"),
      db.from("rounds").select("id, name, type, state, maxMarks").eq("type", "ROUND2"),
    ]);
  const items = (problems ?? []).map((p) => {
    const row = p as Row;
    const id = str(row["id"]);
    return {
      id,
      roundId: str(row["roundId"]),
      title: str(row["title"]),
      description: str(row["description"]),
      language: str(row["language"]) || "C",
      expectedBehavior: str(row["expectedBehavior"]),
      buggyCode: str(row["buggyCode"]),
      publicInput: str(row["publicInput"]),
      publicExpectedOutput: str(row["publicExpectedOutput"]),
      marks: num(row["marks"]),
      baseMarks: num(row["baseMarks"]),
      timeLimitSec: num(row["timeLimitSec"], 2),
      memoryLimitMb: num(row["memoryLimitMb"], 128),
      orderNo: num(row["orderNo"]),
      isEnabled: Boolean(row["isEnabled"]),
      submissions: (subs ?? []).filter((s) => str((s as Row)["problemId"]) === id).length,
      tests: (tests ?? [])
        .filter((t) => str((t as Row)["problemId"]) === id)
        .map((t) => ({
          id: str((t as Row)["id"]),
          problemId: id,
          name: str((t as Row)["name"]),
          input: str((t as Row)["input"]),
          expectedOutput: str((t as Row)["expectedOutput"]),
          isHidden: Boolean((t as Row)["isHidden"]),
          isEnabled: (t as Row)["isEnabled"] !== false,
          marks: num((t as Row)["marks"], 1),
          orderNo: num((t as Row)["orderNo"], 1),
        })),
      bugs: (bugs ?? [])
        .filter((b) => str((b as Row)["problemId"]) === id)
        .map((b) => ({
          id: str((b as Row)["id"]),
          bugCode: str((b as Row)["bugCode"]),
          title: str((b as Row)["title"]),
          description: str((b as Row)["description"]),
          marks: num((b as Row)["marks"]),
          orderNo: num((b as Row)["orderNo"], 1),
          isActive: (b as Row)["isActive"] !== false,
          fixPattern: str((b as Row)["fixPattern"]),
          mustNotMatch: str((b as Row)["mustNotMatch"]),
        })),
    };
  });
  const round = (rounds ?? [])[0] as Row | undefined;
  return {
    round: round
      ? {
          id: str(round["id"]),
          name: str(round["name"]),
          state: str(round["state"]),
          maxMarks: num(round["maxMarks"]),
        }
      : null,
    problems: items,
    stats: {
      problems: items.length,
      activeProblems: items.filter((p) => p.isEnabled).length,
      bugs: items.reduce((s, p) => s + p.bugs.filter((b) => b.isActive).length, 0),
      submissions: (subs ?? []).length,
    },
  };
});

const debugProblemInput = z.object({
  id: z.string().min(1).optional(),
  roundId: z.string().min(1),
  title: z.string().trim().min(2).max(200),
  description: z.string().max(8000),
  language: z.string().trim().min(1).max(20).optional(),
  expectedBehavior: z.string().max(8000).optional(),
  buggyCode: z.string().trim().min(1, "Buggy code is required.").max(20_000),
  publicInput: z.string().max(20_000).optional(),
  publicExpectedOutput: z.string().max(20_000).optional(),
  marks: z.coerce.number().int().min(1).max(1000),
  baseMarks: z.coerce.number().int().min(0).max(1000).optional(),
  timeLimitSec: z.coerce.number().int().min(1).max(10).optional(),
  memoryLimitMb: z.coerce.number().int().min(8).max(512).optional(),
  orderNo: z.coerce.number().int().min(1).max(1000),
  isEnabled: z.boolean(),
});


export const saveDebugProblem = createServerFn({ method: "POST" })
  .inputValidator((input: z.infer<typeof debugProblemInput>) => debugProblemInput.parse(input))
  .handler(async ({ data }) => {
    const { requireAdmin } = await import("./app-session.server");
    const { newId, nowIso, ownDb, audit } = await import("./own-db.server");
    const claims = await requireAdmin();
    const db = ownDb();
    const now = nowIso();
    const { id, ...rest } = data;
    const fields = {
      ...rest,
      language: (rest.language ?? "C").toUpperCase(),
      expectedBehavior: rest.expectedBehavior ?? "",
      publicInput: rest.publicInput ?? "",
      publicExpectedOutput: rest.publicExpectedOutput ?? "",
      timeLimitSec: rest.timeLimitSec ?? 2,
      memoryLimitMb: rest.memoryLimitMb ?? 128,
      baseMarks: rest.baseMarks ?? 0,
    };

    // Server-side guard: base marks plus every enabled test case's marks must
    // fit inside the problem's maximum marks.
    if (fields.baseMarks > fields.marks)
      throw new Error("Base marks + test case marks cannot exceed maximum marks.");
    if (id) {
      const { data: existing } = await db
        .from("debug_test_cases")
        .select("marks, isEnabled")
        .eq("problemId", id);
      const configured = (existing ?? [])
        .filter((t) => (t as Row)["isEnabled"] !== false)
        .reduce((s, t) => s + Number((t as Row)["marks"] ?? 0), 0);
      if (fields.baseMarks + configured > fields.marks)
        throw new Error("Base marks + test case marks cannot exceed maximum marks.");
    }

    const problemId = id ?? newId();
    const result = id
      ? await db.from("debugging_problems").update({ ...fields, updatedAt: now }).eq("id", id)
      : await db
          .from("debugging_problems")
          .insert({ id: problemId, ...fields, createdAt: now, updatedAt: now });
    if (result.error) {
      console.error("[admin] debug problem save failed", result.error.message);
      throw new Error("Could not save the debugging problem.");
    }
    await audit({
      actorUserId: claims.sub,
      action: id ? "debug.problem.updated" : "debug.problem.created",
      entityType: "debugging_problems",
      entityId: problemId,
    });
    return { ok: true as const, id: problemId };
  });

/** Deactivates (never deletes) a debugging problem so history is preserved. */
export const setDebugProblemActive = createServerFn({ method: "POST" })
  .inputValidator((input: { id: string; isEnabled: boolean }) =>
    z.object({ id: z.string().min(1), isEnabled: z.boolean() }).parse(input),
  )
  .handler(async ({ data }) => {
    const { requireAdmin } = await import("./app-session.server");
    const { nowIso, ownDb } = await import("./own-db.server");
    await requireAdmin();
    const { error } = await ownDb()
      .from("debugging_problems")
      .update({ isEnabled: data.isEnabled, updatedAt: nowIso() })
      .eq("id", data.id);
    if (error) throw new Error("Could not update the debugging problem.");
    return { ok: true as const };
  });

/**
 * Deletes a Round 2 question. A question that already has submissions is
 * hidden instead of destroyed, so competition history is never lost.
 */
export const deleteDebugProblem = createServerFn({ method: "POST" })
  .inputValidator((input: { id: string }) => z.object({ id: z.string().min(1) }).parse(input))
  .handler(async ({ data }) => {
    const { requireAdmin } = await import("./app-session.server");
    const { nowIso, ownDb, audit } = await import("./own-db.server");
    const claims = await requireAdmin();
    const db = ownDb();
    const { count } = await db
      .from("debugging_submissions")
      .select("id", { count: "exact", head: true })
      .eq("problemId", data.id);
    if ((count ?? 0) > 0) {
      const { error } = await db
        .from("debugging_problems")
        .update({ isEnabled: false, updatedAt: nowIso() })
        .eq("id", data.id);
      if (error) throw new Error("Could not hide that question.");
      return { ok: true as const, deactivated: true };
    }
    await db.from("debug_test_cases").delete().eq("problemId", data.id);
    const { error } = await db.from("debugging_problems").delete().eq("id", data.id);
    if (error) throw new Error("Could not delete that question.");
    await audit({
      actorUserId: claims.sub,
      action: "debug.problem.deleted",
      entityType: "debugging_problems",
      entityId: data.id,
    });
    return { ok: true as const, deactivated: false };
  });

const debugTestInput = z.object({
  id: z.string().min(1).optional(),
  problemId: z.string().min(1),
  name: z.string().max(200).optional(),
  input: z.string().max(20_000),
  expectedOutput: z.string().max(20_000),
  // Round 2 test cases are hidden by definition.
  isHidden: z.boolean().optional(),
  isEnabled: z.boolean().optional(),
  marks: z.coerce.number().int().min(1).max(1000),
  orderNo: z.coerce.number().int().min(1).max(1000),
});

/** Creates or updates one Round 2 test case (visible or hidden). */
export const saveDebugTestCase = createServerFn({ method: "POST" })
  .inputValidator((input: z.infer<typeof debugTestInput>) => debugTestInput.parse(input))
  .handler(async ({ data }) => {
    const { requireAdmin } = await import("./app-session.server");
    const { newId, nowIso, ownDb } = await import("./own-db.server");
    await requireAdmin();
    const db = ownDb();
    const now = nowIso();
    const { id, ...rest } = data;
    const fields = {
      ...rest,
      name: rest.name ?? "",
      isEnabled: rest.isEnabled ?? true,
      isHidden: rest.isHidden ?? true,
    };
    const testId = id ?? newId();

    // Base marks + enabled test-case marks must fit inside the maximum marks.
    const [{ data: problem }, { data: siblings }] = await Promise.all([
      db.from("debugging_problems").select("marks, baseMarks").eq("id", fields.problemId).maybeSingle(),
      db.from("debug_test_cases").select("id, marks, isEnabled").eq("problemId", fields.problemId),
    ]);
    if (problem) {
      const maxMarks = Number((problem as Row)["marks"] ?? 0);
      const baseMarks = Number((problem as Row)["baseMarks"] ?? 0);
      const others = (siblings ?? [])
        .filter((t) => String((t as Row)["id"]) !== testId && (t as Row)["isEnabled"] !== false)
        .reduce((s, t) => s + Number((t as Row)["marks"] ?? 0), 0);
      const total = baseMarks + others + (fields.isEnabled ? fields.marks : 0);
      if (total > maxMarks)
        throw new Error("Base marks + test case marks cannot exceed maximum marks.");
    }

    const result = id
      ? await db.from("debug_test_cases").update({ ...fields, updatedAt: now }).eq("id", id)
      : await db
          .from("debug_test_cases")
          .insert({ id: testId, ...fields, createdAt: now, updatedAt: now });
    if (result.error) {
      console.error("[admin] debug test case save failed", result.error.message);
      throw new Error("Could not save the test case.");
    }
    return { ok: true as const, id: testId };
  });

export const deleteDebugTestCase = createServerFn({ method: "POST" })
  .inputValidator((input: { id: string }) => z.object({ id: z.string().min(1) }).parse(input))
  .handler(async ({ data }) => {
    const { requireAdmin } = await import("./app-session.server");
    const { ownDb } = await import("./own-db.server");
    await requireAdmin();
    const { error } = await ownDb().from("debug_test_cases").delete().eq("id", data.id);
    if (error) throw new Error("Could not delete the test case.");
    return { ok: true as const };
  });


const bugInput = z.object({
  id: z.string().min(1).optional(),
  problemId: z.string().min(1),
  bugCode: z.string().trim().min(1).max(40),
  title: z.string().trim().min(2).max(200),
  description: z.string().max(2000),
  marks: z.coerce.number().int().min(1).max(1000),
  orderNo: z.coerce.number().int().min(1).max(1000),
  isActive: z.boolean(),
  fixPattern: z.string().max(500).optional(),
  mustNotMatch: z.string().max(500).optional(),
});

export const saveBugDefinition = createServerFn({ method: "POST" })
  .inputValidator((input: z.infer<typeof bugInput>) => bugInput.parse(input))
  .handler(async ({ data }) => {
    const { requireAdmin } = await import("./app-session.server");
    const { newId, nowIso, ownDb } = await import("./own-db.server");
    await requireAdmin();
    const db = ownDb();

    if (!data.fixPattern && !data.mustNotMatch)
      throw new Error("Configure at least one validation pattern so this bug can be detected.");
    for (const pattern of [data.fixPattern, data.mustNotMatch]) {
      if (!pattern) continue;
      try {
        new RegExp(pattern, "m");
      } catch {
        throw new Error(`"${pattern}" is not a valid pattern.`);
      }
    }

    const now = nowIso();
    const { id, ...fields } = data;
    const bugId = id ?? newId();
    const row = {
      ...fields,
      fixPattern: data.fixPattern || null,
      mustNotMatch: data.mustNotMatch || null,
      updatedAt: now,
    };
    const result = id
      ? await db.from("bug_definitions").update(row).eq("id", id)
      : await db.from("bug_definitions").insert({ id: bugId, ...row, createdAt: now });
    if (result.error) {
      throw new Error(
        result.error.code === "23505"
          ? "That bug code already exists for this problem."
          : "Could not save the bug definition.",
      );
    }
    return { ok: true as const, id: bugId };
  });

export const deleteBugDefinition = createServerFn({ method: "POST" })
  .inputValidator((input: { id: string }) => z.object({ id: z.string().min(1) }).parse(input))
  .handler(async ({ data }) => {
    const { requireAdmin } = await import("./app-session.server");
    const { nowIso, ownDb } = await import("./own-db.server");
    await requireAdmin();
    const db = ownDb();
    const { count } = await db
      .from("bug_awards")
      .select("id", { count: "exact", head: true })
      .eq("bugDefinitionId", data.id);
    if ((count ?? 0) > 0) {
      // Competition history is never destroyed — the bug is deactivated instead.
      const { error } = await db
        .from("bug_definitions")
        .update({ isActive: false, updatedAt: nowIso() })
        .eq("id", data.id);
      if (error) throw new Error("Could not deactivate the bug definition.");
      return { ok: true as const, deactivated: true };
    }
    const { error } = await db.from("bug_definitions").delete().eq("id", data.id);
    if (error) throw new Error("Could not delete the bug definition.");
    return { ok: true as const, deactivated: false };
  });

/** Round 2 results table: one row per student, computed from stored data. */
export const getRound2Results = createServerFn({ method: "GET" }).handler(async () => {
  const { requireAdmin } = await import("./app-session.server");
  const { ownDb } = await import("./own-db.server");
  const { num, str } = await import("./comp.server");
  await requireAdmin();
  const db = ownDb();

  const { data: rounds } = await db.from("rounds").select("*").eq("type", "ROUND2").limit(1);
  const round = (rounds ?? [])[0] as Row | undefined;
  if (!round) return { round: null, totalBugs: 0, rows: [] };

  const roundId = str(round["id"]);
  const { data: problems } = await db
    .from("debugging_problems")
    .select("id")
    .eq("roundId", roundId)
    .eq("isEnabled", true);
  const problemIds = (problems ?? []).map((p) => str((p as Row)["id"]));

  const [{ data: students }, { data: batches }, { data: progress }, { data: scores }, { data: bugs }] =
    await Promise.all([
      db.from("students").select("id, userId, fullName, batchId"),
      db.from("batches").select("id, code, name"),
      db.from("round_progress").select("studentId, status, submittedAt").eq("roundId", roundId),
      db.from("round_scores").select("studentId, score").eq("roundId", roundId),
      problemIds.length
        ? db.from("bug_definitions").select("id, problemId, isActive").in("problemId", problemIds)
        : Promise.resolve({ data: [] as Row[] }),
    ]);
  const activeBugIds = (bugs ?? [])
    .filter((b) => (b as Row)["isActive"] !== false)
    .map((b) => str((b as Row)["id"]));
  // These two reads are independent — fetch them together instead of back to back.
  const [{ data: awards }, { data: users }] = await Promise.all([
    problemIds.length
      ? db.from("bug_awards").select("studentId, bugDefinitionId").in("problemId", problemIds)
      : Promise.resolve({ data: [] as Row[] }),
    db.from("users").select("id, studentId"),
  ]);

  const awardCount = new Map<string, number>();
  for (const a of awards ?? []) {
    const sid = str((a as Row)["studentId"]);
    awardCount.set(sid, (awardCount.get(sid) ?? 0) + 1);
  }

  const batchById = new Map((batches ?? []).map((b) => [str((b as Row)["id"]), b as Row]));
  const userById = new Map((users ?? []).map((u) => [str((u as Row)["id"]), u as Row]));
  const progressByStudent = new Map((progress ?? []).map((p) => [str((p as Row)["studentId"]), p as Row]));
  const scoreByStudent = new Map((scores ?? []).map((p) => [str((p as Row)["studentId"]), p as Row]));

  const rows = (students ?? []).map((s) => {
    const row = s as Row;
    const id = str(row["id"]);
    const batch = batchById.get(str(row["batchId"]));
    const user = userById.get(str(row["userId"]));
    const mine = progressByStudent.get(id);
    const score = scoreByStudent.get(id);
    return {
      studentId: id,
      name: str(row["fullName"]),
      code: str(user?.["studentId"]),
      batch: str(batch?.["code"], str(batch?.["name"])),
      score: num(score?.["score"]),
      maxMarks: num(round["maxMarks"]),
      status: str(mine?.["status"], "NOT_STARTED"),
      submittedAt: mine?.["submittedAt"] ? str(mine["submittedAt"]) : null,
      bugsFixed: awardCount.get(id) ?? 0,
    };
  });

  rows.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return {
    round: { id: roundId, name: str(round["name"]), state: str(round["state"]) },
    totalBugs: activeBugIds.length,
    rows,
  };
});

/** Per-student Round 2 inspection: bug awards and every submission. */
export const getStudentRound2Detail = createServerFn({ method: "POST" })
  .inputValidator((input: { studentId: string }) =>
    z.object({ studentId: z.string().min(1) }).parse(input),
  )
  .handler(async ({ data }) => {
    const { requireAdmin } = await import("./app-session.server");
    const { ownDb } = await import("./own-db.server");
    const { num, str } = await import("./comp.server");
    await requireAdmin();
    const db = ownDb();

    const { data: rounds } = await db.from("rounds").select("id").eq("type", "ROUND2").limit(1);
    const roundId = str((rounds ?? [])[0]?.["id"] ?? "");
    if (!roundId) return { bugs: [], submissions: [] };

    const { data: problems } = await db
      .from("debugging_problems")
      .select("id, title")
      .eq("roundId", roundId);
    const problemIds = (problems ?? []).map((p) => str((p as Row)["id"]));
    if (!problemIds.length) return { bugs: [], submissions: [] };

    const [{ data: defs }, { data: awards }, { data: subs }] = await Promise.all([
      db.from("bug_definitions").select("*").in("problemId", problemIds).order("orderNo"),
      db
        .from("bug_awards")
        .select("*")
        .eq("studentId", data.studentId)
        .in("problemId", problemIds),
      db
        .from("debugging_submissions")
        .select("id, problemId, score, message, isFinal, createdAt, sourceCode")
        .eq("studentId", data.studentId)
        .in("problemId", problemIds)
        .order("createdAt", { ascending: false })
        .limit(50),
    ]);

    const titleById = new Map(
      (problems ?? []).map((p) => [str((p as Row)["id"]), str((p as Row)["title"])]),
    );
    const titleOf = (pid: string) => titleById.get(pid) ?? "";
    const awardByBug = new Map(
      (awards ?? []).map((a) => [str((a as Row)["bugDefinitionId"]), a as Row]),
    );

    return {
      bugs: (defs ?? []).map((b) => {
        const bug = b as Row;
        const award = awardByBug.get(str(bug["id"]));
        return {
          id: str(bug["id"]),
          problem: titleOf(str(bug["problemId"])),
          bugCode: str(bug["bugCode"]),
          title: str(bug["title"]),
          marks: num(bug["marks"]),
          isActive: bug["isActive"] !== false,
          awarded: Boolean(award),
          marksAwarded: num(award?.["marksAwarded"]),
          awardedAt: award?.["createdAt"] ? str(award["createdAt"]) : null,
          submissionId: award ? str(award["submissionId"]) : null,
        };
      }),
      submissions: (subs ?? []).map((s) => ({
        id: str((s as Row)["id"]),
        problem: titleOf(str((s as Row)["problemId"])),
        score: num((s as Row)["score"]),
        message: str((s as Row)["message"]),
        isFinal: Boolean((s as Row)["isFinal"]),
        createdAt: str((s as Row)["createdAt"]),
        sourceCode: str((s as Row)["sourceCode"]).slice(0, 20_000),
      })),
    };
  });


/* ------------------------------------------------------------------ */
/* Round 3 — programming problems + test cases                         */
/* ------------------------------------------------------------------ */

export const listCodeProblems = createServerFn({ method: "GET" }).handler(async () => {
  const { requireAdmin } = await import("./app-session.server");
  const { ownDb } = await import("./own-db.server");
  const { num, str } = await import("./comp.server");
  await requireAdmin();
  const db = ownDb();
  const [{ data: problems }, { data: tests }, { data: subs }] = await Promise.all([
    db.from("programming_problems").select("*").order("orderNo"),
    db.from("test_cases").select("*").order("orderNo"),
    db.from("programming_submissions").select("problemId, status"),
  ]);
  return (problems ?? []).map((p) => {
    const row = p as Row;
    const id = str(row["id"]);
    const mine = (subs ?? []).filter((s) => str((s as Row)["problemId"]) === id);
    return {
      id,
      roundId: str(row["roundId"]),
      title: str(row["title"]),
      description: str(row["description"]),
      inputFormat: str(row["inputFormat"]),
      outputFormat: str(row["outputFormat"]),
      constraints: str(row["constraints"]),
      examples: str(row["examples"]),
      starterCode: str(row["starterCode"]),
      marks: num(row["marks"]),
      timeLimitSec: num(row["timeLimitSec"], 2),
      memoryLimitMb: num(row["memoryLimitMb"], 128),
      orderNo: num(row["orderNo"]),
      isEnabled: Boolean(row["isEnabled"]),
      submissions: mine.length,
      accepted: mine.filter((s) => str((s as Row)["status"]) === "ACCEPTED").length,
      tests: (tests ?? [])
        .filter((t) => str((t as Row)["problemId"]) === id)
        .map((t) => ({
          id: str((t as Row)["id"]),
          input: str((t as Row)["input"]),
          expectedOutput: str((t as Row)["expectedOutput"]),
          isHidden: Boolean((t as Row)["isHidden"]),
          marks: num((t as Row)["marks"], 1),
          orderNo: num((t as Row)["orderNo"], 1),
        })),
    };
  });
});

const codeProblemInput = z.object({
  id: z.string().min(1).optional(),
  roundId: z.string().min(1),
  title: z.string().trim().min(2).max(200),
  description: z.string().max(8000),
  inputFormat: z.string().max(2000),
  outputFormat: z.string().max(2000),
  constraints: z.string().max(2000),
  examples: z.string().max(4000),
  starterCode: z.string().max(20_000),
  marks: z.coerce.number().int().min(1).max(1000),
  timeLimitSec: z.coerce.number().int().min(1).max(10),
  memoryLimitMb: z.coerce.number().int().min(8).max(512),
  orderNo: z.coerce.number().int().min(1).max(1000),
  isEnabled: z.boolean(),
});

export const saveCodeProblem = createServerFn({ method: "POST" })
  .inputValidator((input: z.infer<typeof codeProblemInput>) => codeProblemInput.parse(input))
  .handler(async ({ data }) => {
    const { requireAdmin } = await import("./app-session.server");
    const { newId, nowIso, ownDb } = await import("./own-db.server");
    await requireAdmin();
    const db = ownDb();
    const now = nowIso();
    const { id, ...fields } = data;
    const problemId = id ?? newId();
    const result = id
      ? await db.from("programming_problems").update({ ...fields, updatedAt: now }).eq("id", id)
      : await db
          .from("programming_problems")
          .insert({ id: problemId, ...fields, createdAt: now, updatedAt: now });
    if (result.error) {
      console.error("[admin] problem save failed", result.error.message);
      throw new Error("Could not save the problem.");
    }
    return { ok: true as const, id: problemId };
  });

const testCaseInput = z.object({
  id: z.string().min(1).optional(),
  problemId: z.string().min(1),
  input: z.string().max(20_000),
  expectedOutput: z.string().max(20_000),
  isHidden: z.boolean(),
  marks: z.coerce.number().int().min(1).max(1000),
  orderNo: z.coerce.number().int().min(1).max(1000),
});

/**
 * Deletes a Round 3 problem. A problem that already has submissions is
 * disabled instead of destroyed, so competition history is never lost.
 */
export const deleteCodeProblem = createServerFn({ method: "POST" })
  .inputValidator((input: { id: string }) => z.object({ id: z.string().min(1) }).parse(input))
  .handler(async ({ data }) => {
    const { requireAdmin } = await import("./app-session.server");
    const { nowIso, ownDb, audit } = await import("./own-db.server");
    const claims = await requireAdmin();
    const db = ownDb();
    const { count } = await db
      .from("programming_submissions")
      .select("id", { count: "exact", head: true })
      .eq("problemId", data.id);
    if ((count ?? 0) > 0) {
      const { error } = await db
        .from("programming_problems")
        .update({ isEnabled: false, updatedAt: nowIso() })
        .eq("id", data.id);
      if (error) throw new Error("Could not hide that problem.");
      return { ok: true as const, deactivated: true };
    }
    await db.from("test_cases").delete().eq("problemId", data.id);
    const { error } = await db.from("programming_problems").delete().eq("id", data.id);
    if (error) throw new Error("Could not delete that problem.");
    await audit({
      actorUserId: claims.sub,
      action: "code.problem.deleted",
      entityType: "programming_problems",
      entityId: data.id,
    });
    return { ok: true as const, deactivated: false };
  });

export const saveTestCase = createServerFn({ method: "POST" })
  .inputValidator((input: z.infer<typeof testCaseInput>) => testCaseInput.parse(input))
  .handler(async ({ data }) => {
    const { requireAdmin } = await import("./app-session.server");
    const { newId, nowIso, ownDb } = await import("./own-db.server");
    await requireAdmin();
    const db = ownDb();
    const now = nowIso();
    const { id, ...fields } = data;
    const testId = id ?? newId();
    const result = id
      ? await db.from("test_cases").update({ ...fields, updatedAt: now }).eq("id", id)
      : await db.from("test_cases").insert({ id: testId, ...fields, createdAt: now, updatedAt: now });
    if (result.error) throw new Error("Could not save the test case.");
    return { ok: true as const, id: testId };
  });

export const deleteTestCase = createServerFn({ method: "POST" })
  .inputValidator((input: { id: string }) => z.object({ id: z.string().min(1) }).parse(input))
  .handler(async ({ data }) => {
    const { requireAdmin } = await import("./app-session.server");
    const { ownDb } = await import("./own-db.server");
    await requireAdmin();
    const { error } = await ownDb().from("test_cases").delete().eq("id", data.id);
    if (error) throw new Error("Could not delete the test case.");
    return { ok: true as const };
  });

/* ------------------------------------------------------------------ */
/* Submissions + results                                               */
/* ------------------------------------------------------------------ */

export const listSubmissions = createServerFn({ method: "POST" })
  .inputValidator((input: { kind?: "code" | "debug" }) =>
    z.object({ kind: z.enum(["code", "debug"]).optional() }).parse(input),
  )
  .handler(async ({ data }) => {
    const { requireAdmin } = await import("./app-session.server");
    const { ownDb } = await import("./own-db.server");
    const { num, str } = await import("./comp.server");
    await requireAdmin();
    const db = ownDb();
    const kind = data.kind ?? "code";

    const { data: students } = await db.from("students").select("id, fullName");
    // Index the lookup tables once: 300 submissions x N students was a linear
    // scan per row before, which dominated this endpoint's response time.
    const nameById = new Map(
      (students ?? []).map((s) => [str((s as Row)["id"]), str((s as Row)["fullName"], "Unknown")]),
    );
    const nameOf = (id: string) => nameById.get(id) ?? "Unknown";
    const titleMap = (rows: Row[] | null | undefined) =>
      new Map((rows ?? []).map((p) => [str(p["id"]), str(p["title"], "Problem")]));

    if (kind === "debug") {
      const [{ data: subs }, { data: problems }] = await Promise.all([
        db
          .from("debugging_submissions")
          .select("id, studentId, problemId, score, message, createdAt")
          .order("createdAt", { ascending: false })
          .limit(300),
        db.from("debugging_problems").select("id, title"),
      ]);
      const titles = titleMap(problems as Row[] | null);
      return (subs ?? []).map((s) => {
        const row = s as Row;
        return {
          id: str(row["id"]),
          student: nameOf(str(row["studentId"])),
          problem: titles.get(str(row["problemId"])) ?? "Problem",
          status: "EVALUATED",
          language: "—",
          score: num(row["score"]),
          passedTests: 0,
          totalTests: 0,
          message: str(row["message"]),
          createdAt: str(row["createdAt"]),
        };
      });
    }

    const [{ data: subs }, { data: problems }] = await Promise.all([
      db
        .from("programming_submissions")
        .select("id, studentId, problemId, language, status, score, passedTests, totalTests, createdAt")
        .order("createdAt", { ascending: false })
        .limit(300),
      db.from("programming_problems").select("id, title"),
    ]);
    const titles = titleMap(problems as Row[] | null);
    return (subs ?? []).map((s) => {
      const row = s as Row;
      return {
        id: str(row["id"]),
        student: nameOf(str(row["studentId"])),
        problem: titles.get(str(row["problemId"])) ?? "Problem",
        status: str(row["status"]),
        language: str(row["language"]),
        score: num(row["score"]),
        passedTests: num(row["passedTests"]),
        totalTests: num(row["totalTests"]),
        message: "",
        createdAt: str(row["createdAt"]),
      };
    });
  });

export const getLeaderboard = createServerFn({ method: "GET" }).handler(async () => {
  const { requireAdmin } = await import("./app-session.server");
  const { ownDb } = await import("./own-db.server");
  const { num, str } = await import("./comp.server");
  const { rebuildRanks } = await import("./scoring.server");
  await requireAdmin();
  await rebuildRanks();
  const db = ownDb();

  const [{ data: finals }, { data: students }, { data: users }, { data: rounds }, { data: scores }] =
    await Promise.all([
      db.from("final_scores").select("*").order("totalScore", { ascending: false }).limit(500),
      db.from("students").select("id, fullName, userId"),
      db.from("users").select("id, studentId"),
      db.from("rounds").select("id, name, orderNo").order("orderNo"),
      db.from("round_scores").select("studentId, roundId, score"),
    ]);

  // Index the joins once. With 500 finals x N students x M scores the old
  // per-row `.find()` scans dominated the response time.
  const studentById = new Map((students ?? []).map((s) => [str((s as Row)["id"]), s as Row]));
  const userById = new Map((users ?? []).map((u) => [str((u as Row)["id"]), u as Row]));
  const scoresByStudent = new Map<string, Record<string, number>>();
  for (const s of scores ?? []) {
    const row = s as Row;
    const key = str(row["studentId"]);
    const bucket = scoresByStudent.get(key) ?? {};
    bucket[str(row["roundId"])] = num(row["score"]);
    scoresByStudent.set(key, bucket);
  }

  return {
    rounds: (rounds ?? []).map((r) => ({ id: str((r as Row)["id"]), name: str((r as Row)["name"]) })),
    rows: (finals ?? []).map((f) => {
      const row = f as Row;
      const studentId = str(row["studentId"]);
      const student = studentById.get(studentId);
      const user = student ? userById.get(str(student["userId"])) : undefined;
      return {
        studentId,
        name: str(student?.["fullName"], "Unknown"),
        studentCode: str(user?.["studentId"], "—"),
        total: num(row["totalScore"]),
        max: num(row["maxScore"]),
        rank: (row["rank"] as number | null) ?? null,
        perRound: scoresByStudent.get(studentId) ?? {},
      };
    }),
  };
});

export const listViolations = createServerFn({ method: "GET" }).handler(async () => {
  const { requireAdmin } = await import("./app-session.server");
  const { ownDb } = await import("./own-db.server");
  const { str } = await import("./comp.server");
  await requireAdmin();
  const db = ownDb();
  const [{ data: violations }, { data: students }, { data: rounds }] = await Promise.all([
    db
      .from("violations")
      .select("id, studentId, roundId, type, details, createdAt")
      .order("createdAt", { ascending: false })
      .limit(300),
    db.from("students").select("id, fullName"),
    db.from("rounds").select("id, name"),
  ]);
  const studentName = new Map(
    (students ?? []).map((s) => [str((s as Row)["id"]), str((s as Row)["fullName"], "Unknown")]),
  );
  const roundName = new Map(
    (rounds ?? []).map((r) => [str((r as Row)["id"]), str((r as Row)["name"], "—")]),
  );
  return (violations ?? []).map((v) => {
    const row = v as Row;
    return {
      id: str(row["id"]),
      student: studentName.get(str(row["studentId"])) ?? "Unknown",
      round: roundName.get(str(row["roundId"])) ?? "—",
      type: str(row["type"]),
      details: str(row["details"]),
      createdAt: str(row["createdAt"]),
    };
  });
});
