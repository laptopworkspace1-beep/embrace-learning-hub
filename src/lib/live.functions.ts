/**
 * Live synchronisation layer.
 *
 * The database is the single source of truth. Admin and students both poll
 * these endpoints on a short interval, so a START in the control room shows up
 * for every student within ~2 seconds without a manual refresh, and everybody
 * counts down against the SAME server-issued deadline.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { apiMetrics } from "./api-metrics";

type Row = Record<string, unknown>;

export type LiveRound = {
  id: string;
  name: string;
  type: "ROUND1" | "ROUND2" | "ROUND3";
  orderNo: number;
  state: "DRAFT" | "READY" | "LIVE" | "PAUSED" | "ENDED";
  durationMinutes: number;
  maxMarks: number;
  startTime: string | null;
  deadlineAt: string | null;
  remainingSeconds: number;
};

export type LiveState = {
  serverTime: string;
  event: { id: string; title: string; status: string } | null;
  rounds: LiveRound[];
  myStatus: Record<string, string>;
  fullscreenRequired: boolean;
  fullscreenSignalAt: string | null;
  fullscreenMessage: string;
};

async function readLiveRounds() {
  const comp = await import("./comp.server");
  const swept = await comp.sweepRounds();
  return swept
    .slice()
    .sort((a, b) => comp.num(a["orderNo"]) - comp.num(b["orderNo"]))
    .map<LiveRound>((r) => ({
      id: comp.str(r["id"]),
      name: comp.str(r["name"]),
      type: comp.str(r["type"]) as LiveRound["type"],
      orderNo: comp.num(r["orderNo"]),
      state: comp.str(r["state"], "DRAFT") as LiveRound["state"],
      durationMinutes: comp.num(r["durationMinutes"]),
      maxMarks: comp.num(r["maxMarks"]),
      startTime: (r["startTime"] as string | null) ?? null,
      deadlineAt: comp.roundDeadlineIso(r),
      remainingSeconds: comp.roundRemainingSeconds(r),
    }));
}

async function readEventShell() {
  const { ownDb } = await import("./own-db.server");
  const db = ownDb();
  const [{ data: events }, { data: settings }] = await Promise.all([
    db.from("events").select("*").order("createdAt").limit(1),
    db.from("event_settings").select("*").limit(1),
  ]);
  const event = (events?.[0] as Row | undefined) ?? null;
  const s = (settings?.[0] as Row | undefined) ?? null;
  return {
    event: event
      ? { id: String(event["id"]), title: String(event["title"]), status: String(event["status"]) }
      : null,
    fullscreenRequired: Boolean(s?.["fullscreenRequired"]),
    fullscreenSignalAt: (s?.["fullscreenSignalAt"] as string | null) ?? null,
    fullscreenMessage: String(s?.["fullscreenSignal"] ?? ""),
  };
}

/** Student-facing live state. Polled every couple of seconds. */
export const getLiveState = createServerFn({ method: "GET" }).middleware([apiMetrics("live.getLiveState")]).handler(async (): Promise<LiveState> => {
  const { requireStudent } = await import("./app-session.server");
  const { ownDb } = await import("./own-db.server");
  const claims = await requireStudent();
  // All three reads are independent — issue them in one parallel batch instead
  // of paying three serial round trips on every 2-second poll.
  const [rounds, shell, { data: progress }] = await Promise.all([
    readLiveRounds(),
    readEventShell(),
    ownDb().from("round_progress").select("roundId, status").eq("studentId", claims.studentId),
  ]);
  const myStatus: Record<string, string> = {};
  for (const p of (progress ?? []) as Row[]) myStatus[String(p["roundId"])] = String(p["status"]);
  return { serverTime: new Date().toISOString(), rounds, myStatus, ...shell };
});

/**
 * Student heartbeat: keeps presence and fullscreen status fresh for the admin
 * monitor. Also the moment expired rounds get swept closed.
 */
