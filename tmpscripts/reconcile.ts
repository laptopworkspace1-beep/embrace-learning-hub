import { SQL } from "bun";
const db = new SQL(process.env["OWN_SUPABASE_DB_URL"]!);
// A. backfill missing student rows for seeded SARA users (they could not log in at all)
const orphans = await db`select id, "studentId" from users where role='STUDENT' and "studentId" is not null and not exists (select 1 from students s where s."userId"=users.id) order by "studentId"`;
for (const u of orphans as any[]) {
  const n = Number(String(u.studentId).split("-")[1]);
  const code = String(284000 + n);
  let b = await db`select id from batches where code=${code} limit 1`;
  if (!b[0]) b = await db`insert into batches (id, code, name, "createdAt","updatedAt") values (gen_random_uuid()::text, ${code}, ${"Batch "+code}, now(), now()) returning id`;
  await db`insert into students (id,"userId","fullName","batchId",status,"createdAt","updatedAt") values (gen_random_uuid()::text, ${u.id}, ${"Student "+u.studentId}, ${b[0].id}, 'ACTIVE', now(), now())`;
}
console.log("backfilled students:", orphans.length);
// B. give already-registered students (username = batch code, no studentId) a generated Student ID
const noSid = await db`select u.id, b.code from users u join students s on s."userId"=u.id join batches b on b.id=s."batchId" where u.role='STUDENT' and u."studentId" is null`;
for (const u of noSid as any[]) {
  const [{ max }] = await db`select coalesce(max((substring("studentId" from 6))::int),0) as max from users where "studentId" ~ '^SARA-[0-9]+$'` as any[];
  const next = "SARA-" + String(Number(max) + 1).padStart(3, "0");
  await db`update users set "studentId"=${next}, "updatedAt"=now() where id=${u.id}`;
}
console.log("assigned student ids:", noSid.length);
// C. required round configuration (names + default durations), data-only
await db`update rounds set name='Round 1 — Tech Quiz + Output Prediction', "durationMinutes"=20, "maxMarks"=greatest("maxMarks",1), "updatedAt"=now() where type='ROUND1'`;
await db`update rounds set name='Round 2 — Bug Hunt', "durationMinutes"=25, "updatedAt"=now() where type='ROUND2'`;
await db`update rounds set name='Round 3 — Code Sprint', "durationMinutes"=40, "updatedAt"=now() where type='ROUND3'`;
await db`update rounds set state='READY', "startTime"=null,"endTime"=null,"pausedAt"=null,"totalPausedSeconds"=0, "updatedAt"=now() where state in ('ENDED','DRAFT')`;
await db`update events set status='READY', "updatedAt"=now() where status='DRAFT'`;
console.log("rounds", await db`select type,name,"durationMinutes",state from rounds order by "orderNo"`);
console.log("students total", await db`select count(*) from students`);
await db.end();
