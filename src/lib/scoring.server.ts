/**
 * Authoritative scoring. Scores are only ever computed here, from stored
 * answers, bug awards and judged submissions — never from client input.
 */
import { newId, nowIso, ownDb } from "./own-db.server";
import { num, str, type Row } from "./comp.server";

async function round1Score(studentId: string, roundId: string): Promise<number> {
  const { data } = await ownDb()
    .from("student_answers")
    .select("awardedMarks")
    .eq("studentId", studentId)
    .eq("roundId", roundId);
  const total = (data ?? []).reduce((sum, r) => sum + num((r as Row)["awardedMarks"]), 0);
  return Math.max(0, total);
}

async function round2Score(studentId: string, roundId: string): Promise<number> {
  const db = ownDb();
  const { data: problems } = await db.from("debugging_problems").select("id").eq("roundId", roundId);
  const ids = (problems ?? []).map((p) => str((p as Row)["id"]));
  if (!ids.length) return 0;
  const [{ data: awards }, { data: subs }] = await Promise.all([
    db
      .from("bug_awards")
      .select("marksAwarded, problemId")
      .eq("studentId", studentId)
      .in("problemId", ids),
    // Test-case marks: the student's best judged submission per problem counts.
    db
      .from("debugging_submissions")
      .select("problemId, score, testsTotal")
      .eq("studentId", studentId)
      .in("problemId", ids),
  ]);
  const bugMarks = (awards ?? []).reduce((sum, r) => sum + num((r as Row)["marksAwarded"]), 0);
  // Best judged submission per problem counts (base marks + passed test marks).
  const best = new Map<string, number>();
  for (const row of subs ?? []) {
    const pid = str((row as Row)["problemId"]);
    best.set(pid, Math.max(best.get(pid) ?? 0, num((row as Row)["score"])));
  }
  const testMarks = [...best.values()].reduce((a, b) => a + b, 0);
  return bugMarks + testMarks;
}


async function round3Score(studentId: string, roundId: string): Promise<number> {
  const db = ownDb();
  const { data: problems } = await db.from("programming_problems").select("id").eq("roundId", roundId);
  const ids = (problems ?? []).map((p) => str((p as Row)["id"]));
  if (!ids.length) return 0;
  const { data: subs } = await db
    .from("programming_submissions")
    .select("problemId, score")
    .eq("studentId", studentId)
    .in("problemId", ids);
  // Best submission per problem counts.
  const best = new Map<string, number>();
  for (const row of subs ?? []) {
    const pid = str((row as Row)["problemId"]);
    best.set(pid, Math.max(best.get(pid) ?? 0, num((row as Row)["score"])));
  }
  return [...best.values()].reduce((a, b) => a + b, 0);
}

/** Recomputes and stores one round score, then the student's final total. */
export async function recalcRoundScore(studentId: string, round: Row): Promise<number> {
  const db = ownDb();
  const roundId = str(round["id"]);
  const type = str(round["type"]);
  const score =
    type === "ROUND1"
      ? await round1Score(studentId, roundId)
      : type === "ROUND2"
        ? await round2Score(studentId, roundId)
        : await round3Score(studentId, roundId);

  const now = nowIso();
  const { error } = await db.from("round_scores").upsert(
    {
      id: newId(),
      studentId,
      roundId,
      score,
      maxMarks: num(round["maxMarks"]),
      evaluatedAt: now,
      createdAt: now,
      updatedAt: now,
    },
    { onConflict: "studentId,roundId" },
  );
  if (error) console.error("[scoring] round_scores upsert failed", error.message);

  await recalcFinalScore(studentId);
  return score;
}

/** Sums every stored round score. Works for any number of rounds. */
export async function recalcFinalScore(studentId: string): Promise<{ total: number; max: number }> {
  const db = ownDb();
  const [{ data: scores }, { data: rounds }] = await Promise.all([
    db.from("round_scores").select("score").eq("studentId", studentId),
    db.from("rounds").select("maxMarks"),
  ]);
  const total = (scores ?? []).reduce((s, r) => s + num((r as Row)["score"]), 0);
  const max = (rounds ?? []).reduce((s, r) => s + num((r as Row)["maxMarks"]), 0);
  const now = nowIso();
  const { error } = await db.from("final_scores").upsert(
    { id: newId(), studentId, totalScore: total, maxScore: max, updatedAt: now, createdAt: now },
    { onConflict: "studentId" },
  );
  if (error) console.error("[scoring] final_scores upsert failed", error.message);
  return { total, max };
}

/**
 * Recomputes many students' round scores. Each student's recalculation is
 * independent, so they run with bounded concurrency instead of strictly one
 * after another: ending a round with 60 open attempts used to cost 60 serial
 * chains of REST round trips (tens of seconds) before the request answered.
 * The limit keeps the burst well inside the PostgREST connection budget.
 */
export async function recalcRoundScoresFor(
  studentIds: string[],
  round: Row,
  concurrency = 8,
): Promise<void> {
  const queue = [...studentIds];
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (;;) {
      const studentId = queue.shift();
      if (!studentId) return;
      try {
        await recalcRoundScore(studentId, round);
      } catch (err) {
        console.error("[scoring] recalc failed for", studentId, err);
      }
    }
  });
  await Promise.all(workers);
}

/** Recomputes dense ranks across all participants (admin action / results view). */
export async function rebuildRanks(): Promise<number> {
  const db = ownDb();
  const { data } = await db
    .from("final_scores")
    .select("id, studentId, totalScore, maxScore, rank")
    .order("totalScore", { ascending: false });
  const rows = (data ?? []) as Row[];
  let rank = 0;
  let previous: number | null = null;
  let index = 0;
  const now = nowIso();
  // One UPDATE per student meant N sequential REST round trips on every single
  // leaderboard load. Ranks are computed in memory and only the rows whose rank
  // actually changed are written, in one batched upsert.
  const changed: Record<string, unknown>[] = [];
  for (const row of rows) {
    index += 1;
    const score = num(row["totalScore"]);
    if (previous === null || score < previous) {
      rank = index;
      previous = score;
    }
    if ((row["rank"] as number | null) !== rank) {
      changed.push({
        id: str(row["id"]),
        studentId: str(row["studentId"]),
        totalScore: score,
        maxScore: num(row["maxScore"]),
        rank,
        updatedAt: now,
      });
    }
  }
  for (let i = 0; i < changed.length; i += 200) {
    const { error } = await db
      .from("final_scores")
      .upsert(changed.slice(i, i + 200), { onConflict: "studentId" });
    if (error) console.error("[scoring] rank upsert failed", error.message);
  }
  return rows.length;
}

