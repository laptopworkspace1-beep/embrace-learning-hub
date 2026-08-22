/**
 * Admin control surface: users, rounds, event lifecycle, settings, audit log
 * and submission inspection. Every handler re-verifies the ADMIN role on the
 * server — hiding a button is never the authorization boundary.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { Row } from "./comp.server";

/* ------------------------------------------------------------------ */
/* Users                                                               */
/* ------------------------------------------------------------------ */

export const createStudent = createServerFn({ method: "POST" })
  .inputValidator(
    (input: {
      fullName: string;
      batchCode: string;
      studentCode?: string;
      password?: string;
      status: "ACTIVE" | "BLOCKED" | "WITHDRAWN";
    }) =>
      z
        .object({
          fullName: z.string().trim().min(2).max(120),
          batchCode: z.string().trim().min(1).max(20),
          studentCode: z.string().trim().max(40).optional(),
          password: z.string().min(6).max(128).optional(),
          status: z.enum(["ACTIVE", "BLOCKED", "WITHDRAWN"]),
        })
        .parse(input),
  )
  .handler(async ({ data }) => {
    const { requireAdmin, hashPassword } = await import("./app-session.server");
    const { audit, newId, nowIso, ownDb } = await import("./own-db.server");
    const { str } = await import("./comp.server");
    const claims = await requireAdmin();
    const db = ownDb();
    const now = nowIso();

    const username = data.studentCode?.trim() || data.batchCode;
    const { data: clash } = await db.from("users").select("id").eq("username", username).maybeSingle();
    if (clash) throw new Error("That student ID / batch number is already registered.");

    let batchId: string;
    const { data: batch } = await db.from("batches").select("id").eq("code", data.batchCode).maybeSingle();
    if (batch) {
      batchId = str(batch["id"]);
    } else {
      batchId = newId();
      const { error } = await db.from("batches").insert({
        id: batchId,
        code: data.batchCode,
        name: `Batch ${data.batchCode}`,
        createdAt: now,
        updatedAt: now,
      });
      if (error) throw new Error("Could not create that batch.");
    }

    const { getConfig } = await import("./app-config.server");
    const password = data.password ?? (await getConfig("DEFAULT_STUDENT_PASSWORD"));

    if (!password) throw new Error("No password supplied and no default student password is configured.");

    const userId = newId();
    const { error: userError } = await db.from("users").insert({
      id: userId,
      role: "STUDENT",
      username,
      studentId: data.studentCode?.trim() || null,
      passwordHash: await hashPassword(password),
      isActive: data.status === "ACTIVE",
      createdAt: now,
      updatedAt: now,
    });
    if (userError) throw new Error("Could not create the account.");

    const studentId = newId();
    const { error: studentError } = await db.from("students").insert({
      id: studentId,
      userId,
      fullName: data.fullName,
      batchId,
      status: data.status,
      createdAt: now,
      updatedAt: now,
    });
    if (studentError) {
      await db.from("users").delete().eq("id", userId);
      throw new Error("Could not create the student record.");
    }

    await audit({
      actorUserId: claims.sub,
      targetUserId: userId,
      action: "student.created",
      entityType: "students",
      entityId: studentId,
      metadata: { fullName: data.fullName, batchCode: data.batchCode },
    });
    return { ok: true as const, id: studentId };
  });

export const updateStudent = createServerFn({ method: "POST" })
  .inputValidator(
    (input: {
      studentId: string;
      fullName: string;
      batchCode: string;
      studentCode?: string;
      status: "ACTIVE" | "BLOCKED" | "WITHDRAWN";
      password?: string;
    }) =>
      z
        .object({
          studentId: z.string().min(1),
          fullName: z.string().trim().min(2).max(120),
          batchCode: z.string().trim().min(1).max(20),
          studentCode: z.string().trim().max(40).optional(),
          status: z.enum(["ACTIVE", "BLOCKED", "WITHDRAWN"]),
          password: z.string().min(6).max(128).optional(),
        })
        .parse(input),
  )
  .handler(async ({ data }) => {
    const { requireAdmin, hashPassword } = await import("./app-session.server");
    const { audit, newId, nowIso, ownDb } = await import("./own-db.server");
    const { str } = await import("./comp.server");
    const claims = await requireAdmin();
    const db = ownDb();
    const now = nowIso();

    const { data: student } = await db
      .from("students")
      .select("id, userId, batchId")
      .eq("id", data.studentId)
      .maybeSingle();
    if (!student) throw new Error("Student not found.");
    const userId = str((student as Row)["userId"]);

    let batchId = str((student as Row)["batchId"]);
    const { data: batch } = await db.from("batches").select("id").eq("code", data.batchCode).maybeSingle();
    if (batch) {
      batchId = str(batch["id"]);
    } else {
      batchId = newId();
      await db.from("batches").insert({
        id: batchId,
        code: data.batchCode,
        name: `Batch ${data.batchCode}`,
        createdAt: now,
        updatedAt: now,
      });
    }

    const { error } = await db
      .from("students")
      .update({ fullName: data.fullName, batchId, status: data.status, updatedAt: now })
      .eq("id", data.studentId);
    if (error) throw new Error("Could not save the student.");

    const userPatch: Record<string, unknown> = {
      studentId: data.studentCode?.trim() || null,
      isActive: data.status === "ACTIVE",
      updatedAt: now,
    };
    if (data.password) userPatch["passwordHash"] = await hashPassword(data.password);
    await db.from("users").update(userPatch).eq("id", userId);

    if (data.status !== "ACTIVE") {
      await db
        .from("sessions")
        .update({ isRevoked: true, revokedAt: now, updatedAt: now })
        .eq("userId", userId)
        .eq("isRevoked", false);
      (await import("./app-session.server")).invalidateSessionCache();
    }


    await audit({
      actorUserId: claims.sub,
      targetUserId: userId,
      action: data.password ? "student.password_changed" : "student.updated",
      entityType: "students",
      entityId: data.studentId,
      metadata: { fullName: data.fullName, status: data.status },
    });
    return { ok: true as const };
  });

