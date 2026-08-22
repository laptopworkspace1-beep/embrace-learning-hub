import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { getAdminOverview } from "@/lib/admin.functions";
import { AppShell, ADMIN_NAV } from "@/components/AppShell";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { formatIstTime } from "@/lib/datetime";

export const Route = createFileRoute("/_authenticated/admin/")({
  head: () => ({
    meta: [
      { title: "Admin overview — CodeArena" },
      { name: "description", content: "Live participation, submissions and integrity signals." },
      { property: "og:title", content: "Admin overview — CodeArena" },
      { property: "og:description", content: "Control panel for your coding event." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: AdminOverview,
});

function AdminOverview() {
  const q = useQuery({
    queryKey: ["admin-stats"],
    queryFn: () => getAdminOverview(),
    refetchInterval: 15_000,
  });

  return (
    <AppShell nav={ADMIN_NAV} title="Control panel" subtitle="Live event telemetry.">
      {q.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : q.isError ? (
        <p className="text-sm text-destructive">
          {q.error instanceof Error ? q.error.message : "Could not load admin data."}
        </p>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-5">
            {[
              ["Students", q.data?.students],
              ["Batches", q.data?.batches],
              ["Live sessions", q.data?.liveSessions],
              ["Submissions", q.data?.submissions],
              ["Violations", q.data?.violations],
            ].map(([label, value]) => (
              <div key={String(label)} className="surface rounded-lg border border-border/70 p-5">
                <p className="mono-label text-muted-foreground">{String(label)}</p>
                <p className="mt-3 font-mono text-2xl font-bold">{Number(value ?? 0)}</p>
              </div>
            ))}
          </div>

          <h2 className="mt-10 text-lg font-semibold">Rounds</h2>
          <div className="mt-4 space-y-2">
            {(q.data?.rounds ?? []).map((r) => (
              <div
                key={r.id}
                className="surface flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/70 px-5 py-3"
              >
                <div>
                  <p className="text-sm font-medium">{r.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {r.durationMinutes} min · {r.maxMarks} marks · {r.inProgress} in progress ·{" "}
                    {r.submitted} submitted
                  </p>
                </div>
                <Badge variant={r.state === "LIVE" ? "default" : "secondary"}>{r.state}</Badge>
              </div>
            ))}
          </div>

          <h2 className="mt-10 text-lg font-semibold">Recent submissions</h2>
          <div className="mt-4 space-y-2">
            {(q.data?.recentSubmissions ?? []).map((s) => (
              <div
                key={s.id}
                className="surface flex items-center justify-between gap-4 rounded-lg border border-border/70 px-5 py-3"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{s.student}</p>
                  <p className="text-xs text-muted-foreground">
                    {s.language} · {s.passedTests}/{s.totalTests} tests ·{" "}
                    {formatIstTime(s.createdAt)}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <Badge variant={s.status === "ACCEPTED" ? "default" : "secondary"}>{s.status}</Badge>
                  <span className="font-mono text-sm">{s.score}</span>
                </div>
              </div>
            ))}
            {(q.data?.recentSubmissions ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">No submissions yet.</p>
            ) : null}
          </div>

          <h2 className="mt-10 text-lg font-semibold">Recent integrity events</h2>
          <div className="mt-4 space-y-2">
            {(q.data?.recentViolations ?? []).map((v) => (
              <div
                key={v.id}
                className="surface flex items-center justify-between gap-4 rounded-lg border border-border/70 px-5 py-3"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{v.student}</p>
                  <p className="text-xs text-muted-foreground">{v.details || v.type}</p>
                </div>
                <Badge variant="secondary">{v.type}</Badge>
              </div>
            ))}
            {(q.data?.recentViolations ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">No integrity events recorded.</p>
            ) : null}
          </div>
        </>
      )}
    </AppShell>
  );
}
