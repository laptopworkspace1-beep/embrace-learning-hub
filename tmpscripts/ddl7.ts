import { SQL } from "bun";
const db = new SQL(process.env["OWN_SUPABASE_DB_URL"]!);

// Round 2 Bug Hunt: public (basic) input/expected output live on the problem.
await db`ALTER TABLE public.debugging_problems ADD COLUMN IF NOT EXISTS "publicInput" text NOT NULL DEFAULT ''`;
await db`ALTER TABLE public.debugging_problems ADD COLUMN IF NOT EXISTS "publicExpectedOutput" text NOT NULL DEFAULT ''`;

// Migrate existing visible test cases: first one becomes the public sample,
// and every Round 2 case becomes hidden (Round 2 tests are hidden by design).
const problems = await db`SELECT id, "publicInput", "publicExpectedOutput" FROM public.debugging_problems`;
for (const p of problems as any[]) {
  if (String(p.publicInput ?? "") || String(p.publicExpectedOutput ?? "")) continue;
  const vis = await db`SELECT input, "expectedOutput" FROM public.debug_test_cases
    WHERE "problemId" = ${p.id} AND "isHidden" = false ORDER BY "orderNo" LIMIT 1`;
  const row = (vis as any[])[0];
  if (!row) continue;
  await db`UPDATE public.debugging_problems
    SET "publicInput" = ${row.input ?? ""}, "publicExpectedOutput" = ${row.expectedOutput ?? ""}
    WHERE id = ${p.id}`;
}
await db`UPDATE public.debug_test_cases SET "isHidden" = true WHERE "isHidden" = false`;

console.log("ddl7 ok");
await db.end();