/**
 * Removes a student. Competition records are never destroyed: if the student
 * has any stored answers, submissions, awards or scores the account is
 * withdrawn and disabled instead of deleted.
 */
export const deleteStudent = createServerFn({ method: "POST" })
  .inputValidator((input: { studentId: string }) =>
    z.object({ studentId: z.string().min(1) }).parse(input),
  )
  .handler(async ({ data }) => {
    const { requireAdmin } = await import("./app-session.server");
    const { audit, nowIso, ownDb } = await import("./own-db.server");
    const { str } = await import("./comp.server");
    const claims = await requireAdmin();
    const db = ownDb();
    const now = nowIso();

    const { data: student } = await db
      .from("students")
      .select("id, userId, fullName")
      .eq("id", data.studentId)
      .maybeSingle();
    if (!student) throw new Error("Student not found.");
    const userId = str((student as Row)["userId"]);

    const tables = [
      "student_answers",
      "programming_submissions",
      "debugging_submissions",
      "bug_awards",
      "round_progress",
      "round_scores",
      "final_scores",
      "violations",
    ];
    let hasData = false;
    for (const table of tables) {
      const { count } = await db
        .from(table)
        .select("id", { count: "exact", head: true })
        .eq("studentId", data.studentId);
      if ((count ?? 0) > 0) {
        hasData = true;
        break;
      }
    }

    await db
      .from("sessions")
      .update({ isRevoked: true, revokedAt: now, updatedAt: now })
      .eq("userId", userId)
      .eq("isRevoked", false);
    (await import("./app-session.server")).invalidateSessionCache();


    if (hasData) {
      await db
        .from("students")
        .update({ status: "WITHDRAWN", updatedAt: now })
        .eq("id", data.studentId);
      await db.from("users").update({ isActive: false, updatedAt: now }).eq("id", userId);
      await audit({
        actorUserId: claims.sub,
        targetUserId: userId,
        action: "student.withdrawn",
        entityType: "students",
        entityId: data.studentId,
      });
      return { ok: true as const, softDeleted: true };
    }

    await db.from("sessions").delete().eq("userId", userId);
    await db.from("students").delete().eq("id", data.studentId);
    await db.from("users").delete().eq("id", userId);
    await audit({
      actorUserId: claims.sub,
      action: "student.deleted",
      entityType: "students",
      entityId: data.studentId,
      metadata: { fullName: str((student as Row)["fullName"]) },
    });
    return { ok: true as const, softDeleted: false };
  });

/** Releases a student locked out by the violation limit. Deadlines are untouched. */
export const unlockStudent = createServerFn({ method: "POST" })
  .inputValidator((input: { studentId: string; roundId: string }) =>
    z.object({ studentId: z.string().min(1), roundId: z.string().min(1) }).parse(input),
  )
  .handler(async ({ data }) => {
    const { requireAdmin } = await import("./app-session.server");
    const { audit, nowIso, ownDb } = await import("./own-db.server");
    const claims = await requireAdmin();
    const now = nowIso();
    const { error } = await ownDb()
      .from("round_progress")
      .update({ status: "IN_PROGRESS", lockedAt: null, updatedAt: now })
      .eq("studentId", data.studentId)
      .eq("roundId", data.roundId)
      .eq("status", "LOCKED");
    if (error) throw new Error("Could not unlock this student.");
    await audit({
      actorUserId: claims.sub,
      action: "student.unlocked",
      entityType: "round_progress",
      entityId: data.studentId,
      metadata: { roundId: data.roundId },
    });
    return { ok: true as const };
  });

/* ------------------------------------------------------------------ */
/* Rounds — create, duplicate, reorder, delete                          */
/* ------------------------------------------------------------------ */

export const createRound = createServerFn({ method: "POST" })
  .inputValidator(
    (input: {
      name: string;
      type: "ROUND1" | "ROUND2" | "ROUND3";
      durationMinutes: number;
      maxMarks: number;
    }) =>
      z
        .object({
          name: z.string().trim().min(2).max(160),
          type: z.enum(["ROUND1", "ROUND2", "ROUND3"]),
          durationMinutes: z.coerce.number().int().min(1).max(600),
          maxMarks: z.coerce.number().int().min(1).max(10_000),
        })
        .parse(input),
  )
  .handler(async ({ data }) => {
    const { requireAdmin } = await import("./app-session.server");
    const { audit, newId, nowIso, ownDb } = await import("./own-db.server");
    const { num, str } = await import("./comp.server");
    const claims = await requireAdmin();
    const db = ownDb();

    const { data: event } = await db.from("events").select("id").order("createdAt").limit(1);
    const eventId = str((event?.[0] as Row | undefined)?.["id"]);
    if (!eventId) throw new Error("No event exists yet.");

    const { data: rounds } = await db.from("rounds").select("orderNo");
    const nextOrder = (rounds ?? []).reduce((max, r) => Math.max(max, num((r as Row)["orderNo"])), 0) + 1;

    const now = nowIso();
    const id = newId();
    const { error } = await db.from("rounds").insert({
      id,
      eventId,
      type: data.type,
      name: data.name,
      orderNo: nextOrder,
      state: "DRAFT",
      durationMinutes: data.durationMinutes,
      maxMarks: data.maxMarks,
      totalPausedSeconds: 0,
      createdAt: now,
      updatedAt: now,
    });
    if (error) {
      console.error("[admin] round insert failed", error.message);
      throw new Error("Could not create the round.");
    }
    await audit({
      actorUserId: claims.sub,
      action: "round.created",
      entityType: "rounds",
      entityId: id,
      metadata: { name: data.name, type: data.type },
    });
    return { ok: true as const, id };
  });

