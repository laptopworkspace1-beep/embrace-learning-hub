import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { getMySubmissions } from "@/lib/student.functions";
import { AppShell, STUDENT_NAV } from "@/components/AppShell";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { formatIst } from "@/lib/datetime";

export const Route = createFileRoute("/_authenticated/submissions")({
  head: () => ({
    meta: [
      { title: "My submissions — CodeArena" },
      { name: "description", content: "Every code and bug-fix submission you have made." },
      { property: "og:title", content: "My submissions — CodeArena" },
      { property: "og:description", content: "Track your submission history and test results." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: SubmissionsPage,
});

function SubmissionsPage() {
  const q = useQuery({
    queryKey: ["my-submissions"],
    queryFn: () => getMySubmissions(),
    refetchInterval: 20_000,
  });
  const code = q.data?.code ?? [];
  const debug = q.data?.debug ?? [];

  return (
    <AppShell nav={STUDENT_NAV} title="My submissions" subtitle="Results are evaluated on the server.">
      {q.isLoading ? (
        <Skeleton className="h-48 w-full" />
      ) : (
        <>
          <h2 className="text-lg font-semibold">Code Sprint</h2>
          <div className="mt-4 space-y-2">
            {code.map((s) => (
              <div
                key={s.id}
                className="surface flex items-center justify-between gap-4 rounded-lg border border-border/70 px-5 py-3"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{s.title}</p>
                  <p className="text-xs text-muted-foreground">
                    {s.language} · {s.passedTests}/{s.totalTests} tests · {s.executionMs} ms ·{" "}
                    {formatIst(s.createdAt)}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <Badge variant={s.status === "ACCEPTED" ? "default" : "secondary"}>{s.status}</Badge>
                  <span className="font-mono text-sm">{s.score}</span>
                </div>
              </div>
            ))}
            {code.length === 0 ? <p className="text-sm text-muted-foreground">No code submissions yet.</p> : null}
          </div>

          <h2 className="mt-10 text-lg font-semibold">Bug Hunt</h2>
          <div className="mt-4 space-y-2">
            {debug.map((s) => (
              <div
                key={s.id}
                className="surface flex items-center justify-between gap-4 rounded-lg border border-border/70 px-5 py-3"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{s.title}</p>
                  <p className="text-xs text-muted-foreground">
                    {s.message || "Evaluated"} · {formatIst(s.createdAt)}
                  </p>
                </div>
                <span className="font-mono text-sm">{s.score}</span>
              </div>
            ))}
            {debug.length === 0 ? (
              <p className="text-sm text-muted-foreground">No bug-fix submissions yet.</p>
            ) : null}
          </div>
        </>
      )}
    </AppShell>
  );
}
