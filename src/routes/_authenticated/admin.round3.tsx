import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
  deleteTestCase,
  deleteCodeProblem,
  getAdminRounds,
  listCodeProblems,
  saveCodeProblem,
  saveTestCase,
} from "@/lib/admin.functions";
import { AppShell, ADMIN_NAV } from "@/components/AppShell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export const Route = createFileRoute("/_authenticated/admin/round3")({
  head: () => ({
    meta: [
      { title: "Code sprint problems — CodeArena admin" },
      { name: "description", content: "Author programming problems and their test cases for round three." },
      { property: "og:title", content: "Code sprint problems — CodeArena admin" },
      { property: "og:description", content: "Round three problem bank and test cases." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: AdminRound3,
});

type ProblemDraft = {
  id?: string;
  roundId: string;
  title: string;
  description: string;
  inputFormat: string;
  outputFormat: string;
  constraints: string;
  examples: string;
  starterCode: string;
  marks: number;
  timeLimitSec: number;
  memoryLimitMb: number;
  orderNo: number;
  isEnabled: boolean;
};

type TestDraft = {
  id?: string;
  problemId: string;
  input: string;
  expectedOutput: string;
  isHidden: boolean;
  marks: number;
  orderNo: number;
};

function AdminRound3() {
  const qc = useQueryClient();
  const [problemDraft, setProblemDraft] = useState<ProblemDraft | null>(null);
  const [testDraft, setTestDraft] = useState<TestDraft | null>(null);

  const roundsQ = useQuery({ queryKey: ["admin-rounds"], queryFn: () => getAdminRounds() });
  const round3 = useMemo(
    () => (roundsQ.data?.rounds ?? []).filter((r) => r.type === "ROUND3"),
    [roundsQ.data],
  );
  const problemsQ = useQuery({ queryKey: ["admin-code-problems"], queryFn: () => listCodeProblems() });
  const refresh = () => qc.invalidateQueries({ queryKey: ["admin-code-problems"] });
  const fail = (e: unknown) => toast.error(e instanceof Error ? e.message : "Something went wrong.");

  const saveProblem = useMutation({
    mutationFn: (d: ProblemDraft) => saveCodeProblem({ data: { ...(d.id ? { id: d.id } : {}), ...d } }),
    onSuccess: () => {
      toast.success("Problem saved.");
      setProblemDraft(null);
      void refresh();
    },
    onError: fail,
  });

  const saveTest = useMutation({
    mutationFn: (d: TestDraft) => saveTestCase({ data: { ...(d.id ? { id: d.id } : {}), ...d } }),
    onSuccess: () => {
      toast.success("Test case saved.");
      setTestDraft(null);
      void refresh();
    },
    onError: fail,
  });

  const removeTest = useMutation({
    mutationFn: (id: string) => deleteTestCase({ data: { id } }),
    onSuccess: () => {
      toast.success("Test case removed.");
      void refresh();
    },
    onError: fail,
  });

  const removeProblem = useMutation({
    mutationFn: (id: string) => deleteCodeProblem({ data: { id } }),
    onSuccess: (result) => {
      toast.success(
        result.deactivated ? "Problem disabled (submissions kept)." : "Problem deleted.",
      );
      void refresh();
    },
    onError: fail,
  });

  const newProblem = (): ProblemDraft => ({
    roundId: round3[0]?.id ?? "",
    title: "",
    description: "",
    inputFormat: "",
    outputFormat: "",
    constraints: "",
    examples: "",
    starterCode: "",
    marks: 100,
    timeLimitSec: 2,
    memoryLimitMb: 128,
    orderNo: (problemsQ.data?.length ?? 0) + 1,
    isEnabled: true,
  });

  return (
    <AppShell
      nav={ADMIN_NAV}
      title="Round 3 — code sprint"
      subtitle="Programming problems, limits and the test cases they are graded against."
      actions={
        <Button size="sm" disabled={round3.length === 0} onClick={() => setProblemDraft(newProblem())}>
          Add problem
        </Button>
      }
    >
      {round3.length === 0 ? (
        <p className="text-sm text-muted-foreground">Create a round of type ROUND3 first.</p>
      ) : problemsQ.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : problemsQ.isError ? (
        <p className="text-sm text-destructive">Could not load problems.</p>
      ) : (
        <div className="space-y-4">
          {(problemsQ.data ?? []).map((p) => (
            <div key={p.id} className="surface rounded-lg border border-border/70 p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="mono-label text-muted-foreground">#{p.orderNo}</span>
                    <p className="text-sm font-semibold">{p.title}</p>
                    {!p.isEnabled ? <Badge variant="outline">disabled</Badge> : null}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {p.marks} marks · {p.timeLimitSec}s · {p.memoryLimitMb}MB · {p.tests.length} test(s) ·{" "}
                    {p.submissions} submission(s) · {p.accepted} accepted
                  </p>
                </div>
                <div className="flex gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      setProblemDraft({
                        id: p.id,
                        roundId: p.roundId,
                        title: p.title,
                        description: p.description,
                        inputFormat: p.inputFormat,
                        outputFormat: p.outputFormat,
                        constraints: p.constraints,
                        examples: p.examples,
                        starterCode: p.starterCode,
                        marks: p.marks,
                        timeLimitSec: p.timeLimitSec,
                        memoryLimitMb: p.memoryLimitMb,
                        orderNo: p.orderNo,
                        isEnabled: p.isEnabled,
                      })
                    }
                  >
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      setTestDraft({
                        problemId: p.id,
                        input: "",
                        expectedOutput: "",
                        isHidden: true,
                        marks: 1,
                        orderNo: p.tests.length + 1,
                      })
                    }
                  >
                    Add test
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-destructive"
                    disabled={removeProblem.isPending}
                    onClick={() => {
                      if (window.confirm(`Delete "${p.title}"?`)) removeProblem.mutate(p.id);
                    }}
                  >
                    Delete
                  </Button>
                </div>
              </div>

              {p.tests.length ? (
                <ul className="mt-4 space-y-2 border-t border-border/60 pt-4">
                  {p.tests.map((t) => (
                    <li key={t.id} className="flex flex-wrap items-center gap-3 text-xs">
                      <span className="mono-label text-muted-foreground">#{t.orderNo}</span>
                      <Badge variant={t.isHidden ? "secondary" : "outline"}>
                        {t.isHidden ? "hidden" : "sample"}
                      </Badge>
                      <code className="truncate rounded bg-muted px-2 py-1">{t.input || "(no input)"}</code>
                      <span className="text-muted-foreground">→</span>
                      <code className="truncate rounded bg-muted px-2 py-1">{t.expectedOutput}</code>
                      <span className="text-muted-foreground">{t.marks} mark(s)</span>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          setTestDraft({
                            id: t.id,
                            problemId: p.id,
                            input: t.input,
                            expectedOutput: t.expectedOutput,
                            isHidden: t.isHidden,
                            marks: t.marks,
                            orderNo: t.orderNo,
                          })
                        }
                      >
                        Edit
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-destructive"
                        onClick={() => removeTest.mutate(t.id)}
                      >
                        Remove
                      </Button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-4 border-t border-border/60 pt-4 text-xs text-muted-foreground">
                  No test cases yet — submissions cannot be scored until you add at least one.
                </p>
              )}
            </div>
          ))}
        </div>
      )}

      <Dialog open={Boolean(problemDraft)} onOpenChange={(open) => (open ? null : setProblemDraft(null))}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{problemDraft?.id ? "Edit problem" : "New problem"}</DialogTitle>
            <DialogDescription>Students see everything except the hidden test cases.</DialogDescription>
          </DialogHeader>
          {problemDraft ? (
            <div className="grid gap-4">
              <div className="grid gap-2">
                <Label>Round</Label>
                <Select
                  value={problemDraft.roundId}
                  onValueChange={(v) => setProblemDraft({ ...problemDraft, roundId: v })}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select round" />
                  </SelectTrigger>
                  <SelectContent>
                    {round3.map((r) => (
                      <SelectItem key={r.id} value={r.id}>
                        {r.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="title">Title</Label>
                <Input
                  id="title"
                  value={problemDraft.title}
                  onChange={(e) => setProblemDraft({ ...problemDraft, title: e.target.value })}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="desc">Description</Label>
                <Textarea
                  id="desc"
                  rows={5}
                  value={problemDraft.description}
                  onChange={(e) => setProblemDraft({ ...problemDraft, description: e.target.value })}
                />
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="grid gap-2">
                  <Label htmlFor="inf">Input format</Label>
                  <Textarea
                    id="inf"
                    rows={3}
                    value={problemDraft.inputFormat}
                    onChange={(e) => setProblemDraft({ ...problemDraft, inputFormat: e.target.value })}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="outf">Output format</Label>
                  <Textarea
                    id="outf"
                    rows={3}
                    value={problemDraft.outputFormat}
                    onChange={(e) => setProblemDraft({ ...problemDraft, outputFormat: e.target.value })}
                  />
                </div>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="grid gap-2">
                  <Label htmlFor="cons">Constraints</Label>
                  <Textarea
                    id="cons"
                    rows={3}
                    value={problemDraft.constraints}
                    onChange={(e) => setProblemDraft({ ...problemDraft, constraints: e.target.value })}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="ex">Examples</Label>
                  <Textarea
                    id="ex"
                    rows={3}
                    value={problemDraft.examples}
                    onChange={(e) => setProblemDraft({ ...problemDraft, examples: e.target.value })}
                  />
                </div>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="starter">Starter code</Label>
                <Textarea
                  id="starter"
                  rows={5}
                  className="font-mono text-xs"
                  value={problemDraft.starterCode}
                  onChange={(e) => setProblemDraft({ ...problemDraft, starterCode: e.target.value })}
                />
              </div>
              <div className="grid gap-4 sm:grid-cols-4">
                <div className="grid gap-2">
                  <Label htmlFor="pmarks">Marks</Label>
                  <Input
                    id="pmarks"
                    type="number"
                    value={problemDraft.marks}
                    onChange={(e) => setProblemDraft({ ...problemDraft, marks: Number(e.target.value) })}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="tl">Time (s)</Label>
                  <Input
                    id="tl"
                    type="number"
                    value={problemDraft.timeLimitSec}
                    onChange={(e) =>
                      setProblemDraft({ ...problemDraft, timeLimitSec: Number(e.target.value) })
                    }
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="ml">Memory (MB)</Label>
                  <Input
                    id="ml"
                    type="number"
                    value={problemDraft.memoryLimitMb}
                    onChange={(e) =>
                      setProblemDraft({ ...problemDraft, memoryLimitMb: Number(e.target.value) })
                    }
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="pord">Order</Label>
                  <Input
                    id="pord"
                    type="number"
                    value={problemDraft.orderNo}
                    onChange={(e) => setProblemDraft({ ...problemDraft, orderNo: Number(e.target.value) })}
                  />
                </div>
              </div>
              <div className="flex items-center gap-3">
                <Switch
                  id="penabled"
                  checked={problemDraft.isEnabled}
                  onCheckedChange={(v) => setProblemDraft({ ...problemDraft, isEnabled: v })}
                />
                <Label htmlFor="penabled">Enabled</Label>
              </div>
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setProblemDraft(null)}>
              Cancel
            </Button>
            <Button
              disabled={saveProblem.isPending}
              onClick={() => problemDraft && saveProblem.mutate(problemDraft)}
            >
              {saveProblem.isPending ? "Saving…" : "Save problem"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(testDraft)} onOpenChange={(open) => (open ? null : setTestDraft(null))}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{testDraft?.id ? "Edit test case" : "New test case"}</DialogTitle>
            <DialogDescription>Hidden tests are never shown to students.</DialogDescription>
          </DialogHeader>
          {testDraft ? (
            <div className="grid gap-4">
              <div className="grid gap-2">
                <Label htmlFor="tin">Input</Label>
                <Textarea
                  id="tin"
                  rows={4}
                  className="font-mono text-xs"
                  value={testDraft.input}
                  onChange={(e) => setTestDraft({ ...testDraft, input: e.target.value })}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="tout">Expected output</Label>
                <Textarea
                  id="tout"
                  rows={4}
                  className="font-mono text-xs"
                  value={testDraft.expectedOutput}
                  onChange={(e) => setTestDraft({ ...testDraft, expectedOutput: e.target.value })}
                />
              </div>
              <div className="grid grid-cols-3 items-end gap-4">
                <div className="grid gap-2">
                  <Label htmlFor="tmarks">Marks</Label>
                  <Input
                    id="tmarks"
                    type="number"
                    value={testDraft.marks}
                    onChange={(e) => setTestDraft({ ...testDraft, marks: Number(e.target.value) })}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="tord">Order</Label>
                  <Input
                    id="tord"
                    type="number"
                    value={testDraft.orderNo}
                    onChange={(e) => setTestDraft({ ...testDraft, orderNo: Number(e.target.value) })}
                  />
                </div>
                <div className="flex items-center gap-3 pb-2">
                  <Switch
                    id="thidden"
                    checked={testDraft.isHidden}
                    onCheckedChange={(v) => setTestDraft({ ...testDraft, isHidden: v })}
                  />
                  <Label htmlFor="thidden">Hidden</Label>
                </div>
              </div>
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setTestDraft(null)}>
              Cancel
            </Button>
            <Button disabled={saveTest.isPending} onClick={() => testDraft && saveTest.mutate(testDraft)}>
              {saveTest.isPending ? "Saving…" : "Save test case"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppShell>
  );
}