export const duplicateRound = createServerFn({ method: "POST" })
  .inputValidator((input: { roundId: string }) => z.object({ roundId: z.string().min(1) }).parse(input))
  .handler(async ({ data }) => {
    const { requireAdmin } = await import("./app-session.server");
    const { audit, newId, nowIso, ownDb } = await import("./own-db.server");
    const { num, str } = await import("./comp.server");
    const claims = await requireAdmin();
    const db = ownDb();

    const { data: found } = await db.from("rounds").select("*").eq("id", data.roundId).maybeSingle();
    if (!found) throw new Error("Round not found.");
    const round = found as Row;
    const { data: rounds } = await db.from("rounds").select("orderNo");
    const nextOrder = (rounds ?? []).reduce((max, r) => Math.max(max, num((r as Row)["orderNo"])), 0) + 1;

    const now = nowIso();
    const id = newId();
    const { error } = await db.from("rounds").insert({
      id,
      eventId: str(round["eventId"]),
      type: str(round["type"]),
      name: `${str(round["name"])} (copy)`,
      orderNo: nextOrder,
      state: "DRAFT",
      durationMinutes: num(round["durationMinutes"], 30),
      maxMarks: num(round["maxMarks"], 100),
      totalPausedSeconds: 0,
      createdAt: now,
      updatedAt: now,
    });
    if (error) throw new Error("Could not duplicate the round.");
    await audit({
      actorUserId: claims.sub,
      action: "round.duplicated",
      entityType: "rounds",
      entityId: id,
      metadata: { from: data.roundId },
    });
    return { ok: true as const, id };
  });

export const moveRound = createServerFn({ method: "POST" })
  .inputValidator((input: { roundId: string; direction: "up" | "down" }) =>
    z.object({ roundId: z.string().min(1), direction: z.enum(["up", "down"]) }).parse(input),
  )
  .handler(async ({ data }) => {
    const { requireAdmin } = await import("./app-session.server");
    const { audit, nowIso, ownDb } = await import("./own-db.server");
    const { num, str } = await import("./comp.server");
    const claims = await requireAdmin();
    const db = ownDb();
    const { data: rounds } = await db.from("rounds").select("id, orderNo").order("orderNo");
    const list = (rounds ?? []) as Row[];
    const index = list.findIndex((r) => str(r["id"]) === data.roundId);
    if (index < 0) throw new Error("Round not found.");
    const swapWith = data.direction === "up" ? index - 1 : index + 1;
    if (swapWith < 0 || swapWith >= list.length) return { ok: true as const };

    const a = list[index]!;
    const b = list[swapWith]!;
    const now = nowIso();
    await db.from("rounds").update({ orderNo: num(b["orderNo"]), updatedAt: now }).eq("id", str(a["id"]));
    await db.from("rounds").update({ orderNo: num(a["orderNo"]), updatedAt: now }).eq("id", str(b["id"]));
    await audit({
      actorUserId: claims.sub,
      action: "round.reordered",
      entityType: "rounds",
      entityId: data.roundId,
      metadata: { direction: data.direction },
    });
    return { ok: true as const };
  });

/** Deletes a round only when nothing has been recorded against it. */
export const deleteRound = createServerFn({ method: "POST" })
  .inputValidator((input: { roundId: string }) => z.object({ roundId: z.string().min(1) }).parse(input))
  .handler(async ({ data }) => {
    const { requireAdmin } = await import("./app-session.server");
    const { audit, ownDb } = await import("./own-db.server");
    const claims = await requireAdmin();
    const db = ownDb();

    for (const table of ["round_progress", "round_scores", "student_answers"]) {
      const { count } = await db
        .from(table)
        .select("id", { count: "exact", head: true })
        .eq("roundId", data.roundId);
      if ((count ?? 0) > 0)
        throw new Error("This round already has student data and cannot be deleted. Disable it instead.");
    }
    for (const table of ["questions", "debugging_problems", "programming_problems"]) {
      const { count } = await db
        .from(table)
        .select("id", { count: "exact", head: true })
        .eq("roundId", data.roundId);
      if ((count ?? 0) > 0)
        throw new Error("Remove the questions/problems in this round before deleting it.");
    }

    const { error } = await db.from("rounds").delete().eq("id", data.roundId);
    if (error) throw new Error("Could not delete the round.");
    await audit({
      actorUserId: claims.sub,
      action: "round.deleted",
      entityType: "rounds",
      entityId: data.roundId,
    });
    return { ok: true as const };
  });

/* ------------------------------------------------------------------ */
/* Event lifecycle + emergency pause                                    */
/* ------------------------------------------------------------------ */

