import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { getLeaderboard } from "@/lib/admin.functions";
import { AppShell, ADMIN_NAV } from "@/components/AppShell";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export const Route = createFileRoute("/_authenticated/admin/leaderboard")({
  head: () => ({
    meta: [
      { title: "Leaderboard — CodeArena admin" },
      { name: "description", content: "Ranked totals across every round, recalculated on the server." },
      { property: "og:title", content: "Leaderboard — CodeArena admin" },
      { property: "og:description", content: "Final standings for the coding event." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: AdminLeaderboard,
});

function AdminLeaderboard() {
  const q = useQuery({ queryKey: ["admin-leaderboard"], queryFn: () => getLeaderboard() });

  const exportCsv = () => {
    if (!q.data) return;
    const header = ["Rank", "Name", "Student ID", ...q.data.rounds.map((r) => r.name), "Total", "Max"];
    const lines = q.data.rows.map((r) =>
      [
        r.rank ?? "",
        r.name,
        r.studentCode,
        ...q.data.rounds.map((rd) => r.perRound[rd.id] ?? 0),
        r.total,
        r.max,
      ]
        .map((v) => `"${String(v).replace(/"/g, '""')}"`)
        .join(","),
    );
    const blob = new Blob([[header.join(","), ...lines].join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "leaderboard.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <AppShell
      nav={ADMIN_NAV}
      title="Leaderboard"
      subtitle="Ranks are rebuilt from stored round scores every time this page loads."
      actions={
        <Button size="sm" variant="outline" disabled={!q.data} onClick={exportCsv}>
          Export CSV
        </Button>
      }
    >
      {q.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : q.isError ? (
        <p className="text-sm text-destructive">Could not load the leaderboard.</p>
      ) : (
        <div className="surface overflow-x-auto rounded-lg border border-border/70">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>#</TableHead>
                <TableHead>Student</TableHead>
                <TableHead>ID</TableHead>
                {(q.data?.rounds ?? []).map((r) => (
                  <TableHead key={r.id}>{r.name}</TableHead>
                ))}
                <TableHead>Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(q.data?.rows ?? []).map((r) => (
                <TableRow key={r.studentId}>
                  <TableCell className="font-mono text-xs">{r.rank ?? "—"}</TableCell>
                  <TableCell className="font-medium">{r.name}</TableCell>
                  <TableCell className="font-mono text-xs">{r.studentCode}</TableCell>
                  {(q.data?.rounds ?? []).map((rd) => (
                    <TableCell key={rd.id} className="font-mono text-xs">
                      {r.perRound[rd.id] ?? 0}
                    </TableCell>
                  ))}
                  <TableCell className="font-mono text-xs font-semibold">
                    {r.total}
                    <span className="text-muted-foreground"> / {r.max}</span>
                  </TableCell>
                </TableRow>
              ))}
              {(q.data?.rows ?? []).length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="text-sm text-muted-foreground">
                    No scores recorded yet.
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </div>
      )}
    </AppShell>
  );
}
