import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import {
  deleteBugDefinition,
  deleteDebugProblem,
  deleteDebugTestCase,
  getRound2Results,
  getStudentRound2Detail,
  listDebugProblems,
  saveBugDefinition,
  saveDebugProblem,
  saveDebugTestCase,
  setDebugProblemActive,
} from "@/lib/admin.functions";

import { AppShell, ADMIN_NAV } from "@/components/AppShell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { formatIst } from "@/lib/datetime";

export const Route = createFileRoute("/_authenticated/admin/round2")({
  head: () => ({
    meta: [
      { title: "Bug Hunt admin — CodeArena" },
      {
        name: "description",
        content: "Create debugging problems, define bugs and review Round 2 scores.",
      },
      { property: "og:title", content: "Bug Hunt admin — CodeArena" },
      { property: "og:description", content: "Round 2 problem, bug and score management." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: AdminRound2,
});

type ProblemForm = {
  id?: string;
  roundId: string;
  title: string;
  description: string;
  language: string;
  expectedBehavior: string;
  buggyCode: string;
  publicInput: string;
  publicExpectedOutput: string;
  marks: number;
  baseMarks: number;
  timeLimitSec: number;
  memoryLimitMb: number;
  orderNo: number;
  isEnabled: boolean;
};

type BugForm = {
  id?: string;
  problemId: string;
  bugCode: string;
  title: string;
  description: string;
  marks: number;
  orderNo: number;
  isActive: boolean;
  fixPattern: string;
  mustNotMatch: string;
};

type TestForm = {
  id?: string;
  problemId: string;
  name: string;
  input: string;
  expectedOutput: string;
  isHidden: boolean;
  isEnabled: boolean;
  marks: number;
  orderNo: number;
};

const LANGUAGES = ["C", "CPP", "JAVA", "PYTHON"] as const;

const emptyProblem = (roundId: string, orderNo: number): ProblemForm => ({
  roundId,
  title: "",
  description: "",
  language: "C",
  expectedBehavior: "",
  buggyCode: "",
  publicInput: "",
  publicExpectedOutput: "",
  marks: 20,
  baseMarks: 2,
  timeLimitSec: 2,
  memoryLimitMb: 128,
  orderNo,
  isEnabled: true,
});

const emptyBug = (problemId: string, orderNo: number): BugForm => ({
  problemId,
  bugCode: "",
  title: "",
  description: "",
  marks: 5,
  orderNo,
  isActive: true,
  fixPattern: "",
  mustNotMatch: "",
});

const emptyTest = (problemId: string, orderNo: number): TestForm => ({
  problemId,
  name: `Hidden test case ${orderNo}`,
  input: "",
  expectedOutput: "",
  // Round 2 test cases are always hidden.
  isHidden: true,
  isEnabled: true,
  marks: 1,
  orderNo,
});

function AdminRound2() {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<"problems" | "scores">("problems");
  const [problemForm, setProblemForm] = useState<ProblemForm | null>(null);
  const [bugForm, setBugForm] = useState<BugForm | null>(null);
  const [testForm, setTestForm] = useState<TestForm | null>(null);
  const [problemError, setProblemError] = useState<string | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  const [inspectId, setInspectId] = useState<string | null>(null);

  const problemsQuery = useQuery({
    queryKey: ["admin-round2-problems"],
    queryFn: () => listDebugProblems(),
    refetchInterval: 20_000,
  });
  const resultsQuery = useQuery({
    queryKey: ["admin-round2-results"],
    queryFn: () => getRound2Results(),
    refetchInterval: 15_000,
    enabled: tab === "scores",
  });
  const detailQuery = useQuery({
    queryKey: ["admin-round2-detail", inspectId],
    queryFn: () => getStudentRound2Detail({ data: { studentId: inspectId! } }),
    enabled: Boolean(inspectId),
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["admin-round2-problems"] });
    queryClient.invalidateQueries({ queryKey: ["admin-round2-results"] });
  };
  const fail = (error: unknown) =>
    toast.error(error instanceof Error ? error.message : "Something went wrong.");

  const saveProblem = useMutation({
    mutationFn: (form: ProblemForm) => saveDebugProblem({ data: form }),
    onSuccess: () => {
      toast.success("Problem saved.");
      setProblemForm(null);
      refresh();
    },
    onError: fail,
  });
  const toggleProblem = useMutation({
    mutationFn: (input: { id: string; isEnabled: boolean }) => setDebugProblemActive({ data: input }),
    onSuccess: () => {
      toast.success("Problem visibility updated.");
      refresh();
    },
    onError: fail,
  });
  const saveBug = useMutation({
    mutationFn: (form: BugForm) => saveBugDefinition({ data: form }),
    onSuccess: () => {
      toast.success("Bug saved.");
      setBugForm(null);
      refresh();
    },
    onError: fail,
  });
  const removeBug = useMutation({
    mutationFn: (id: string) => deleteBugDefinition({ data: { id } }),
    onSuccess: (result) => {
      toast.success(result.deactivated ? "Bug deactivated (scores kept)." : "Bug deleted.");
      refresh();
    },
    onError: fail,
  });
  const saveTest = useMutation({
    mutationFn: (form: TestForm) => saveDebugTestCase({ data: form }),
    onSuccess: () => {
      toast.success("Test case saved.");
      setTestForm(null);
      refresh();
    },
    onError: fail,
  });
  const removeTest = useMutation({
    mutationFn: (id: string) => deleteDebugTestCase({ data: { id } }),
    onSuccess: () => {
      toast.success("Test case deleted.");
      refresh();
    },
    onError: fail,
  });
  const removeProblem = useMutation({
    mutationFn: (id: string) => deleteDebugProblem({ data: { id } }),
    onSuccess: (result) => {
      toast.success(
        result.deactivated ? "Question hidden (submissions kept)." : "Question deleted.",
      );
      refresh();
    },
    onError: fail,
  });


  const data = problemsQuery.data;
  const roundId = data?.round?.id ?? "";

  /** Live client-side mirror of the server rule: base + enabled test marks <= max. */
  const MARK_ERROR = "Base marks + test case marks cannot exceed maximum marks.";
  const enabledTestMarks = (problemId: string, excludeTestId?: string) =>
    (data?.problems.find((p) => p.id === problemId)?.tests ?? [])
      .filter((t) => t.isEnabled && t.id !== excludeTestId)
      .reduce((sum, t) => sum + t.marks, 0);

  const submitProblem = (form: ProblemForm) => {
    // Field-level validation; nothing already typed is ever discarded.
    const problems: string[] = [];
    if (form.title.trim().length < 2) problems.push("Problem title is required.");
    if (!form.description.trim()) problems.push("Problem description is required.");
    if (!form.buggyCode.trim()) problems.push("Buggy code is required.");
    if (!form.language.trim()) problems.push("Language is required.");
    if (!Number.isFinite(form.marks) || form.marks < 1) problems.push("Maximum marks must be at least 1.");
    if (!Number.isFinite(form.baseMarks) || form.baseMarks < 0) problems.push("Base marks must be 0 or more.");
    else if (form.baseMarks > form.marks) problems.push("Base marks cannot exceed maximum marks.");
    const configured = form.id ? enabledTestMarks(form.id) : 0;
    if (form.baseMarks + configured > form.marks) problems.push(MARK_ERROR);
    if (problems.length) {
      setProblemError(problems[0]!);
      toast.error(problems[0]!);
      return;
    }
    setProblemError(null);
    saveProblem.mutate(form);
  };
  const submitTest = (form: TestForm) => {
    const problem = data?.problems.find((p) => p.id === form.problemId);
    const configured = enabledTestMarks(form.problemId, form.id);
    const total = (problem?.baseMarks ?? 0) + configured + (form.isEnabled ? form.marks : 0);
    if (!form.expectedOutput.trim()) {
      setTestError("Expected output is required.");
      return;
    }
    if (!Number.isFinite(form.marks) || form.marks < 1) {
      setTestError("Test case marks must be at least 1.");
      return;
    }
    if (problem && total > problem.marks) {
      setTestError(MARK_ERROR);
      toast.error(MARK_ERROR);
      return;
    }
    setTestError(null);
    saveTest.mutate(form);
  };

  return (
    <AppShell
      nav={ADMIN_NAV}
      title="Round 2 — Bug Hunt"
      subtitle="Debugging problems, bug definitions and live scores."
    >
      <div className="flex gap-2">
        <Button variant={tab === "problems" ? "default" : "secondary"} onClick={() => setTab("problems")}>
          Problems &amp; bugs
        </Button>
        <Button variant={tab === "scores" ? "default" : "secondary"} onClick={() => setTab("scores")}>
          Scores
        </Button>
      </div>

      {tab === "problems" ? (
        problemsQuery.isLoading ? (
          <Skeleton className="mt-6 h-64 w-full" />
        ) : problemsQuery.isError || !data ? (
          <p className="mt-6 text-sm text-destructive">
            {problemsQuery.error instanceof Error
              ? problemsQuery.error.message
              : "Could not load Round 2 data."}
          </p>
        ) : !data.round ? (
          <p className="mt-6 text-sm text-muted-foreground">
            Create a Round 2 (Bug Hunt) round before adding debugging problems.
          </p>
        ) : (
          <>
            <div className="mt-6 grid gap-4 sm:grid-cols-4">
              {[
                ["Problems", data.stats.problems],
                ["Active", data.stats.activeProblems],
                ["Bugs", data.stats.bugs],
                ["Submissions", data.stats.submissions],
              ].map(([label, v]) => (
                <div key={String(label)} className="surface rounded-lg border border-border/70 p-5">
                  <p className="mono-label text-muted-foreground">{String(label)}</p>
                  <p className="mt-3 font-mono text-2xl font-bold">{Number(v)}</p>
                </div>
              ))}
            </div>

            <div className="mt-6">
              <Button onClick={() => setProblemForm(emptyProblem(roundId, data.problems.length + 1))}>
                New problem
              </Button>
            </div>

            {problemForm ? (
              <ProblemEditor
                form={problemForm}
                onChange={setProblemForm}
                onCancel={() => setProblemForm(null)}
                onSave={() => submitProblem(problemForm)}
                saving={saveProblem.isPending}
                configuredTestMarks={problemForm.id ? enabledTestMarks(problemForm.id) : 0}
                error={problemError}
              />
            ) : null}

            <div className="mt-6 space-y-4">
              {data.problems.map((p) => (
                <div key={p.id} className="surface rounded-lg border border-border/70 p-5">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium">
                        {p.orderNo}. {p.title}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {p.language} · {p.marks} marks (base {p.baseMarks}) · configured{" "}
                        {p.baseMarks + p.tests.filter((t) => t.isEnabled).reduce((sum, t) => sum + t.marks, 0)}/
                        {p.marks} · {p.tests.length} test cases (
                        {p.tests.filter((t) => t.isHidden).length} hidden) ·{" "}
                        {p.bugs.filter((b) => b.isActive).length} bugs · {p.submissions} submissions
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant={p.isEnabled ? "default" : "secondary"}>
                        {p.isEnabled ? "Visible" : "Hidden"}
                      </Badge>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => setProblemForm({ ...p })}
                      >
                        Edit
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => toggleProblem.mutate({ id: p.id, isEnabled: !p.isEnabled })}
                      >
                        {p.isEnabled ? "Hide" : "Show"}
                      </Button>
                      <Button
                        size="sm"
                        onClick={() => {
                          setTestError(null);
                          setTestForm(emptyTest(p.id, p.tests.length + 1));
                        }}
                      >
                        + Add hidden test case
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => setBugForm(emptyBug(p.id, p.bugs.length + 1))}
                      >
                        Add bug
                      </Button>
                      <Button
                        size="sm"
                        variant="destructive"
                        onClick={() => removeProblem.mutate(p.id)}
                      >
                        Delete
                      </Button>
                    </div>
                  </div>

                  <div className="mt-4 space-y-2">
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      Hidden test cases (optional) · total configured{" "}
                      {p.baseMarks +
                        p.tests.filter((t) => t.isEnabled).reduce((s, t) => s + t.marks, 0)}
                      /{p.marks}
                    </p>
                    {p.tests.map((t) => (
                      <div
                        key={t.id}
                        className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border/60 px-4 py-2"
                      >
                        <div className="min-w-0">
                          <p className="truncate text-sm">
                            {t.orderNo}. {t.name || `Test case ${t.orderNo}`} · input:{" "}
                            {t.input.replace(/\n/g, "⏎") || "—"}
                          </p>
                          <p className="truncate font-mono text-xs text-muted-foreground">
                            expected: {t.expectedOutput.replace(/\n/g, "⏎") || "—"} · {t.marks} marks
                          </p>
                        </div>
                        <div className="flex items-center gap-2">
                          <Badge variant="secondary">Hidden</Badge>
                          {!t.isEnabled ? <Badge variant="secondary">Disabled</Badge> : null}
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => setTestForm({ ...t, problemId: p.id })}
                          >
                            Edit
                          </Button>
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => removeTest.mutate(t.id)}
                          >
                            Remove
                          </Button>
                        </div>
                      </div>
                    ))}
                    {p.tests.length === 0 ? (
                      <p className="text-sm text-muted-foreground">
                        No hidden test cases — optional. Base marks are still awarded from the
                        public input/expected output.
                      </p>
                    ) : null}
                  </div>

                  <div className="mt-4 space-y-2">
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      Bug definitions (optional bonus marks)
                    </p>
                    {p.bugs.map((b) => (
                      <div
                        key={b.id}
                        className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border/60 px-4 py-2"
                      >
                        <div className="min-w-0">
                          <p className="truncate text-sm">
                            {b.orderNo}. {b.bugCode} · {b.title}
                          </p>
                          <p className="truncate font-mono text-xs text-muted-foreground">
                            {b.marks} marks · match: {b.fixPattern || "—"} · forbid: {b.mustNotMatch || "—"}
                          </p>
                        </div>
                        <div className="flex items-center gap-2">
                          {!b.isActive ? <Badge variant="secondary">Inactive</Badge> : null}
                          <Button size="sm" variant="secondary" onClick={() => setBugForm({ ...b, problemId: p.id })}>
                            Edit
                          </Button>
                          <Button size="sm" variant="secondary" onClick={() => removeBug.mutate(b.id)}>
                            Remove
                          </Button>
                        </div>
                      </div>
                    ))}
                    {p.bugs.length === 0 ? (
                      <p className="text-sm text-muted-foreground">No bugs defined.</p>
                    ) : null}
                  </div>

                </div>
              ))}
              {data.problems.length === 0 ? (
                <p className="text-sm text-muted-foreground">No debugging problems yet.</p>
              ) : null}
            </div>

            {testForm ? (
              <TestCaseEditor
                form={testForm}
                onChange={setTestForm}
                onCancel={() => {
                  setTestForm(null);
                  setTestError(null);
                }}
                onSave={() => submitTest(testForm)}
                saving={saveTest.isPending}
                error={testError}
              />
            ) : null}


            {bugForm ? (
              <BugEditor
                form={bugForm}
                onChange={setBugForm}
                onCancel={() => setBugForm(null)}
                onSave={() => saveBug.mutate(bugForm)}
                saving={saveBug.isPending}
              />
            ) : null}
          </>
        )
      ) : resultsQuery.isLoading ? (
        <Skeleton className="mt-6 h-64 w-full" />
      ) : resultsQuery.isError || !resultsQuery.data ? (
        <p className="mt-6 text-sm text-destructive">
          {resultsQuery.error instanceof Error ? resultsQuery.error.message : "Could not load scores."}
        </p>
      ) : (
        <>
          <p className="mt-6 text-sm text-muted-foreground">
            {resultsQuery.data.round?.name ?? "Round 2"} · {resultsQuery.data.totalBugs} active bugs
          </p>
          <div className="mt-4 space-y-2">
            {resultsQuery.data.rows.map((r) => (
              <div
                key={r.studentId}
                className="surface flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/70 px-5 py-3"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">
                    {r.name} <span className="text-muted-foreground">{r.code}</span>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {r.batch || "—"} · {r.bugsFixed}/{resultsQuery.data.totalBugs} bugs ·{" "}
                    {r.submittedAt ? formatIst(r.submittedAt) : "not submitted"}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <Badge variant={r.status === "SUBMITTED" ? "default" : "secondary"}>{r.status}</Badge>
                  <span className="font-mono text-sm">
                    {r.score}/{r.maxMarks}
                  </span>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => setInspectId(inspectId === r.studentId ? null : r.studentId)}
                  >
                    {inspectId === r.studentId ? "Close" : "Inspect"}
                  </Button>
                </div>
              </div>
            ))}
            {resultsQuery.data.rows.length === 0 ? (
              <p className="text-sm text-muted-foreground">No students yet.</p>
            ) : null}
          </div>

          {inspectId ? (
            <div className="surface mt-6 rounded-lg border border-border/70 p-5">
              <h2 className="text-sm font-semibold">Student detail</h2>
              {detailQuery.isLoading ? (
                <Skeleton className="mt-4 h-32 w-full" />
              ) : (
                <>
                  <div className="mt-4 space-y-1">
                    {(detailQuery.data?.bugs ?? []).map((b) => (
                      <p key={b.id} className="text-xs">
                        <span className="font-mono">{b.bugCode}</span> · {b.problem} · {b.title} ·{" "}
                        {b.awarded ? `awarded ${b.marksAwarded}` : "not fixed"}
                      </p>
                    ))}
                  </div>
                  <div className="mt-4 space-y-1">
                    {(detailQuery.data?.submissions ?? []).map((s) => (
                      <p key={s.id} className="text-xs text-muted-foreground">
                        {formatIst(s.createdAt)} · {s.problem} · +{s.score} · {s.message}
                      </p>
                    ))}
                  </div>
                </>
              )}
            </div>
          ) : null}
        </>
      )}
    </AppShell>
  );
}