export const getEventControl = createServerFn({ method: "GET" }).handler(async () => {
  const { requireAdmin } = await import("./app-session.server");
  const { ownDb } = await import("./own-db.server");
  const { num, str } = await import("./comp.server");
  const { parseLanguageList } = await import("./execution.server");
  await requireAdmin();
  const db = ownDb();
  const [{ data: events }, { data: rounds }, { data: settings }, { data: visibility }] = await Promise.all([
    db.from("events").select("*").order("createdAt").limit(1),
    db.from("rounds").select("*").order("orderNo"),
    db.from("event_settings").select("*").limit(1),
    db.from("visibility_settings").select("*").limit(1),
  ]);
  const event = (events?.[0] as Row | undefined) ?? null;
  const s = (settings?.[0] as Row | undefined) ?? null;
  const v = (visibility?.[0] as Row | undefined) ?? null;
  return {
    event: event
      ? { id: str(event["id"]), title: str(event["title"]), status: str(event["status"]) }
      : null,
    rounds: (rounds ?? []).map((r) => ({
      id: str((r as Row)["id"]),
      name: str((r as Row)["name"]),
      type: str((r as Row)["type"]),
      orderNo: num((r as Row)["orderNo"]),
      state: str((r as Row)["state"]),
      durationMinutes: num((r as Row)["durationMinutes"]),
      maxMarks: num((r as Row)["maxMarks"]),
      startTime: ((r as Row)["startTime"] as string | null) ?? null,
      endTime: ((r as Row)["endTime"] as string | null) ?? null,
    })),
    settings: s
      ? {
          id: str(s["id"]),
          sessionPolicy: str(s["sessionPolicy"]),
          fullscreenViolationLimit: num(s["fullscreenViolationLimit"], 3),
          autosaveDebounceMs: num(s["autosaveDebounceMs"], 1500),
          continuationPasswordSet: Boolean(str(s["continuationPassword"])),
          pistonBaseUrl: str(s["pistonBaseUrl"]),
          pistonEnabled: s["pistonEnabled"] === undefined ? true : Boolean(s["pistonEnabled"]),
          pistonTimeoutMs: num(s["pistonTimeoutMs"], 20_000),
          round3Languages: parseLanguageList(s["round3Languages"]),
        }
      : null,
    visibility: { showResults: Boolean(v?.["showResults"]), showAnswers: Boolean(v?.["showAnswers"]) },
  };
});

/**
 * Event-wide lifecycle. "emergency_pause" pauses every live round (freezing
 * their authoritative clocks) and "resume" gives back exactly the paused time,
 * so nobody gains or loses seconds.
 */
export const controlEvent = createServerFn({ method: "POST" })
  .inputValidator((input: { action: "start" | "emergency_pause" | "resume" | "end" }) =>
    z.object({ action: z.enum(["start", "emergency_pause", "resume", "end"]) }).parse(input),
  )
  .handler(async ({ data }) => {
    const { requireAdmin } = await import("./app-session.server");
    const { audit, nowIso, ownDb } = await import("./own-db.server");
    const { num, str } = await import("./comp.server");
    const claims = await requireAdmin();
    const db = ownDb();
    const now = new Date();
    const nowStr = now.toISOString();

    const { data: events } = await db.from("events").select("*").order("createdAt").limit(1);
    const event = (events?.[0] as Row | undefined) ?? null;
    if (!event) throw new Error("No event exists yet.");
    const eventId = str(event["id"]);

    if (data.action === "start") {
      await db.from("events").update({ status: "LIVE", updatedAt: nowStr }).eq("id", eventId);
    } else if (data.action === "emergency_pause") {
      const { data: live } = await db.from("rounds").select("id").eq("state", "LIVE");
      for (const r of live ?? []) {
        await db
          .from("rounds")
          .update({ state: "PAUSED", pausedAt: nowStr, updatedAt: nowStr })
          .eq("id", str((r as Row)["id"]));
      }
      await db.from("events").update({ status: "PAUSED", updatedAt: nowStr }).eq("id", eventId);
    } else if (data.action === "resume") {
      const { parseTs } = await import("./comp.server");
      const { data: paused } = await db.from("rounds").select("*").eq("state", "PAUSED");
      for (const row of (paused ?? []) as Row[]) {
        const pausedAtMs = parseTs(row["pausedAt"]) ?? now.getTime();
        const pausedSeconds = Math.max(0, Math.floor((now.getTime() - pausedAtMs) / 1000));
        const deadline = parseTs(row["deadlineAt"]);
        await db
          .from("rounds")
          .update({
            state: "LIVE",
            pausedAt: null,
            totalPausedSeconds: num(row["totalPausedSeconds"]) + pausedSeconds,
            ...(deadline ? { deadlineAt: new Date(deadline + pausedSeconds * 1000).toISOString() } : {}),
            updatedAt: nowStr,
          })
          .eq("id", str(row["id"]));
        const { data: attempts } = await db
          .from("round_progress")
          .select("id, endsAt")
          .eq("roundId", str(row["id"]))
          .eq("status", "IN_PROGRESS");
        for (const attempt of (attempts ?? []) as Row[]) {
          const endsAtMs = parseTs(attempt["endsAt"]);
          if (!endsAtMs) continue;
          const shifted = new Date(endsAtMs + pausedSeconds * 1000);
          await db
            .from("round_progress")
            .update({ endsAt: shifted.toISOString(), updatedAt: nowStr })
            .eq("id", str(attempt["id"]));
        }
      }
      await db.from("events").update({ status: "LIVE", updatedAt: nowStr }).eq("id", eventId);
    } else {
      const { data: openRounds } = await db.from("rounds").select("*").neq("state", "ENDED");
      const { recalcRoundScoresFor, rebuildRanks } = await import("./scoring.server");
      for (const row of (openRounds ?? []) as Row[]) {
        const { data: attempts } = await db
          .from("round_progress")
          .select("studentId")
          .eq("roundId", str(row["id"]))
          .eq("status", "IN_PROGRESS");
        await db
          .from("round_progress")
          .update({ status: "SUBMITTED", submittedAt: nowStr, updatedAt: nowStr })
          .eq("roundId", str(row["id"]))
          .eq("status", "IN_PROGRESS");
        await db
          .from("rounds")
          .update({ state: "ENDED", endTime: nowStr, pausedAt: null, deadlineAt: nowStr, updatedAt: nowStr })
          .eq("id", str(row["id"]));
        await recalcRoundScoresFor(
          ((attempts ?? []) as Row[]).map((attempt) => str(attempt["studentId"])),
          row,
        );
      }
      await rebuildRanks();

      await db.from("events").update({ status: "ENDED", updatedAt: nowStr }).eq("id", eventId);
    }

    await audit({
      actorUserId: claims.sub,
      action: `event.${data.action}`,
      entityType: "events",
      entityId: eventId,
    });
    return { ok: true as const };
  });