export const heartbeat = createServerFn({ method: "POST" }).middleware([apiMetrics("live.heartbeat")])
  .inputValidator((input: { roundId?: string | null; fullscreen: boolean }) =>
    z.object({ roundId: z.string().nullable().optional(), fullscreen: z.boolean() }).parse(input),
  )
  .handler(async ({ data }) => {
    const { requireStudent } = await import("./app-session.server");
    const { nowIso, ownDb } = await import("./own-db.server");
    const claims = await requireStudent();
    const db = ownDb();
    const now = nowIso();
    const { data: existing } = await db
      .from("student_presence")
      .select("*")
      .eq("studentId", claims.studentId)
      .maybeSingle();
    const changed = !existing || Boolean(existing["fullscreen"]) !== data.fullscreen;
    await db.from("student_presence").upsert(
      {
        studentId: claims.studentId,
        roundId: data.roundId ?? null,
        lastSeenAt: now,
        fullscreen: data.fullscreen,
        fullscreenChangedAt: changed ? now : ((existing?.["fullscreenChangedAt"] as string) ?? now),
        everFullscreen: Boolean(existing?.["everFullscreen"]) || data.fullscreen,
        updatedAt: now,
      },
      { onConflict: "studentId" },
    );
    return { ok: true as const, serverTime: now };
  });

