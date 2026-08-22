/**
 * Competition engine — server-only authority for rounds, gating and timers.
 * Every value here comes from the event database; nothing is trusted from the client.
 */
import { newId, nowIso, ownDb } from "./own-db.server";

export type Row = Record<string, unknown>;

export type RoundStateName = "DRAFT" | "READY" | "LIVE" | "PAUSED" | "ENDED";

export type Gate = {
  open: boolean;
  state: RoundStateName;
  reason: string;
};

export const str = (v: unknown, fallback = ""): string => (v == null ? fallback : String(v));
export const num = (v: unknown, fallback = 0): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

/** The single active event (this platform runs one event at a time). */
export async function getEvent(): Promise<Row | null> {
  const { data } = await ownDb()
    .from("events")
    .select("*")
    .order("createdAt", { ascending: true })
    .limit(1);
  return (data?.[0] as Row | undefined) ?? null;
}

export async function listRounds(): Promise<Row[]> {
  const { data } = await ownDb().from("rounds").select("*").order("orderNo", { ascending: true });
  return (data ?? []) as Row[];
}

export async function getRound(roundId: string): Promise<Row | null> {
  const { data } = await ownDb().from("rounds").select("*").eq("id", roundId).maybeSingle();
  return (data as Row | null) ?? null;
}

export function roundGate(round: Row): Gate {
  const state = str(round["state"], "DRAFT") as RoundStateName;
  if (state === "LIVE") return { open: true, state, reason: "" };
  if (state === "PAUSED")
    return { open: false, state, reason: "This round is paused by the organisers. Stay on this page." };
  if (state === "ENDED") return { open: false, state, reason: "This round has ended." };
  return { open: false, state, reason: "This round has not started yet." };
}

