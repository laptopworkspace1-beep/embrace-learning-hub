const url = process.env["OWN_SUPABASE_DB_URL"]!;
import { SQL } from "bun";
const db = new SQL(url);
const t = await db`select table_name, column_name, data_type, is_nullable from information_schema.columns where table_schema='public' order by table_name, ordinal_position`;
let cur="";
for (const r of t) { if(r.table_name!==cur){cur=r.table_name;console.log("\n### "+cur);} console.log(` ${r.column_name} ${r.data_type}${r.is_nullable==='NO'?' NN':''}`); }
const counts = await db`select relname, n_live_tup from pg_stat_user_tables order by relname`;
console.log("\nROWCOUNTS", counts.map((r:any)=>`${r.relname}=${r.n_live_tup}`).join(", "));
const en = await db`select t.typname, string_agg(e.enumlabel,',' order by e.enumsortorder) v from pg_type t join pg_enum e on e.enumtypid=t.oid group by 1`;
console.log("\nENUMS"); for(const r of en) console.log(" ",r.typname,"=",r.v);
await db.end();