/** Records a monitoring signal for the admin activity feed. */
export const logActivity = createServerFn({ method: "POST" })
  .inputValidator((input: { roundId?: string | null; type: string; details?: string; severity?: string }) =>
    z
      .object({
        roundId: z.string().nullable().optional(),
        type: z.string().min(2).max(48),
        details: z.string().max(300).optional(),
        severity: z.enum(["INFO", "WARNING", "CRITICAL"]).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const { requireStudent } = await import("./app-session.server");
    const { newId, nowIso, ownDb } = await import("./own-db.server");
    const claims = await requireStudent();
    await ownDb()
      .from("activity_events")
      .insert({
        id: newId(),
        studentId: claims.studentId,
        roundId: data.roundId ?? null,
        type: data.type,
        severity: data.severity ?? "INFO",
        details: data.details ?? "",
        createdAt: nowIso(),
      });
    return { ok: true as const };
  });

export type AdminLiveState = {
  serverTime: string;
  event: { id: string; title: string; status: string } | null;
  fullscreenRequired: boolean;
  fullscreenSignalAt: string | null;
  rounds: (LiveRound & { inProgress: number; submitted: number; online: number })[];
  students: {
    studentId: string;
    name: string;
    rollNo: string;
    online: boolean;
    fullscreen: boolean;
    lastSeenAt: string | null;
    roundId: string | null;
    status: string;
    violations: number;
  }[];
  activity: {
    id: string;
    student: string;
    type: string;
    severity: string;
    details: string;
    createdAt: string;
  }[];
};

/** Admin monitor: identical clocks to the students, plus live presence. */
export const getAdminLive = createServerFn({ method: "GET" }).handler(async (): Promise<AdminLiveState> => {
  const { requireAdmin } = await import("./app-session.server");
  const { ownDb } = await import("./own-db.server");
  await requireAdmin();
  const db = ownDb();
  const [rounds, shell] = await Promise.all([readLiveRounds(), readEventShell()]);

  const [
    { data: students },
    { data: presence },
    { data: progress },
    { data: activity },
    { data: viol },
    { data: userRows },
  ] = await Promise.all([
    db.from("students").select("id, fullName").order("fullName"),
    db.from("student_presence").select("*"),
    db.from("round_progress").select("studentId, roundId, status"),
    db.from("activity_events").select("*").order("createdAt", { ascending: false }).limit(60),
    db.from("violations").select("studentId"),
    db.from("users").select("studentId, username").eq("role", "STUDENT"),
  ]);

  const rollBy = new Map(
    ((userRows ?? []) as Row[]).map((u) => [String(u["studentId"]), String(u["username"] ?? "")]),
  );

  const presenceBy = new Map((presence ?? []).map((p) => [String((p as Row)["studentId"]), p as Row]));
  const violCount = new Map<string, number>();
  for (const v of (viol ?? []) as Row[]) {
    const k = String(v["studentId"]);
    violCount.set(k, (violCount.get(k) ?? 0) + 1);
  }

  const { parseTs } = await import("./comp.server");
  const now = Date.now();
  const iso = (v: unknown) => {
    const ms = parseTs(v);
    return ms ? new Date(ms).toISOString() : null;
  };
  const isOnline = (row: Row | undefined) => {
    const seen = parseTs(row?.["lastSeenAt"]);
    return Boolean(seen && now - seen < 20_000);
  };

  // Progress indexed by round and by round+student: constant-time lookups
  // instead of rebuilding and scanning arrays for every student row.
  const statusBy = new Map<string, Row[]>();
  const statusByKey = new Map<string, Row>();
  for (const p of (progress ?? []) as Row[]) {
    const k = String(p["roundId"]);
    const bucket = statusBy.get(k);
    if (bucket) bucket.push(p);
    else statusBy.set(k, [p]);
    statusByKey.set(`${k}|${String(p["studentId"])}`, p);
  }

  const studentRows = ((students ?? []) as Row[]).map((s) => {
    const id = String(s["id"]);
    const p = presenceBy.get(id);
    const roundId = (p?.["roundId"] as string | null) ?? null;
    const mine = roundId ? statusByKey.get(`${roundId}|${id}`) : undefined;
    return {
      studentId: id,
      name: String(s["fullName"] ?? ""),
      rollNo: rollBy.get(id) ?? "",
      online: isOnline(p),
      fullscreen: isOnline(p) && Boolean(p?.["fullscreen"]),
      lastSeenAt: iso(p?.["lastSeenAt"]),
      roundId,
      status: String(mine?.["status"] ?? "NOT_STARTED"),
      violations: violCount.get(id) ?? 0,
    };
  });

  const nameBy = new Map(studentRows.map((s) => [s.studentId, `${s.name} (${s.rollNo})`]));

  return {
    serverTime: new Date().toISOString(),
    ...shell,
    rounds: rounds.map((r) => {
      const rows = statusBy.get(r.id) ?? [];
      return {
        ...r,
        inProgress: rows.filter((x) => String(x["status"]) === "IN_PROGRESS").length,
        submitted: rows.filter((x) => String(x["status"]) !== "IN_PROGRESS").length,
        online: studentRows.filter((s) => s.online && s.roundId === r.id).length,
      };
    }),
    students: studentRows,
    activity: ((activity ?? []) as Row[]).map((a) => ({
      id: String(a["id"]),
      student: nameBy.get(String(a["studentId"])) ?? String(a["studentId"]),
      type: String(a["type"]),
      severity: String(a["severity"] ?? "INFO"),
      details: String(a["details"] ?? ""),
      createdAt: iso(a["createdAt"]) ?? new Date().toISOString(),
    })),
  };
});

/** Admin broadcasts a fullscreen requirement to every connected student. */
export const setFullscreenRequirement = createServerFn({ method: "POST" })
  .inputValidator((input: { required: boolean; message?: string }) =>
    z.object({ required: z.boolean(), message: z.string().max(200).optional() }).parse(input),
  )
  .handler(async ({ data }) => {
    const { requireAdmin } = await import("./app-session.server");
    const { audit, newId, nowIso, ownDb } = await import("./own-db.server");
    const claims = await requireAdmin();
    const db = ownDb();
    const now = nowIso();
    const { data: settings } = await db.from("event_settings").select("id").limit(1);
    const id = String((settings?.[0] as Row | undefined)?.["id"] ?? newId());
    await db.from("event_settings").upsert(
      {
        id,
        fullscreenRequired: data.required,
        fullscreenSignalAt: now,
        fullscreenSignal: data.message ?? "",
        updatedAt: now,
      },
      { onConflict: "id" },
    );
    await audit({
      actorUserId: claims.sub,
      action: data.required ? "monitor.fullscreen_on" : "monitor.fullscreen_off",
      entityType: "event_settings",
      entityId: id,
    });
    return { ok: true as const };
  });
