import { createServerFn } from "@tanstack/react-start";

export type RoundState = "DRAFT" | "SCHEDULED" | "LIVE" | "PAUSED" | "ENDED" | "LOCKED";

export type DashboardRound = {
  id: string;
  name: string;
  type: "ROUND1" | "ROUND2" | "ROUND3";
  orderNo: number;
  state: RoundState;
  durationMinutes: number;
  maxMarks: number;
  startTime: string | null;
  endTime: string | null;
  progressStatus: "NOT_STARTED" | "IN_PROGRESS" | "SUBMITTED" | "LOCKED" | "AUTO_SUBMITTED";
  score: number | null;
};

/** Rounds, the student's progress and their scores — all from the event database. */
export const getStudentDashboard = createServerFn({ method: "GET" }).handler(async () => {
  const { requireStudent } = await import("./app-session.server");
  const { ownDb } = await import("./own-db.server");
  const claims = await requireStudent();
  const db = ownDb();

  const [{ data: rounds }, { data: progress }, { data: scores }, { data: final }] = await Promise.all([
    db.from("rounds").select("*").order("orderNo", { ascending: true }),
    db.from("round_progress").select("roundId, status").eq("studentId", claims.studentId),
    db.from("round_scores").select("roundId, score, maxMarks").eq("studentId", claims.studentId),
    db
      .from("final_scores")
      .select("totalScore, maxScore, rank")
      .eq("studentId", claims.studentId)
      .maybeSingle(),
  ]);

  const progressByRound = new Map(
    (progress ?? []).map((row) => [String(row["roundId"]), String(row["status"])]),
  );
  const scoreByRound = new Map(
    (scores ?? []).map((row) => [String(row["roundId"]), Number(row["score"] ?? 0)]),
  );

  const list: DashboardRound[] = (rounds ?? []).map((row) => ({
    id: String(row["id"]),
    name: String(row["name"]),
    type: row["type"] as DashboardRound["type"],
    orderNo: Number(row["orderNo"] ?? 0),
    state: row["state"] as RoundState,
    durationMinutes: Number(row["durationMinutes"] ?? 0),
    maxMarks: Number(row["maxMarks"] ?? 0),
    startTime: (row["startTime"] as string | null) ?? null,
    endTime: (row["endTime"] as string | null) ?? null,
    progressStatus:
      (progressByRound.get(String(row["id"])) as DashboardRound["progressStatus"]) ?? "NOT_STARTED",
    score: scoreByRound.has(String(row["id"])) ? scoreByRound.get(String(row["id"]))! : null,
  }));

  const totalScore = Number(final?.["totalScore"] ?? list.reduce((sum, r) => sum + (r.score ?? 0), 0));
  const maxScore = Number(final?.["maxScore"] ?? list.reduce((sum, r) => sum + r.maxMarks, 0));

  return {
    rounds: list,
    totalScore,
    maxScore,
    rank: (final?.["rank"] as number | null) ?? null,
  };
});