/** Progress row for one student in one round, created on first legitimate entry. */
export async function ensureProgress(studentId: string, round: Row): Promise<Row> {
  const db = ownDb();
  const roundId = str(round["id"]);
  const { data: existing } = await db
    .from("round_progress")
    .select("*")
    .eq("studentId", studentId)
    .eq("roundId", roundId)
    .maybeSingle();
  if (existing) return existing as Row;

  const now = new Date();
  // The attempt inherits the round's universal deadline: joining late never
  // grants extra time and every student counts down to the same instant.
  const deadline = roundDeadlineMs(round);
  const endsAt = new Date(deadline ?? now.getTime() + num(round["durationMinutes"], 30) * 60_000);

  const row = {
    id: newId(),
    studentId,
    roundId,
    status: "IN_PROGRESS",
    savedData: {},
    startedAt: now.toISOString(),
    endsAt: endsAt.toISOString(),
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  const { data: created, error } = await db.from("round_progress").insert(row).select("*").single();
  if (error) {
    // A concurrent request may have created it first — re-read instead of failing.
    const { data: again } = await db
      .from("round_progress")
      .select("*")
      .eq("studentId", studentId)
      .eq("roundId", roundId)
      .maybeSingle();
    if (again) return again as Row;
    console.error("[comp] progress insert failed", error.message);
    throw new Error("Could not start this round. Please try again.");
  }
  return created as Row;
}

/**
 * Parses a database timestamp. The columns are `timestamp without time zone`
 * holding UTC wall-clock values, so a missing offset must be read as UTC and
 * never as the reader's local time.
 */
export function parseTs(value: unknown): number | null {
  if (!value) return null;
  const raw = str(value);
  const withZone = /[Zz]|[+-]\d{2}:?\d{2}$/.test(raw) ? raw : `${raw}Z`;
  const ms = new Date(withZone).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The single universal deadline for a round. Every student and the admin read
 * this same value — there is never a per-student clock.
 */
export function roundDeadlineMs(round: Row): number | null {
  const stored = parseTs(round["deadlineAt"]);
  if (stored) return stored;
  const started = parseTs(round["startTime"]);
  if (!started) return null;
  return started + num(round["durationMinutes"], 0) * 60_000 + num(round["totalPausedSeconds"]) * 1000;
}

export function roundDeadlineIso(round: Row): string | null {
  const ms = roundDeadlineMs(round);
  return ms ? new Date(ms).toISOString() : null;
}

/** Server-authoritative seconds left on the round clock. Frozen while paused. */
export function roundRemainingSeconds(round: Row): number {
  const state = str(round["state"]);
  if (state === "ENDED") return 0;
  const deadline = roundDeadlineMs(round);
  if (!deadline) return num(round["durationMinutes"], 0) * 60;
  const pausedAt = parseTs(round["pausedAt"]);
  const reference = state === "PAUSED" && pausedAt ? pausedAt : Date.now();
  return Math.max(0, Math.floor((deadline - reference) / 1000));
}

/** Kept for existing callers: the clock is the round's, not the attempt's. */
export function remainingSeconds(round: Row, _progress: Row | null): number {
  return roundRemainingSeconds(round);
}

/**
 * Sequential progression. A student may not jump ahead while an earlier round
 * is still running for them. Once the admin has moved on (earlier round ended,
 * paused or reset) the current LIVE round is open to everyone.
 */
export async function roundSequenceBlock(studentId: string, round: Row): Promise<string | null> {
  const orderNo = num(round["orderNo"], 1);
  if (orderNo <= 1) return null;
  const db = ownDb();
  const { data: earlier } = await db
    .from("rounds")
    .select("id, name, state, orderNo")
    .eq("eventId", str(round["eventId"]))
    .lt("orderNo", orderNo)
    .eq("state", "LIVE");
  const pending = (earlier ?? []) as Row[];
  if (!pending.length) return null;

  const { data: progressRows } = await db
    .from("round_progress")
    .select("roundId, status")
    .eq("studentId", studentId)
    .in("roundId", pending.map((r) => str(r["id"])));

  for (const prev of pending) {
    const mine = (progressRows ?? []).find((p) => str((p as Row)["roundId"]) === str(prev["id"])) as
      | Row
      | undefined;
    const status = str(mine?.["status"], "NOT_STARTED");
    if (status !== "IN_PROGRESS") continue;
    return `Finish ${str(prev["name"], "the previous round")} before entering this round.`;
  }
  return null;
}

/**
 * Closes an attempt whose server-side deadline has passed. Returns the (possibly
 * updated) progress row so callers always work with authoritative state.
 */
export async function autoSubmitIfExpired(round: Row, progress: Row | null): Promise<Row | null> {
  if (!progress) return null;
  if (str(progress["status"]) !== "IN_PROGRESS") return progress;
  if (str(round["state"]) === "PAUSED") return progress;
  if (remainingSeconds(round, progress) > 0) return progress;

  const { recalcRoundScore } = await import("./scoring.server");
  const studentId = str(progress["studentId"]);
  const now = nowIso();
  await ownDb()
    .from("round_progress")
    .update({ status: "SUBMITTED", submittedAt: now, updatedAt: now })
    .eq("id", str(progress["id"]))
    .eq("status", "IN_PROGRESS");
  if (str(round["type"]) === "ROUND2") {
    const { finalizeRound2 } = await import("./bughunt.server");
    await finalizeRound2(studentId, round, progress);
  }
  await recalcRoundScore(studentId, round);
  return { ...progress, status: "SUBMITTED", submittedAt: now };
}

/** Gate + progress + clock for a student's attempt, with expiry enforced. */
export async function attemptState(studentId: string, round: Row) {
  let gate = roundGate(round);
  const db = ownDb();
  const { data: found } = await db
    .from("round_progress")
    .select("*")
    .eq("studentId", studentId)
    .eq("roundId", str(round["id"]))
    .maybeSingle();

  let progress = (found as Row | null) ?? null;
  progress = await autoSubmitIfExpired(round, progress);

  if (gate.open && !progress) {
    const blocked = await roundSequenceBlock(studentId, round);
    if (blocked) gate = { open: false, state: gate.state, reason: blocked };
  }
  if (gate.open && !progress) progress = await ensureProgress(studentId, round);

  const status = str(progress?.["status"], "NOT_STARTED");
  const canPlay = gate.open && status === "IN_PROGRESS";
  return {
    gate,
    progress,
    status,
    canPlay,
    remainingSeconds: remainingSeconds(round, progress),
  };
}


/** Throws unless the student may currently write to this round. */
export async function requireWritableAttempt(studentId: string, round: Row) {
  const state = await attemptState(studentId, round);
  if (!state.gate.open) throw new Error(state.gate.reason || "This round is not open.");
  if (state.status === "SUBMITTED" || state.status === "LOCKED")
    throw new Error("You have already submitted this round.");
  if (!state.canPlay) throw new Error("Your attempt for this round is not active.");
  if (state.remainingSeconds <= 0) throw new Error("Your time for this round has expired.");
  return state;
}

/**
 * Automatic completion. When server time reaches the round deadline every open
 * attempt is submitted, scored and locked, and the round itself is ENDED.
 * Safe to call from any read path — it is idempotent.
 */
export async function sweepRound(round: Row): Promise<Row> {
  if (str(round["state"]) !== "LIVE") return round;
  if (roundRemainingSeconds(round) > 0) return round;

  const db = ownDb();
  const now = nowIso();
  const { data: open } = await db
    .from("round_progress")
    .select("*")
    .eq("roundId", str(round["id"]))
    .eq("status", "IN_PROGRESS");

  const attempts = (open ?? []) as Row[];
  // One statement closes every open attempt instead of one round trip each.
  if (attempts.length) {
    await db
      .from("round_progress")
      .update({ status: "SUBMITTED", submittedAt: now, updatedAt: now })
      .eq("roundId", str(round["id"]))
      .eq("status", "IN_PROGRESS");
  }

  const { recalcRoundScoresFor } = await import("./scoring.server");
  if (str(round["type"]) === "ROUND2" && attempts.length) {
    const { finalizeRound2 } = await import("./bughunt.server");
    for (const attempt of attempts) {
      await finalizeRound2(str(attempt["studentId"]), round, attempt);
    }
  }
  await recalcRoundScoresFor(
    attempts.map((attempt) => str(attempt["studentId"])),
    round,
  );


  await db
    .from("rounds")
    .update({ state: "ENDED", endTime: now, updatedAt: now })
    .eq("id", str(round["id"]))
    .eq("state", "LIVE");

  const { rebuildRanks } = await import("./scoring.server");
  await rebuildRanks();
  return { ...round, state: "ENDED", endTime: now };
}

/** Sweeps every round whose universal clock has run out. */
export async function sweepRounds(rounds?: Row[]): Promise<Row[]> {
  const all = rounds ?? (await listRounds());
  const out: Row[] = [];
  for (const r of all) out.push(await sweepRound(r));
  return out;
}

/* ------------------------------------------------------------------ */
/* Round 3 code drafts — one saved program per problem, per student.    */
/* Stored on the student's round_progress row so navigating between     */
/* problems (or refreshing) never loses work.                           */
/* ------------------------------------------------------------------ */

export function readCodeDrafts(progress: Row | null): Record<string, string> {
  const saved = (progress?.["savedData"] ?? {}) as Record<string, unknown>;
  const drafts = (saved["codeDrafts"] ?? {}) as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(drafts)) out[key] = String(value ?? "");
  return out;
}

export async function saveCodeDraftRow(progress: Row, problemId: string, sourceCode: string) {
  const saved = ((progress["savedData"] ?? {}) as Record<string, unknown>) || {};
  const drafts = { ...readCodeDrafts(progress), [problemId]: sourceCode };
  await ownDb()
    .from("round_progress")
    .update({ savedData: { ...saved, codeDrafts: drafts }, updatedAt: nowIso() })
    .eq("id", str(progress["id"]));
}

/**
 * The next round in the event after this one, so the student UI can offer a
 * "Go to next round" link after a successful submission. Gating still happens
 * server-side when they open it.
 */
export async function nextRoundInfo(round: Row) {
  const { data } = await ownDb()
    .from("rounds")
    .select("id, name, type, orderNo, state")
    .eq("eventId", str(round["eventId"]))
    .gt("orderNo", num(round["orderNo"], 1))
    .order("orderNo", { ascending: true })
    .limit(1);
  const next = data?.[0] as Row | undefined;
  if (!next) return null;
  return {
    id: str(next["id"]),
    name: str(next["name"]),
    type: str(next["type"]),
    state: str(next["state"]),
  };
}
