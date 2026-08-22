import { SQL } from "bun";
const db = new SQL(process.env["OWN_SUPABASE_DB_URL"]!);
console.log(await db`select id,"roundId",title,marks,"buggyCode" from debugging_problems`);
console.log(await db`select * from bug_definitions`);
console.log(await db`select id,title,marks,"starterCode","inputFormat",examples from programming_problems`);
console.log(await db`select * from event_settings`);
console.log(await db`select * from visibility_settings`);
await db.end();
