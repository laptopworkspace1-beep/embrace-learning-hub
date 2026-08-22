import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { listSubmissions } from "@/lib/admin.functions";
import { getSubmissionDetail } from "@/lib/admin-manage.functions";
import { AppShell, ADMIN_NAV } from "@/components/AppShell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { formatIst } from "@/lib/datetime";

export const Route = createFileRoute("/_authenticated/admin/submissions")({
  head: () => ({
    meta: [
      { title: "Submissions — CodeArena admin" },
      { name: "description", content: "Inspect every code and debugging submission with its score breakdown." },
      { property: "og:title", content: "Submissions — CodeArena admin" },
      { property: "og:description", content: "Submission inspection for judges." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: AdminSubmissions,
});

type Kind = "code" | "debug";

function AdminSubmissions() {
  const [kind, setKind] = useState<Kind>("code");
  const [open, setOpen] = useState<{ kind: Kind; id: string } | null>(null);

  const q = useQuery({
    queryKey: ["admin-submissions", kind],
    queryFn: () => listSubmissions({ data: { kind } }),
    refetchInterval: 20_000,
  });

  const detail = useQuery({
    queryKey: ["submission-detail", open?.kind, open?.id],
    queryFn: () => getSubmissionDetail({ data: { kind: open!.kind, id: open!.id } }),
    enabled: Boolean(open),
  });

  return (
    <AppShell nav={ADMIN_NAV} title="Submissions" subtitle="Live feed of everything students send in.">
      <Tabs value={kind} onValueChange={(v) => setKind(v as Kind)} className="mb-6">
        <TabsList>
          <TabsTrigger value="code">Code sprint</TabsTrigger>
          <TabsTrigger value="debug">Bug hunt</TabsTrigger>
        </TabsList>
      </Tabs>

      {q.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : q.isError ? (
        <p className="text-sm text-destructive">Could not load submissions.</p>
      ) : (
        <div className="surface overflow-x-auto rounded-lg border border-border/70">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Student</TableHead>
                <TableHead>Problem</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Language</TableHead>
                <TableHead>Tests</TableHead>
                <TableHead>Score</TableHead>
                <TableHead>When</TableHead>
                <TableHead className="text-right">Detail</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(q.data ?? []).map((s) => (
                <TableRow key={s.id}>
                  <TableCell className="font-medium">{s.student}</TableCell>
                  <TableCell>{s.problem}</TableCell>
                  <TableCell>
                    <Badge variant={s.status === "ACCEPTED" ? "default" : "secondary"}>{s.status}</Badge>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{s.language}</TableCell>
                  <TableCell className="font-mono text-xs">
                    {s.totalTests ? `${s.passedTests}/${s.totalTests}` : "—"}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{s.score}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {formatIst(s.createdAt)}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button size="sm" variant="ghost" onClick={() => setOpen({ kind, id: s.id })}>
                      View
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {(q.data ?? []).length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="text-sm text-muted-foreground">
                    Nothing submitted yet.
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </div>
      )}

      <Dialog open={Boolean(open)} onOpenChange={(o) => (o ? null : setOpen(null))}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Submission detail</DialogTitle>
          </DialogHeader>
          {detail.isLoading ? (
            <Skeleton className="h-40 w-full" />
          ) : detail.isError ? (
            <p className="text-sm text-destructive">Could not load this submission.</p>
          ) : detail.data ? (
            <div className="space-y-4">
              <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
                {[
                  ["Student", `${detail.data.studentName} (${detail.data.studentCode})`],
                  ["Round", detail.data.kind === "debug" ? "Round 2 — Bug Hunt" : "Round 3 — Code Sprint"],
                  ["Problem", detail.data.problemTitle],
                  ["Language", detail.data.language],
                  ["Submitted", formatIst(detail.data.submittedAt)],
                  ["Execution status", detail.data.status],
                  ["Score", `${detail.data.score}/${detail.data.maxMarks}`],
                  ["Tests", detail.data.totalTests ? `${detail.data.passedTests}/${detail.data.totalTests}` : "—"],
                ].map(([label, value]) => (
                  <div key={label}>
                    <dt className="mono-label text-muted-foreground">{label}</dt>
                    <dd className="mt-1 break-words">{value}</dd>
                  </div>
                ))}
              </dl>

              {detail.data.breakdown ? (
                <div className="rounded-md border border-border/70 p-4">
                  <p className="text-sm font-semibold">Round 2 scoring breakdown</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Maximum marks: {detail.data.breakdown.maxMarks}
                  </p>
                  <ul className="mt-3 space-y-1 font-mono text-xs">
                    <li>
                      Base: {detail.data.breakdown.baseScore}/{detail.data.breakdown.baseMarks} ·{" "}
                      {detail.data.breakdown.basePassed ? "PASS" : "FAIL"}
                    </li>
                    {detail.data.breakdown.testCases.map((t, i) => (
                      <li key={t.testCaseId || i}>
                        {t.name || `Test case ${i + 1}`} {t.hidden ? "(hidden)" : "(public)"}: {t.status}{" "}
                        {t.marksAwarded}/{t.marks}
                      </li>
                    ))}
                    <li className="pt-1 font-semibold">
                      Final: {detail.data.breakdown.totalScore}/{detail.data.breakdown.maxMarks}
                    </li>
                  </ul>
                </div>
              ) : null}

              <div>
                <p className="mono-label text-muted-foreground">Source code (exactly as submitted)</p>
                <pre className="mt-2 max-h-[45vh] overflow-auto whitespace-pre rounded-md bg-muted p-4 font-mono text-xs">
                  {detail.data.sourceCode}
                </pre>
              </div>

              {detail.data.message ? (
                <p className="text-xs text-muted-foreground">{detail.data.message}</p>
              ) : null}
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </AppShell>
  );
}
