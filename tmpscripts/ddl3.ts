import { SQL } from "bun";
const db = new SQL(process.env["OWN_SUPABASE_DB_URL"]!);

// Universal, per-round server deadline (shared by admin + every student).
await db`ALTER TABLE public.rounds ADD COLUMN IF NOT EXISTS "deadlineAt" timestamp`;

// Admin-controlled fullscreen broadcast.
await db`ALTER TABLE public.event_settings ADD COLUMN IF NOT EXISTS "fullscreenRequired" boolean NOT NULL DEFAULT false`;
await db`ALTER TABLE public.event_settings ADD COLUMN IF NOT EXISTS "fullscreenSignalAt" timestamp`;
await db`ALTER TABLE public.event_settings ADD COLUMN IF NOT EXISTS "fullscreenSignal" text NOT NULL DEFAULT ''`;

// Admin-editable homepage content.
await db`CREATE TABLE IF NOT EXISTS public.homepage_content (
  id text PRIMARY KEY,
  "siteName" text NOT NULL DEFAULT 'CodeArena',
  "departmentName" text NOT NULL DEFAULT 'Information Technology',
  "mainHeading" text NOT NULL DEFAULT 'INFORMATION TECHNOLOGY',
  subtitle text NOT NULL DEFAULT 'College Coding Competition',
  description text NOT NULL DEFAULT '',
  "heroText" text NOT NULL DEFAULT 'Compete. Solve. Debug. Code.',
  "round1Name" text NOT NULL DEFAULT 'TECH QUIZ',
  "round1Description" text NOT NULL DEFAULT 'MCQ + Output Prediction',
  "round2Name" text NOT NULL DEFAULT 'BUG HUNT',
  "round2Description" text NOT NULL DEFAULT 'Find. Fix. Submit.',
  "round3Name" text NOT NULL DEFAULT 'CODE SPRINT',
  "round3Description" text NOT NULL DEFAULT 'Build. Test. Solve.',
  stats jsonb NOT NULL DEFAULT '[]'::jsonb,
  "footerText" text NOT NULL DEFAULT 'College Coding Competition Platform',
  "updatedAt" timestamp NOT NULL DEFAULT now()
)`;
await db`INSERT INTO public.homepage_content (id, stats) VALUES ('default-event',
  '[{"value":"03","label":"ROUNDS"},{"value":"60+","label":"STUDENTS"},{"value":"01","label":"PLATFORM"},{"value":"LIVE","label":"CONTROL"}]'::jsonb)
  ON CONFLICT (id) DO NOTHING`;

// Live student presence (online / fullscreen), refreshed by the student heartbeat.
await db`CREATE TABLE IF NOT EXISTS public.student_presence (
  "studentId" text PRIMARY KEY,
  "roundId" text,
  "lastSeenAt" timestamp NOT NULL DEFAULT now(),
  fullscreen boolean NOT NULL DEFAULT false,
  "fullscreenChangedAt" timestamp,
  "everFullscreen" boolean NOT NULL DEFAULT false,
  "updatedAt" timestamp NOT NULL DEFAULT now()
)`;

// Suspicious-activity feed (superset of the hard violations table).
await db`CREATE TABLE IF NOT EXISTS public.activity_events (
  id text PRIMARY KEY,
  "studentId" text NOT NULL,
  "roundId" text,
  type text NOT NULL,
  severity text NOT NULL DEFAULT 'INFO',
  details text NOT NULL DEFAULT '',
  "createdAt" timestamp NOT NULL DEFAULT now()
)`;
await db`CREATE INDEX IF NOT EXISTS activity_events_created_idx ON public.activity_events ("createdAt" DESC)`;
await db`CREATE INDEX IF NOT EXISTS activity_events_student_idx ON public.activity_events ("studentId")`;

console.log("ddl3 done");
await db.end();
