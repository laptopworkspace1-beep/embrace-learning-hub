import { SQL } from "bun";
const db = new SQL(process.env["OWN_SUPABASE_DB_URL"]!);
const r = await db`select tablename, indexdef from pg_indexes where schemaname='public' order by tablename`;
for (const row of r as any[]) console.log(row.tablename, "|", row.indexdef.replace(/^CREATE (UNIQUE )?INDEX .* ON /, ""));
const t = await db`select relname, n_live_tup from pg_stat_user_tables order by n_live_tup desc limit 20`;
console.log("---rows---"); for (const row of t as any[]) console.log(row.relname, row.n_live_tup);
await db.end();
