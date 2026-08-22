import { SQL } from "bun";
const db = new SQL(process.env["OWN_SUPABASE_DB_URL"]!);

// Performance-only migration: indexes matching the hottest read paths.
// No schema/behaviour change.
const statements = [
  // Admin submission feeds order by createdAt desc, limit 300.
  `CREATE INDEX IF NOT EXISTS "programming_submissions_createdAt_idx" ON public.programming_submissions ("createdAt" DESC)`,
  `CREATE INDEX IF NOT EXISTS "debugging_submissions_createdAt_idx" ON public.debugging_submissions ("createdAt" DESC)`,
  // Round 1 answer load: studentId + roundId.
  `CREATE INDEX IF NOT EXISTS "student_answers_student_round_idx" ON public.student_answers ("studentId", "roundId")`,
  // Live sync reads a student's progress rows every couple of seconds.
  `CREATE INDEX IF NOT EXISTS "round_progress_student_idx" ON public.round_progress ("studentId")`,
  // Presence freshness lookup for the admin monitor.
  `CREATE INDEX IF NOT EXISTS "student_presence_lastSeen_idx" ON public.student_presence ("lastSeenAt" DESC)`,
  // Activity feed is always the newest N rows.
  `CREATE INDEX IF NOT EXISTS "activity_events_round_createdAt_idx" ON public.activity_events ("roundId", "createdAt" DESC)`,
];

for (const sql of statements) {
  try {
    await db.unsafe(sql);
    console.log("ok:", sql.slice(0, 70));
  } catch (error) {
    console.log("skip:", sql.slice(0, 70), String(error).slice(0, 120));
  }
}

await db`ANALYZE`;
console.log("ddl8 ok");
await db.end();