/** Creates or edits one Round 2 hidden test case. */
function TestCaseEditor({
  form,
  onChange,
  onCancel,
  onSave,
  saving,
  error,
}: {
  form: TestForm;
  onChange: (f: TestForm) => void;
  onCancel: () => void;
  onSave: () => void;
  saving: boolean;
  error: string | null;
}) {
  return (
    <div className="surface mt-6 space-y-4 rounded-lg border border-border/70 p-5">
      <h2 className="text-sm font-semibold">
        {form.id ? "Edit hidden test case" : "New hidden test case"}
      </h2>
      <div>
        <Label>Test case name</Label>
        <Input value={form.name} onChange={(e) => onChange({ ...form, name: e.target.value })} />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <Label>Input (stdin)</Label>
          <Textarea
            className="min-h-28 font-mono text-xs"
            value={form.input}
            onChange={(e) => onChange({ ...form, input: e.target.value })}
          />
        </div>
        <div>
          <Label>Expected output</Label>
          <Textarea
            className="min-h-28 font-mono text-xs"
            value={form.expectedOutput}
            onChange={(e) => onChange({ ...form, expectedOutput: e.target.value })}
          />
        </div>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <div>
          <Label>Marks</Label>
          <Input
            type="number"
            value={form.marks}
            onChange={(e) => onChange({ ...form, marks: Number(e.target.value) })}
          />
        </div>
        <div>
          <Label>Order</Label>
          <Input
            type="number"
            value={form.orderNo}
            onChange={(e) => onChange({ ...form, orderNo: Number(e.target.value) })}
          />
        </div>
        <div>
          <Label>State</Label>
          <select
            className="mt-1 h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
            value={form.isEnabled ? "enabled" : "disabled"}
            onChange={(e) => onChange({ ...form, isEnabled: e.target.value === "enabled" })}
          >
            <option value="enabled">Enabled</option>
            <option value="disabled">Disabled</option>
          </select>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Hidden — inputs and expected output are never shown to students.
      </p>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <div className="flex gap-2">
        <Button onClick={onSave} disabled={saving}>
          {saving ? "Saving…" : "Save test case"}
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}


function ProblemEditor({
  form,
  onChange,
  onCancel,
  onSave,
  saving,
  configuredTestMarks,
  error,
}: {
  form: ProblemForm;
  onChange: (f: ProblemForm) => void;
  onCancel: () => void;
  onSave: () => void;
  saving: boolean;
  configuredTestMarks: number;
  error: string | null;
}) {
  return (
    <div className="surface mt-6 space-y-4 rounded-lg border border-border/70 p-5">
      <h2 className="text-sm font-semibold">{form.id ? "Edit problem" : "New problem"}</h2>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <Label>Title</Label>
          <Input value={form.title} onChange={(e) => onChange({ ...form, title: e.target.value })} />
        </div>
        <div className="grid grid-cols-5 gap-2">
          <div>
            <Label>Max marks</Label>
            <Input
              type="number"
              value={form.marks}
              onChange={(e) => onChange({ ...form, marks: Number(e.target.value) })}
            />
          </div>
          <div>
            <Label>Base marks</Label>
            <Input
              type="number"
              value={form.baseMarks}
              onChange={(e) => onChange({ ...form, baseMarks: Number(e.target.value) })}
            />
          </div>
          <div>
            <Label>Order</Label>
            <Input
              type="number"
              value={form.orderNo}
              onChange={(e) => onChange({ ...form, orderNo: Number(e.target.value) })}
            />
          </div>
          <div>
            <Label>Time (s)</Label>
            <Input
              type="number"
              value={form.timeLimitSec}
              onChange={(e) => onChange({ ...form, timeLimitSec: Number(e.target.value) })}
            />
          </div>
          <div>
            <Label>Mem (MB)</Label>
            <Input
              type="number"
              value={form.memoryLimitMb}
              onChange={(e) => onChange({ ...form, memoryLimitMb: Number(e.target.value) })}
            />
          </div>
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-4">
        <div>
          <Label>Language</Label>
          <select
            className="mt-1 h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
            value={form.language}
            onChange={(e) => onChange({ ...form, language: e.target.value })}
          >
            {LANGUAGES.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </div>
        <div className="sm:col-span-3">
          <Label>Expected behaviour (what the fixed program must do)</Label>
          <Textarea
            value={form.expectedBehavior}
            onChange={(e) => onChange({ ...form, expectedBehavior: e.target.value })}
          />
        </div>
      </div>
      <div>
        <Label>Description</Label>
        <Textarea
          value={form.description}
          onChange={(e) => onChange({ ...form, description: e.target.value })}
        />
      </div>

      <div>
        <Label>Buggy code (shown to students)</Label>
        <Textarea
          className="min-h-40 font-mono text-xs"
          value={form.buggyCode}
          onChange={(e) => onChange({ ...form, buggyCode: e.target.value })}
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <Label>Public input (shown to students)</Label>
          <Textarea
            className="min-h-24 font-mono text-xs"
            placeholder={"10 20"}
            value={form.publicInput}
            onChange={(e) => onChange({ ...form, publicInput: e.target.value })}
          />
        </div>
        <div>
          <Label>Public expected output (base marks check)</Label>
          <Textarea
            className="min-h-24 font-mono text-xs"
            placeholder={"30"}
            value={form.publicExpectedOutput}
            onChange={(e) => onChange({ ...form, publicExpectedOutput: e.target.value })}
          />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Total configured marks: {form.baseMarks} base + {configuredTestMarks} hidden test ={" "}
        <span className="font-mono">
          {form.baseMarks + configuredTestMarks}/{form.marks}
        </span>
      </p>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <div className="flex gap-2">
        <Button onClick={onSave} disabled={saving}>
          {saving ? "Saving…" : "Save problem"}
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function BugEditor({
  form,
  onChange,
  onCancel,
  onSave,
  saving,
}: {
  form: BugForm;
  onChange: (f: BugForm) => void;
  onCancel: () => void;
  onSave: () => void;
  saving: boolean;
}) {
  return (
    <div className="surface mt-6 space-y-4 rounded-lg border border-border/70 p-5">
      <h2 className="text-sm font-semibold">{form.id ? "Edit bug" : "New bug"}</h2>
      <div className="grid gap-4 sm:grid-cols-4">
        <div>
          <Label>Bug code</Label>
          <Input value={form.bugCode} onChange={(e) => onChange({ ...form, bugCode: e.target.value })} />
        </div>
        <div className="sm:col-span-2">
          <Label>Title</Label>
          <Input value={form.title} onChange={(e) => onChange({ ...form, title: e.target.value })} />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <Label>Marks</Label>
            <Input
              type="number"
              value={form.marks}
              onChange={(e) => onChange({ ...form, marks: Number(e.target.value) })}
            />
          </div>
          <div>
            <Label>Order</Label>
            <Input
              type="number"
              value={form.orderNo}
              onChange={(e) => onChange({ ...form, orderNo: Number(e.target.value) })}
            />
          </div>
        </div>
      </div>
      <div>
        <Label>Hint shown to students</Label>
        <Input
          value={form.description}
          onChange={(e) => onChange({ ...form, description: e.target.value })}
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <Label>Fixed code must match (regex)</Label>
          <Input
            className="font-mono text-xs"
            value={form.fixPattern}
            onChange={(e) => onChange({ ...form, fixPattern: e.target.value })}
          />
        </div>
        <div>
          <Label>Fixed code must NOT match (regex)</Label>
          <Input
            className="font-mono text-xs"
            value={form.mustNotMatch}
            onChange={(e) => onChange({ ...form, mustNotMatch: e.target.value })}
          />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={onSave} disabled={saving}>
          {saving ? "Saving…" : "Save bug"}
        </Button>
        <Button variant="secondary" onClick={() => onChange({ ...form, isActive: !form.isActive })}>
          {form.isActive ? "Mark inactive" : "Mark active"}
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