/* ------------------------------------------------------------------ */
/* Safe settings + admin credentials                                    */
/* ------------------------------------------------------------------ */

export const saveEventSettings = createServerFn({ method: "POST" })
  .inputValidator(
    (input: {
      title: string;
      fullscreenViolationLimit: number;
      autosaveDebounceMs: number;
      continuationPassword?: string;
    }) =>
      z
        .object({
          title: z.string().trim().min(2).max(160),
          fullscreenViolationLimit: z.coerce.number().int().min(1).max(20),
          autosaveDebounceMs: z.coerce.number().int().min(300).max(30_000),
          continuationPassword: z.string().min(4).max(128).optional(),
        })
        .parse(input),
  )
  .handler(async ({ data }) => {
    const { requireAdmin } = await import("./app-session.server");
    const { audit, nowIso, ownDb } = await import("./own-db.server");
    const { str } = await import("./comp.server");
    const claims = await requireAdmin();
    const db = ownDb();
    const now = nowIso();

    const { data: events } = await db.from("events").select("id").order("createdAt").limit(1);
    const eventId = str((events?.[0] as Row | undefined)?.["id"]);
    if (!eventId) throw new Error("No event exists yet.");
    await db.from("events").update({ title: data.title, updatedAt: now }).eq("id", eventId);

    const { data: settings } = await db.from("event_settings").select("id").limit(1);
    const settingsId = str((settings?.[0] as Row | undefined)?.["id"]);
    if (settingsId) {
      const patch: Record<string, unknown> = {
        fullscreenViolationLimit: data.fullscreenViolationLimit,
        autosaveDebounceMs: data.autosaveDebounceMs,
        updatedAt: now,
      };
      if (data.continuationPassword) patch["continuationPassword"] = data.continuationPassword;
      const { error } = await db.from("event_settings").update(patch).eq("id", settingsId);
      if (error) throw new Error("Could not save the settings.");
    }

    await audit({
      actorUserId: claims.sub,
      action: "settings.updated",
      entityType: "event_settings",
      entityId: settingsId,
      metadata: { title: data.title, violationLimit: data.fullscreenViolationLimit },
    });
    return { ok: true as const };
  });

