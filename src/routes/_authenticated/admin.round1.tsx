import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { deleteQuestion, getAdminRounds, listQuestions, saveQuestion } from "@/lib/admin.functions";
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

export const Route = createFileRoute("/_authenticated/admin/round1")({
  head: () => ({
    meta: [
      { title: "Quiz questions — CodeArena admin" },
      { name: "description", content: "Author multiple-choice and output-prediction questions for round one." },
      { property: "og:title", content: "Quiz questions — CodeArena admin" },
      { property: "og:description", content: "Round one question bank." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: AdminRound1,
});

type Draft = {
  id?: string;
  roundId: string;
  type: "MCQ" | "OUTPUT";
  prompt: string;
  codeSnippet: string;
  expectedOutput: string;
  correctOptionKey: string;
  marks: number;
  negativeMarks: number;
  orderNo: number;
  isEnabled: boolean;
  options: { optionKey: string; optionText: string }[];
};

const KEYS = ["A", "B", "C", "D", "E", "F"];

function AdminRound1() {
  const qc = useQueryClient();
  const [roundId, setRoundId] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);

  const roundsQ = useQuery({ queryKey: ["admin-rounds"], queryFn: () => getAdminRounds() });
  const round1 = useMemo(
    () => (roundsQ.data?.rounds ?? []).filter((r) => r.type === "ROUND1"),
    [roundsQ.data],
  );
  const activeRound = roundId || round1[0]?.id || "";

  const questionsQ = useQuery({
    queryKey: ["admin-questions", activeRound],
    queryFn: () => listQuestions({ data: { roundId: activeRound } }),
    enabled: Boolean(activeRound),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ["admin-questions"] });
  const fail = (e: unknown) => toast.error(e instanceof Error ? e.message : "Something went wrong.");

  const save = useMutation({
    mutationFn: (d: Draft) =>
      saveQuestion({
        data: {
          ...(d.id ? { id: d.id } : {}),
          roundId: d.roundId,
          type: d.type,
          prompt: d.prompt,
          codeSnippet: d.codeSnippet,
          expectedOutput: d.expectedOutput,
          correctOptionKey: d.correctOptionKey,
          marks: d.marks,
          negativeMarks: d.negativeMarks,
          orderNo: d.orderNo,
          isEnabled: d.isEnabled,
          options: d.type === "MCQ" ? d.options.filter((o) => o.optionText.trim()) : [],
        },
      }),
    onSuccess: () => {
      toast.success("Question saved.");
      setDraft(null);
      void refresh();
    },
    onError: fail,
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteQuestion({ data: { id } }),
    onSuccess: (r) => {
      toast.success(r.deactivated ? "Question disabled (answers exist)." : "Question deleted.");
      void refresh();
    },
    onError: fail,
  });

  const newDraft = (): Draft => ({
    roundId: activeRound,
    type: "MCQ",
    prompt: "",
    codeSnippet: "",
    expectedOutput: "",
    correctOptionKey: "A",
    marks: 5,
    negativeMarks: 0,
    orderNo: (questionsQ.data?.length ?? 0) + 1,
    isEnabled: true,
    options: KEYS.slice(0, 4).map((k) => ({ optionKey: k, optionText: "" })),
  });

  return (
    <AppShell
      nav={ADMIN_NAV}
      title="Round 1 — quiz"
      subtitle="Multiple choice and output prediction questions."
      actions={
        <Button size="sm" disabled={!activeRound} onClick={() => setDraft(newDraft())}>
          Add question
        </Button>
      }
    >
      <div className="mb-6 max-w-xs">
        <Select value={activeRound} onValueChange={setRoundId}>
          <SelectTrigger>
            <SelectValue placeholder="Select a round" />
          </SelectTrigger>
          <SelectContent>
            {round1.map((r) => (
              <SelectItem key={r.id} value={r.id}>
                {r.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {!activeRound ? (
        <p className="text-sm text-muted-foreground">Create a round of type ROUND1 first.</p>
      ) : questionsQ.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : questionsQ.isError ? (
        <p className="text-sm text-destructive">Could not load questions.</p>
      ) : (
        <div className="space-y-3">
          {(questionsQ.data ?? []).map((q) => (
            <div key={q.id} className="surface rounded-lg border border-border/70 p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="mono-label text-muted-foreground">#{q.orderNo}</span>
                    <Badge variant="secondary">{q.type}</Badge>
                    {!q.isEnabled ? <Badge variant="outline">disabled</Badge> : null}
                  </div>
                  <p className="mt-2 text-sm">{q.prompt}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {q.marks} marks · −{q.negativeMarks} wrong ·{" "}
                    {q.type === "MCQ" ? `answer ${q.correctOptionKey}` : `expects "${q.expectedOutput}"`}
                  </p>
                </div>
                <div className="flex gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      setDraft({
                        id: q.id,
                        roundId: activeRound,
                        type: q.type === "OUTPUT" ? "OUTPUT" : "MCQ",
                        prompt: q.prompt,
                        codeSnippet: q.codeSnippet,
                        expectedOutput: q.expectedOutput,
                        correctOptionKey: q.correctOptionKey || "A",
                        marks: q.marks,
                        negativeMarks: q.negativeMarks,
                        orderNo: q.orderNo,
                        isEnabled: q.isEnabled,
                        options: q.options.length
                          ? q.options
                          : KEYS.slice(0, 4).map((k) => ({ optionKey: k, optionText: "" })),
                      })
                    }
                  >
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-destructive"
                    onClick={() => remove.mutate(q.id)}
                  >
                    Delete
                  </Button>
                </div>
              </div>
            </div>
          ))}
          {(questionsQ.data ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">No questions yet in this round.</p>
          ) : null}
        </div>
      )}

      <Dialog open={Boolean(draft)} onOpenChange={(open) => (open ? null : setDraft(null))}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{draft?.id ? "Edit question" : "New question"}</DialogTitle>
            <DialogDescription>Correct answers are stored server-side and never sent to students.</DialogDescription>
          </DialogHeader>
          {draft ? (
            <div className="grid gap-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="grid gap-2">
                  <Label>Type</Label>
                  <Select
                    value={draft.type}
                    onValueChange={(v) => setDraft({ ...draft, type: v as Draft["type"] })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="MCQ">Multiple choice</SelectItem>
                      <SelectItem value="OUTPUT">Output prediction</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="orderNo">Order</Label>
                  <Input
                    id="orderNo"
                    type="number"
                    value={draft.orderNo}
                    onChange={(e) => setDraft({ ...draft, orderNo: Number(e.target.value) })}
                  />
                </div>
              </div>

              <div className="grid gap-2">
                <Label htmlFor="prompt">Question</Label>
                <Textarea
                  id="prompt"
                  rows={3}
                  value={draft.prompt}
                  onChange={(e) => setDraft({ ...draft, prompt: e.target.value })}
                />
              </div>

              <div className="grid gap-2">
                <Label htmlFor="snippet">Code snippet (optional)</Label>
                <Textarea
                  id="snippet"
                  rows={5}
                  className="font-mono text-xs"
                  value={draft.codeSnippet}
                  onChange={(e) => setDraft({ ...draft, codeSnippet: e.target.value })}
                />
              </div>

              {draft.type === "MCQ" ? (
                <div className="grid gap-3">
                  <Label>Options</Label>
                  {draft.options.map((o, i) => (
                    <div key={o.optionKey} className="flex items-center gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant={draft.correctOptionKey === o.optionKey ? "default" : "outline"}
                        onClick={() => setDraft({ ...draft, correctOptionKey: o.optionKey })}
                      >
                        {o.optionKey}
                      </Button>
                      <Input
                        value={o.optionText}
                        placeholder={`Option ${o.optionKey}`}
                        onChange={(e) => {
                          const options = [...draft.options];
                          options[i] = { optionKey: o.optionKey, optionText: e.target.value };
                          setDraft({ ...draft, options });
                        }}
                      />
                    </div>
                  ))}
                  <p className="text-xs text-muted-foreground">
                    Tap a letter to mark it as the correct answer.
                  </p>
                </div>
              ) : (
                <div className="grid gap-2">
                  <Label htmlFor="expected">Expected output</Label>
                  <Textarea
                    id="expected"
                    rows={3}
                    className="font-mono text-xs"
                    value={draft.expectedOutput}
                    onChange={(e) => setDraft({ ...draft, expectedOutput: e.target.value })}
                  />
                </div>
              )}

              <div className="grid gap-4 sm:grid-cols-3">
                <div className="grid gap-2">
                  <Label htmlFor="marks">Marks</Label>
                  <Input
                    id="marks"
                    type="number"
                    value={draft.marks}
                    onChange={(e) => setDraft({ ...draft, marks: Number(e.target.value) })}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="neg">Negative marks</Label>
                  <Input
                    id="neg"
                    type="number"
                    value={draft.negativeMarks}
                    onChange={(e) => setDraft({ ...draft, negativeMarks: Number(e.target.value) })}
                  />
                </div>
                <div className="flex items-end gap-3">
                  <Switch
                    id="enabled"
                    checked={draft.isEnabled}
                    onCheckedChange={(v) => setDraft({ ...draft, isEnabled: v })}
                  />
                  <Label htmlFor="enabled">Enabled</Label>
                </div>
              </div>
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDraft(null)}>
              Cancel
            </Button>
            <Button disabled={save.isPending} onClick={() => draft && save.mutate(draft)}>
              {save.isPending ? "Saving…" : "Save question"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppShell>
  );
}
