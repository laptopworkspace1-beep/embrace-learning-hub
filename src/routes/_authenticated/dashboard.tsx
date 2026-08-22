import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { getStudentDashboard } from "@/lib/event.functions";
import { useAuth } from "@/lib/auth-context";
import { useLiveSync } from "@/hooks/use-live-sync";
import { AppShell, STUDENT_NAV } from "@/components/AppShell";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { CheckCircle2, Clock, Lock, PlayCircle, Trophy } from "lucide-react";

export const Route = createFileRoute("/_authenticated/dashboard")({
  head: () => ({
    meta: [
      { title: "Dashboard — Coding Challenge 2026" },
      { name: "description", content: "Your live rounds, timers, progress and score." },
      { property: "og:title", content: "Dashboard — Coding Challenge 2026" },
      { property: "og:description", content: "Track your competition rounds and score." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Dashboard,
});

const ROUND_LABEL: Record<string, string> = {
  ROUND1: "MCQ + Output",
  ROUND2: "Debugging",
  ROUND3: "Programming",
};

function stateTone(state: string) {
  if (state === "LIVE") return "bg-success/15 text-success border-success/30";
  if (state === "ENDED") return "bg-muted text-muted-foreground border-border";
  if (state === "LOCKED" || state === "PAUSED")
    return "bg-destructive/15 text-destructive border-destructive/30";
  return "bg-accent/15 text-accent border-accent/30";
}

function Dashboard() {
  const { user, isAdmin } = useAuth();
  const dash = useQuery({
    queryKey: ["student-dashboard"],
    queryFn: () => getStudentDashboard(),
    refetchInterval: 10_000,
    retry: false,
  });
  // Authoritative, always-fresh round states from the server (no manual refresh).
  const { rounds: liveRounds, live, needsFullscreen, enterFullscreen } = useLiveSync(null);
  const liveById = new Map(liveRounds.map((r) => [r.id, r]));

  const completed = (dash.data?.rounds ?? []).filter(
    (r) => r.progressStatus === "SUBMITTED" || r.progressStatus === "AUTO_SUBMITTED",
  ).length;

  return (
    <AppShell
      nav={STUDENT_NAV}
      title={`Welcome, ${user?.fullName ?? "competitor"}`}
      subtitle="Coding Challenge 2026 · three rounds, one shot each"
      actions={
        isAdmin ? (
          <Button asChild size="sm" variant="outline">
            <Link to="/admin">Admin panel</Link>
          </Button>
        ) : null
      }
    >
      {needsFullscreen ? (
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/40 bg-destructive/10 p-4">
          <p className="text-sm">
            The organisers require fullscreen mode for this event.
            {live?.fullscreenMessage ? ` ${live.fullscreenMessage}` : ""}
          </p>
          <Button size="sm" onClick={enterFullscreen}>
            Enter fullscreen
          </Button>
        </div>
      ) : null}

      {dash.isLoading ? (
        <div className="space-y-4">
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : dash.isError ? (
        <p className="text-sm text-destructive">
          {dash.error instanceof Error ? dash.error.message : "Could not load your dashboard."}
        </p>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <StatCard
              icon={<Trophy className="size-4 text-primary" />}
              label="Total score"
              value={`${dash.data?.totalScore ?? 0} / ${dash.data?.maxScore ?? 0}`}
            />
            <StatCard
              icon={<CheckCircle2 className="size-4 text-success" />}
              label="Rounds completed"
              value={String(completed)}
            />
            <StatCard
              icon={<Clock className="size-4 text-accent" />}
              label="Batch number"
              value={user?.batchCode ?? "—"}
            />
          </div>

          <div className="mt-4">
            <Progress
              value={
                dash.data?.maxScore
                  ? Math.round(((dash.data.totalScore ?? 0) / dash.data.maxScore) * 100)
                  : 0
              }
            />
          </div>

          <h2 className="mt-10 text-lg font-semibold">Rounds</h2>
          <div className="mt-4 space-y-3">
            {(dash.data?.rounds ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">No rounds have been published yet.</p>
            ) : null}

            {(dash.data?.rounds ?? []).map((row) => {
              const fresh = liveById.get(row.id);
              const round = {
                ...row,
                state: (fresh?.state ?? row.state) as typeof row.state,
                progressStatus: (live?.myStatus[row.id] ?? row.progressStatus) as typeof row.progressStatus,
              };
              const done =
                round.progressStatus === "SUBMITTED" || round.progressStatus === "AUTO_SUBMITTED";
              const open = round.state === "LIVE" && !done;
              const secondsLeft = fresh?.remainingSeconds ?? 0;
              return (
                <div
                  key={round.id}
                  className="surface flex flex-col gap-4 rounded-lg border border-border/70 p-5 sm:flex-row sm:items-center"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="mono-label text-muted-foreground">round {round.orderNo}</span>
                      <Badge variant="outline" className={stateTone(round.state)}>
                        {round.state.toLowerCase()}
                      </Badge>
                      <Badge variant="outline">{ROUND_LABEL[round.type] ?? round.type}</Badge>
                    </div>
                    <h3 className="mt-2 text-base font-semibold">{round.name}</h3>
                    <p className="mono-label mt-3 text-muted-foreground">
                      {round.durationMinutes} min · {round.maxMarks} marks
                      {round.state === "LIVE" || round.state === "PAUSED"
                        ? ` · ${Math.floor(secondsLeft / 60)}m ${secondsLeft % 60}s left`
                        : ""}
                      {round.score !== null ? ` · scored ${round.score}` : ""}
                    </p>
                  </div>
                  <div className="shrink-0">
                    {done ? (
                      <Badge variant="outline" className="gap-1 border-border">
                        <CheckCircle2 className="size-3" />
                        {round.progressStatus === "AUTO_SUBMITTED" ? "Auto-submitted" : "Submitted"}
                      </Badge>
                    ) : open ? (
                      <Button asChild>
                        <Link to="/rounds/$roundId" params={{ roundId: round.id }}>
                          <PlayCircle className="size-4" />
                          {round.progressStatus === "IN_PROGRESS" ? "Resume" : "Start round"}
                        </Link>
                      </Button>
                    ) : (
                      <Button disabled variant="outline">
                        <Lock className="size-4" />
                        Locked
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </AppShell>
  );
}

function StatCard({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="surface rounded-lg border border-border/70 p-5">
      <div className="flex items-center gap-2">
        {icon}
        <span className="mono-label text-muted-foreground">{label}</span>
      </div>
      <p className="mt-3 font-mono text-2xl font-bold">{value}</p>
    </div>
  );
}