/** Changes the signed-in administrator's own username and/or password. */
export const updateAdminCredentials = createServerFn({ method: "POST" })
  .inputValidator((input: { username?: string; currentPassword: string; newPassword?: string }) =>
    z
      .object({
        username: z.string().trim().min(3).max(120).optional(),
        currentPassword: z.string().min(1).max(128),
        newPassword: z.string().min(6).max(128).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const { requireAdmin, verifyPassword, hashPassword } = await import("./app-session.server");
    const { audit, nowIso, ownDb } = await import("./own-db.server");
    const { str } = await import("./comp.server");
    const claims = await requireAdmin();
    const db = ownDb();

    const { data: user } = await db
      .from("users")
      .select("id, passwordHash")
      .eq("id", claims.sub)
      .maybeSingle();
    if (!user) throw new Error("Account not found.");
    const ok = await verifyPassword(data.currentPassword, str((user as Row)["passwordHash"]));
    if (!ok) throw new Error("Your current password is incorrect.");

    const patch: Record<string, unknown> = { updatedAt: nowIso() };
    if (data.username) {
      const { data: clash } = await db
        .from("users")
        .select("id")
        .eq("username", data.username)
        .maybeSingle();
      if (clash && str(clash["id"]) !== claims.sub) throw new Error("That username is already taken.");
      patch["username"] = data.username;
    }
    if (data.newPassword) patch["passwordHash"] = await hashPassword(data.newPassword);

    const { error } = await db.from("users").update(patch).eq("id", claims.sub);
    if (error) throw new Error("Could not update your credentials.");
    await audit({
      actorUserId: claims.sub,
      action: "admin.credentials_updated",
      entityType: "users",
      entityId: claims.sub,
      metadata: { usernameChanged: Boolean(data.username), passwordChanged: Boolean(data.newPassword) },
    });
    return { ok: true as const };
  });

/* ------------------------------------------------------------------ */
/* Audit log + submission inspection                                    */
/* ------------------------------------------------------------------ */

export const listAuditLogs = createServerFn({ method: "POST" })
  .inputValidator((input: { search?: string }) =>
    z.object({ search: z.string().max(120).optional() }).parse(input),
  )
  .handler(async ({ data }) => {
    const { requireAdmin } = await import("./app-session.server");
    const { ownDb } = await import("./own-db.server");
    const { str } = await import("./comp.server");
    await requireAdmin();
    const db = ownDb();
    const [{ data: logs }, { data: users }, { data: students }] = await Promise.all([
      db.from("audit_logs").select("*").order("createdAt", { ascending: false }).limit(500),
      db.from("users").select("id, username, role"),
      db.from("students").select("id, fullName, userId"),
    ]);
    const nameOf = (userId: string) => {
      const user = (users ?? []).find((u) => str((u as Row)["id"]) === userId) as Row | undefined;
      if (!user) return "system";
      if (str(user["role"]) === "ADMIN") return `admin:${str(user["username"], "admin")}`;
      const student = (students ?? []).find((s) => str((s as Row)["userId"]) === userId) as Row | undefined;
      return str(student?.["fullName"], str(user["username"], "student"));
    };
    const rows = (logs ?? []).map((l) => {
      const row = l as Row;
      return {
        id: str(row["id"]),
        actor: nameOf(str(row["actorUserId"])),
        action: str(row["action"]),
        entityType: str(row["entityType"]),
        entityId: str(row["entityId"]),
        metadata: JSON.stringify(row["metadata"] ?? {}),
        createdAt: str(row["createdAt"]),
      };
    });
    const term = (data.search ?? "").trim().toLowerCase();
    return term
      ? rows.filter(
          (r) =>
            r.action.toLowerCase().includes(term) ||
            r.actor.toLowerCase().includes(term) ||
            r.entityType.toLowerCase().includes(term),
        )
      : rows;
  });

/** Full inspection payload for one submission (admin only). */
export const getSubmissionDetail = createServerFn({ method: "POST" })
  .inputValidator((input: { kind: "code" | "debug"; id: string }) =>
    z.object({ kind: z.enum(["code", "debug"]), id: z.string().min(1) }).parse(input),
  )
  .handler(async ({ data }) => {
    const { requireAdmin } = await import("./app-session.server");
    const { ownDb } = await import("./own-db.server");
    const { num, str } = await import("./comp.server");
    await requireAdmin();
    const db = ownDb();

    const table = data.kind === "code" ? "programming_submissions" : "debugging_submissions";
    const { data: found } = await db.from(table).select("*").eq("id", data.id).maybeSingle();
    if (!found) throw new Error("Submission not found.");
    const row = found as Row;

    const { data: student } = await db
      .from("students")
      .select("id, fullName, userId")
      .eq("id", str(row["studentId"]))
      .maybeSingle();
    const { data: user } = student
      ? await db
          .from("users")
          .select("studentId, username")
          .eq("id", str((student as Row)["userId"]))
          .maybeSingle()
      : { data: null };

    const problemTable = data.kind === "code" ? "programming_problems" : "debugging_problems";
    const { data: problem } = await db
      .from(problemTable)
      .select("*")
      .eq("id", str(row["problemId"]))
      .maybeSingle();

    return {
      id: str(row["id"]),
      kind: data.kind,
      studentName: str((student as Row | null)?.["fullName"], "Unknown"),
      studentCode: str((user as Row | null)?.["studentId"] ?? (user as Row | null)?.["username"], "—"),
      problemTitle: str((problem as Row | null)?.["title"], "Problem"),
      maxMarks: num((problem as Row | null)?.["marks"]),
      language: str(row["language"], "c"),
      status: str(row["status"], "EVALUATED"),
      score: num(row["score"]),
      passedTests: num(row["passedTests"]),
      totalTests: num(row["totalTests"]),
      executionMs: num(row["executionMs"]),
      message: str(row["message"]),
      isFinal: Boolean(row["isFinal"]),
      sourceCode: str(row["sourceCode"]),
      result: JSON.stringify(row["resultJson"] ?? {}, null, 2),
      // Round 2 scoring breakdown (base marks + per-test-case marks). Admin/HOD
      // view, so hidden test details may be disclosed here.
      breakdown:
        data.kind === "debug"
          ? ((row["resultJson"] ?? null) as {
              maxMarks: number;
              baseMarks: number;
              baseScore: number;
              basePassed: boolean;
              testCaseScore: number;
              totalScore: number;
              testCases: {
                testCaseId: string;
                name: string;
                hidden: boolean;
                status: string;
                marks: number;
                marksAwarded: number;
                durationMs: number;
              }[];
            } | null)
          : null,
      submittedAt: str(row["submittedAt"] ?? row["createdAt"]),
    };
  });

/** Round 1 answer sheet for one student, with the correct answers (admin only). */
export const getStudentRound1Detail = createServerFn({ method: "POST" })
  .inputValidator((input: { studentId: string; roundId: string }) =>
    z.object({ studentId: z.string().min(1), roundId: z.string().min(1) }).parse(input),
  )
  .handler(async ({ data }) => {
    const { requireAdmin } = await import("./app-session.server");
    const { ownDb } = await import("./own-db.server");
    const { num, str } = await import("./comp.server");
    await requireAdmin();
    const db = ownDb();
    const [{ data: questions }, { data: answers }, { data: student }] = await Promise.all([
      db.from("questions").select("*").eq("roundId", data.roundId).order("orderNo"),
      db
        .from("student_answers")
        .select("*")
        .eq("roundId", data.roundId)
        .eq("studentId", data.studentId),
      db.from("students").select("fullName").eq("id", data.studentId).maybeSingle(),
    ]);
    return {
      studentName: str((student as Row | null)?.["fullName"], "Unknown"),
      rows: (questions ?? []).map((q) => {
        const row = q as Row;
        const mine = (answers ?? []).find((a) => str((a as Row)["questionId"]) === str(row["id"])) as
          | Row
          | undefined;
        return {
          id: str(row["id"]),
          prompt: str(row["prompt"]),
          type: str(row["type"]),
          correct: str(row["correctOptionKey"] ?? row["expectedOutput"]),
          given: str(mine?.["selectedOptionKey"] ?? mine?.["answerText"], "—"),
          marks: num(row["marks"]),
          awarded: num(mine?.["awardedMarks"]),
        };
      }),
    };
  });

/**
 * Execution engine controls. The base URL is stored server-side in
 * event_settings and only ever used by the backend; participant code always
 * runs there, never in the browser.
 */
export const savePistonSettings = createServerFn({ method: "POST" })
  .inputValidator((input: { baseUrl: string; enabled: boolean; timeoutMs: number }) =>
    z
      .object({
        baseUrl: z.string().trim().max(500),
        enabled: z.boolean(),
        timeoutMs: z.coerce.number().int().min(2_000).max(60_000),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const { requireAdmin } = await import("./app-session.server");
    const { audit, newId, nowIso, ownDb } = await import("./own-db.server");
    const { str } = await import("./comp.server");
    const { invalidateExecutionConfig, normalizeBaseUrl, resolveBaseUrl } = await import(
      "./execution.server"
    );
    const claims = await requireAdmin();

    const trimmed = data.baseUrl.trim();
    let baseUrl = "";
    if (trimmed) {
      const resolved = resolveBaseUrl(trimmed);
      if (!resolved.baseUrl) {
        throw new Error("Enter a valid http(s) Piston Base URL, for example https://my-piston-host.");
      }
      baseUrl = normalizeBaseUrl(resolved.baseUrl);
    }

    const db = ownDb();
    const now = nowIso();
    const { data: settings } = await db.from("event_settings").select("id").limit(1);
    let settingsId = str((settings?.[0] as Row | undefined)?.["id"]);
    const patch = {
      pistonBaseUrl: baseUrl,
      pistonEnabled: data.enabled,
      pistonTimeoutMs: data.timeoutMs,
      updatedAt: now,
    };
    if (settingsId) {
      const { error } = await db.from("event_settings").update(patch).eq("id", settingsId);
      if (error) throw new Error("Could not save the execution engine settings.");
    } else {
      settingsId = newId();
      const { error } = await db
        .from("event_settings")
        .insert({ id: settingsId, createdAt: now, ...patch });
      if (error) throw new Error("Could not save the execution engine settings.");
    }

    invalidateExecutionConfig();
    await audit({
      actorUserId: claims.sub,
      action: "execution.settings.updated",
      entityType: "event_settings",
      entityId: settingsId,
      metadata: { baseUrl, enabled: data.enabled, timeoutMs: data.timeoutMs },
    });
    return { ok: true as const, baseUrl };
  });

/**
 * Health check. Tests the URL the administrator currently has in the input
 * (when supplied) so it can be verified before saving; otherwise the saved one.
 */
export const testPistonConnection = createServerFn({ method: "POST" })
  .inputValidator((input?: { baseUrl?: string }) =>
    z.object({ baseUrl: z.string().trim().max(500).optional() }).partial().parse(input ?? {}),
  )
  .handler(async ({ data }) => {
    const { requireAdmin } = await import("./app-session.server");
    const { testConnection } = await import("./execution.server");
    await requireAdmin();
    const result = await testConnection(data?.baseUrl);
    const languages = result.runtimes.map((r) => `${r.language} ${r.version}`);
    return {
      connected: result.connected,
      runtimeCount: result.runtimes.length,
      languages,
      cRuntimeAvailable: result.cRuntimeAvailable,
      ...(result.cRuntimeVersion ? { cRuntimeVersion: result.cRuntimeVersion } : {}),
      executionVerified: result.executionVerified,
      testedAt: new Date().toISOString(),
      ...(result.hint ? { hint: result.hint } : {}),
      ...(result.detail ? { detail: result.detail } : {}),
      ...(result.error ? { error: result.error } : {}),
    };
  });

/* ------------------------------------------------------------------ */
/* Round 3 language availability                                        */
/* ------------------------------------------------------------------ */

/**
 * Sets the languages students may choose in Round 3. The stored list is the
 * only authority — the server re-checks it on every compile, run and submit.
 */
export const saveRound3Languages = createServerFn({ method: "POST" })
  .inputValidator((input: { languages: string[] }) =>
    z
      .object({
        languages: z
          .array(z.enum(["C", "CPP", "JAVA", "PYTHON", "JAVASCRIPT"]))
          .min(1, "Enable at least one language."),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const { requireAdmin } = await import("./app-session.server");
    const { audit, newId, nowIso, ownDb } = await import("./own-db.server");
    const { str } = await import("./comp.server");
    const { invalidateExecutionConfig, parseLanguageList } = await import("./execution.server");
    const claims = await requireAdmin();
    const db = ownDb();
    const now = nowIso();
    const languages = parseLanguageList(data.languages);

    const { data: settings } = await db.from("event_settings").select("id").limit(1);
    let settingsId = str((settings?.[0] as Row | undefined)?.["id"]);
    const patch = { round3Languages: JSON.stringify(languages), updatedAt: now };
    if (settingsId) {
      const { error } = await db.from("event_settings").update(patch).eq("id", settingsId);
      if (error) throw new Error("Could not save the Round 3 languages.");
    } else {
      settingsId = newId();
      const { error } = await db.from("event_settings").insert({ id: settingsId, createdAt: now, ...patch });
      if (error) throw new Error("Could not save the Round 3 languages.");
    }

    invalidateExecutionConfig();
    await audit({
      actorUserId: claims.sub,
      action: "round3.languages.updated",
      entityType: "event_settings",
      entityId: settingsId,
      metadata: { languages },
    });
    return { ok: true as const, languages };
  });

/* ------------------------------------------------------------------ */
/* Per-student round state: inspect, reset                              */
/* ------------------------------------------------------------------ */

/** Round-by-round state for one student, used by the admin reset dialog. */
export const getStudentRoundState = createServerFn({ method: "POST" })
  .inputValidator((input: { studentId: string }) =>
    z.object({ studentId: z.string().min(1) }).parse(input),
  )
  .handler(async ({ data }) => {
    const { requireAdmin } = await import("./app-session.server");
    const { ownDb } = await import("./own-db.server");
    const { num, str } = await import("./comp.server");
    await requireAdmin();
    const db = ownDb();
    const [{ data: rounds }, { data: progress }, { data: scores }] = await Promise.all([
      db.from("rounds").select("id, name, type, orderNo, state").order("orderNo"),
      db.from("round_progress").select("*").eq("studentId", data.studentId),
      db.from("round_scores").select("roundId, score").eq("studentId", data.studentId),
    ]);
    return {
      rounds: (rounds ?? []).map((r) => {
        const round = r as Row;
        const id = str(round["id"]);
        const p = (progress ?? []).find((x) => str((x as Row)["roundId"]) === id) as Row | undefined;
        const sc = (scores ?? []).find((x) => str((x as Row)["roundId"]) === id) as Row | undefined;
        return {
          id,
          name: str(round["name"]),
          type: str(round["type"]),
          orderNo: num(round["orderNo"]),
          roundState: str(round["state"]),
          status: str(p?.["status"], "NOT_STARTED"),
          submittedAt: (p?.["submittedAt"] as string | null) ?? null,
          score: num(sc?.["score"]),
        };
      }),
    };
  });

/**
 * Reopens exactly one round for exactly one student. Nothing outside that
 * student + round pair is touched: other rounds, other students, the event
 * configuration and the question bank are all left alone. Submission history
 * is preserved for audit; only the state that blocks a fresh attempt is reset.
 */
export const resetStudentRound = createServerFn({ method: "POST" })
  .inputValidator((input: { studentId: string; roundId: string; clearScore?: boolean }) =>
    z
      .object({
        studentId: z.string().min(1),
        roundId: z.string().min(1),
        clearScore: z.boolean().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const { requireAdmin } = await import("./app-session.server");
    const { audit, nowIso, ownDb } = await import("./own-db.server");
    const { getRound, str } = await import("./comp.server");
    const { recalcRoundScore } = await import("./scoring.server");
    const claims = await requireAdmin();
    const db = ownDb();
    const now = nowIso();

    const round = await getRound(data.roundId);
    if (!round) throw new Error("Round not found.");
    const { data: student } = await db
      .from("students")
      .select("id, fullName")
      .eq("id", data.studentId)
      .maybeSingle();
    if (!student) throw new Error("Student not found.");

    // 1. Reopen the attempt itself (the only thing that gates entry/submission).
    const { data: progress } = await db
      .from("round_progress")
      .select("id")
      .eq("studentId", data.studentId)
      .eq("roundId", data.roundId)
      .maybeSingle();
    if (progress) {
      const { error } = await db
        .from("round_progress")
        .delete()
        .eq("id", str((progress as Row)["id"]));
      if (error) throw new Error("Could not reset this round.");
    }

    // 2. Clear proctoring locks recorded for this round only.
    await db.from("violations").delete().eq("studentId", data.studentId).eq("roundId", data.roundId);

    // 3. Optionally clear the round's marks so the student starts from zero.
    let clearedScore = false;
    if (data.clearScore) {
      const type = str(round["type"]);
      if (type === "ROUND1") {
        await db
          .from("student_answers")
          .delete()
          .eq("studentId", data.studentId)
          .eq("roundId", data.roundId);
      } else if (type === "ROUND2") {
        const { data: problems } = await db
          .from("debugging_problems")
          .select("id")
          .eq("roundId", data.roundId);
        const ids = (problems ?? []).map((p) => str((p as Row)["id"]));
        if (ids.length) {
          await db.from("bug_awards").delete().eq("studentId", data.studentId).in("problemId", ids);
        }
      } else {
        const { data: problems } = await db
          .from("programming_problems")
          .select("id")
          .eq("roundId", data.roundId);
        const ids = (problems ?? []).map((p) => str((p as Row)["id"]));
        if (ids.length) {
          // History stays; only the marks stop counting towards the leaderboard.
          await db
            .from("programming_submissions")
            .update({ score: 0, isFinal: false, updatedAt: now })
            .eq("studentId", data.studentId)
            .in("problemId", ids);
        }
      }
      clearedScore = true;
    }

    // 4. Recompute this round's score and the student's total from stored data.
    await recalcRoundScore(data.studentId, round);

    await audit({
      actorUserId: claims.sub,
      action: "round.reset",
      entityType: "round_progress",
      entityId: data.studentId,
      metadata: {
        roundId: data.roundId,
        roundName: str(round["name"]),
        student: str((student as Row)["fullName"]),
        clearedScore,
      },
    });
    return { ok: true as const, clearedScore };
  });

/**
 * Permanent account deletion. Distinct from Withdraw, which keeps the account
 * and its history. Dependent rows are removed explicitly, oldest dependency
 * first, so no orphan records or broken references are left behind. Only this
 * student's data is touched.
 */
export const purgeStudent = createServerFn({ method: "POST" })
  .inputValidator((input: { studentId: string }) =>
    z.object({ studentId: z.string().min(1) }).parse(input),
  )
  .handler(async ({ data }) => {
    const { requireAdmin } = await import("./app-session.server");
    const { audit, nowIso, ownDb } = await import("./own-db.server");
    const { str } = await import("./comp.server");
    const claims = await requireAdmin();
    const db = ownDb();

    const { data: student } = await db
      .from("students")
      .select("id, userId, fullName, studentCode")
      .eq("id", data.studentId)
      .maybeSingle();
    if (!student) throw new Error("Student not found.");
    const userId = str((student as Row)["userId"]);

    const dependents = [
      "bug_awards",
      "debugging_submissions",
      "programming_submissions",
      "student_answers",
      "code_attempts",
      "violations",
      "round_progress",
      "round_scores",
      "final_scores",
    ];
    for (const table of dependents) {
      const { error } = await db.from(table).delete().eq("studentId", data.studentId);
      if (error) console.error(`[purge] ${table} cleanup failed`, error.message);
    }

    await db.from("sessions").delete().eq("studentId", data.studentId);
    if (userId) await db.from("sessions").delete().eq("userId", userId);
    (await import("./app-session.server")).invalidateSessionCache();

    const { error: studentError } = await db.from("students").delete().eq("id", data.studentId);
    if (studentError) throw new Error("Could not delete this student.");
    if (userId) await db.from("users").delete().eq("id", userId);

    await audit({
      actorUserId: claims.sub,
      action: "student.purged",
      entityType: "students",
      entityId: data.studentId,
      metadata: {
        fullName: str((student as Row)["fullName"]),
        studentCode: str((student as Row)["studentCode"]),
        at: nowIso(),
      },
    });
    return { ok: true as const };
  });
