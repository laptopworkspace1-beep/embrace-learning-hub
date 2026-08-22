import { SQL } from "bun";
const db = new SQL(process.env["OWN_SUPABASE_DB_URL"]!);
console.log(await db`select u.id,u.username,u."studentId",u.role,u."isActive",(select count(*) from students s where s."userId"=u.id) srows from users u order by u."createdAt" limit 8`);
console.log("distinct sid pattern", await db`select min("studentId") a, max("studentId") b, count(*) c from users where "studentId" is not null`);
console.log("students", await db`select s.*, u.username, u."studentId" from students s join users u on u.id=s."userId"`);
console.log("orphan seeded users w/o student row", await db`select count(*) from users u where u.role='STUDENT' and not exists (select 1 from students s where s."userId"=u.id)`);
console.log("batches", await db`select code,name from batches order by code limit 5`, await db`select count(*) from batches`);
await db.end();
