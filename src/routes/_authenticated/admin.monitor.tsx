import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { getAdminLive, setFullscreenRequirement } from "@/lib/live.functions";
import { controlRound } from "@/lib/admin.functions";
import { AppShell, ADMIN_NAV } from "@/components/AppShell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { formatIstTime } from "@/lib/datetime";

export const Route = createFileRoute("/_authenticated/admin/monitor")({
  head: () => ({
    meta: [
      { title: "Live monitor — CodeArena admin" },
      {
        name: "description",
        content: "Universal round timers, live student presence, fullscreen status and suspicious activity.",
      },
      { property: "og:title", content: "Live monitor — CodeArena admin" },
      { property: "og:description", content: "Real-time control room for the coding competition." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: AdminMonitor,
});

/** Ticks locally between polls but is always re-seeded from the server value. */
function Clock({ seconds, state }: { seconds: number; state: string }) {
  const [left, setLeft] = useState(seconds);
  useEffect(() => setLeft(seconds), [seconds]);
  useEffect(() => {
    if (state !== "LIVE") return;
    const id = setInterval(() => setLeft((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(id);
  }, [state]);
  const h = Math.floor(left / 3600);
  const m = Math.floor((left % 3600) / 60);
  const s = left % 60;
  return (
    <span
      className={cn(
        "font-mono text-2xl font-bold tabular-nums",
        state === "LIVE" && left <= 120 ? "text-destructive" : "",
      )}
    >
      {h > 0 ? `${String(h).padStart(2, "0")}:` : ""}
      {String(m).padStart(2, "0")}:{String(s).padStart(2, "0")}
    </span>
  );
}

function severityTone(severity: string) {
  if (severity === "CRITICAL") return "bg-destructive/15 text-destructive border-destructive/30";
  if (severity === "WARNING") return "bg-accent/15 text-accent border-accent/30";
  return "";
}

function AdminMonitor() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["admin-live"],
    queryFn: () => getAdminLive(),
    refetchInterval: 2000,
    // No 2s polling while the tab is hidden — it resumes instantly on focus.
    refetchIntervalInBackground: false,
    placeholderData: (prev) => prev,
  });


  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["admin-live"] });
    void qc.invalidateQueries({ queryKey: ["event-control"] });
  };
  const fail = (e: unknown) => toast.error(e instanceof Error ? e.message : "Something went wrong.");

  const round = useMutation({
    mutationFn: (v: { roundId: string; action: "start" | "pause" | "resume" | "end" | "reset" }) =>
      controlRound({ data: v }),
    onSuccess: () => {
      toast.success("Round updated — students see it within two seconds.");
      refresh();
    },
    onError: fail,
  });

  const fullscreen = useMutation({
    mutationFn: (required: boolean) =>
      setFullscreenRequirement({
        data: {
          required,
          message: required ? "Please stay in fullscreen for the whole round." : "",
        },
      }),
    onSuccess: () => {
      toast.success("Fullscreen instruction sent.");
      refresh();
    },
    onError: fail,
  });

  const data = q.data;
  const online = (data?.students ?? []).filter((s) => s.online);

  return (
    <AppShell
      nav={ADMIN_NAV}
      title="Live monitor"
      subtitle="One server clock for everyone · refreshes automatically"
    >
      {q.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : q.isError ? (
        <p className="text-sm text-destructive">
          {q.error instanceof Error ? q.error.message : "Could not load the live monitor."}
        </p>
      ) : (
        <>
          <div className="surface flex flex-wrap items-center justify-between gap-4 rounded-lg border border-border/70 p-5">
            <div>
              <p className="text-sm font-semibold">{data?.event?.title ?? "No event"}</p>
              <p className="text-xs text-muted-foreground">
                {online.length} online · {online.filter((s) => s.fullscreen).length} in fullscreen · server
                time {formatIstTime(data?.serverTime ?? Date.now())}
              </p>
            </div>
            <div className="flex items-center gap-3">
              <Switch
                id="fs"
                checked={Boolean(data?.fullscreenRequired)}
                onCheckedChange={(v) => fullscreen.mutate(v)}
              />
              <Label htmlFor="fs">Require fullscreen</Label>
              <Button size="sm" variant="outline" onClick={() => fullscreen.mutate(true)}>
                Ask everyone now
              </Button>
            </div>
          </div>

          <h2 className="mt-10 text-lg font-semibold">Round control</h2>
          <div className="mt-4 grid gap-4 lg:grid-cols-3">
            {(data?.rounds ?? []).map((r) => (
              <div key={r.id} className="surface rounded-lg border border-border/70 p-5">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-medium">
                    #{r.orderNo} · {r.name}
                  </p>
                  <Badge variant={r.state === "LIVE" ? "default" : "secondary"}>{r.state}</Badge>
                </div>
                <div className="mt-4">
                  <Clock seconds={r.remainingSeconds} state={r.state} />
                  <p className="mono-label mt-1 text-muted-foreground">
                    {r.durationMinutes} min · {r.online} online · {r.inProgress} attempting ·{" "}
                    {r.submitted} done
                  </p>
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    disabled={r.state === "LIVE" || round.isPending}
                    onClick={() => round.mutate({ roundId: r.id, action: "start" })}
                  >
                    Start
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={r.state !== "LIVE" || round.isPending}
                    onClick={() => round.mutate({ roundId: r.id, action: "pause" })}
                  >
                    Pause
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={r.state !== "PAUSED" || round.isPending}
                    onClick={() => round.mutate({ roundId: r.id, action: "resume" })}
                  >
                    Resume
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={round.isPending}
                    onClick={() => round.mutate({ roundId: r.id, action: "reset" })}
                  >
                    Restart
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={r.state === "ENDED" || round.isPending}
                    onClick={() => round.mutate({ roundId: r.id, action: "end" })}
                  >
                    End
                  </Button>
                </div>
              </div>
            ))}
          </div>

          <div className="mt-10 grid gap-6 lg:grid-cols-2">
            <div>
              <h2 className="text-lg font-semibold">Students</h2>
              <div className="mt-4 space-y-2">
                {(data?.students ?? []).map((s) => (
                  <div
                    key={s.studentId}
                    className="surface flex items-center justify-between gap-3 rounded-lg border border-border/70 px-4 py-2.5"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{s.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {s.rollNo || "—"} · {s.status.toLowerCase()}
                        {s.violations ? ` · ${s.violations} violation(s)` : ""}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Badge variant="outline" className={s.online ? "border-success/40 text-success" : ""}>
                        {s.online ? "online" : "offline"}
                      </Badge>
                      <Badge
                        variant="outline"
                        className={s.fullscreen ? "border-success/40 text-success" : severityTone("WARNING")}
                      >
                        {s.fullscreen ? "fullscreen" : "windowed"}
                      </Badge>
                    </div>
                  </div>
                ))}
                {(data?.students ?? []).length === 0 ? (
                  <p className="text-sm text-muted-foreground">No students registered yet.</p>
                ) : null}
              </div>
            </div>

            <div>
              <h2 className="text-lg font-semibold">Suspicious activity</h2>
              <div className="mt-4 space-y-2">
                {(data?.activity ?? []).map((a) => (
                  <div
                    key={a.id}
                    className="surface flex items-center justify-between gap-3 rounded-lg border border-border/70 px-4 py-2.5"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{a.student}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {a.details || a.type} · {formatIstTime(a.createdAt)}
                      </p>
                    </div>
                    <Badge variant="outline" className={severityTone(a.severity)}>
                      {a.type.toLowerCase()}
                    </Badge>
                  </div>
                ))}
                {(data?.activity ?? []).length === 0 ? (
                  <p className="text-sm text-muted-foreground">Nothing recorded yet.</p>
                ) : null}
              </div>
            </div>
          </div>
        </>
      )}
    </AppShell>
  );
}
