import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { getMyResults } from "@/lib/student.functions";
import { AppShell, STUDENT_NAV } from "@/components/AppShell";
import { Skeleton } from "@/components/ui/skeleton";
import { formatIst } from "@/lib/datetime";

export const Route = createFileRoute("/_authenticated/results")({
  head: () => ({
    meta: [
      { title: "My results — CodeArena" },
      { name: "description", content: "Your round-by-round scores and overall rank." },
      { property: "og:title", content: "My results — CodeArena" },
      { property: "og:description", content: "Round scores and ranking for Coding Challenge 2026." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: ResultsPage,
});

function ResultsPage() {
  const q = useQuery({ queryKey: ["my-results"], queryFn: () => getMyResults(), refetchInterval: 30_000 });

  return (
    <AppShell nav={STUDENT_NAV} title="My results" subtitle="Scores are published by the organisers.">
      {q.isLoading ? (
        <Skeleton className="h-48 w-full" />
      ) : !q.data?.published ? (
        <p className="text-sm text-muted-foreground">
          Results are not published yet. They will appear here as soon as the organisers release them.
        </p>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-4">
            {[
              ["Total score", `${q.data.total} / ${q.data.max}`],
              ["Rank", q.data.rank ? `#${q.data.rank}` : "—"],
              ["Participants", String(q.data.participants)],
              ["Rounds scored", String(q.data.rounds.filter((r) => r.score !== null).length)],
            ].map(([label, value]) => (
              <div key={label} className="surface rounded-lg border border-border/70 p-5">
                <p className="mono-label text-muted-foreground">{label}</p>
                <p className="mt-3 font-mono text-2xl font-bold">{value}</p>
              </div>
            ))}
          </div>

          <div className="mt-8 space-y-2">
            {q.data.rounds.map((r) => (
              <div
                key={r.id}
                className="surface flex items-center justify-between gap-4 rounded-lg border border-border/70 px-5 py-4"
              >
                <div>
                  <p className="text-sm font-medium">{r.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {r.evaluatedAt ? `Evaluated ${formatIst(r.evaluatedAt)}` : "Not evaluated yet"}
                  </p>
                </div>
                <span className="font-mono text-sm">
                  {r.score === null ? "—" : `${r.score} / ${r.maxMarks}`}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </AppShell>
  );
}
