import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { getRoundPlay, saveAnswer, submitRound } from "@/lib/student.functions";
import { AppShell, STUDENT_NAV } from "@/components/AppShell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { FloatingTimer } from "@/components/FloatingTimer";
import { useProctor } from "@/hooks/use-proctor";
import { useRefetchOnChange } from "@/hooks/use-refetch-on-change";
import { useLiveSync } from "@/hooks/use-live-sync";
import { useEffect, useRef, useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

export const Route = createFileRoute("/_authenticated/rounds/$roundId")({
  head: () => ({
    meta: [
      { title: "Round — CodeArena" },
      { name: "description", content: "Answer the round questions before the timer runs out." },
      { property: "og:title", content: "Round — CodeArena" },
      { property: "og:description", content: "Live competition round on CodeArena." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: RoundPage,
});


function RoundPage() {
  const { roundId } = Route.useParams();
  const queryClient = useQueryClient();
  const [confirmFinish, setConfirmFinish] = useState(false);
  // Round 1 is paged: one question on screen at a time.
  const [current, setCurrent] = useState(0);
  // Optimistic local selections so a click paints instantly; the server save
  // happens in the background and remains the source of truth after refresh.
  const [picked, setPicked] = useState<Record<string, string>>({});
  // Fill-in-the-blank text, kept per question id (never per index) so paging
  // between questions — which unmounts the field — can never lose typing.
  const [typed, setTyped] = useState<Record<string, string>>({});

  const q = useQuery({
    queryKey: ["round-play", roundId],
    queryFn: () => getRoundPlay({ data: { roundId } }),
    // Round state, clock and status come from the 2s live sync below, which
    // also force-refetches this payload whenever either changes, so the whole
    // question set only needs a slow safety-net refresh.
    refetchInterval: 20_000,
    // A gate rejection (round not open for you) is a real answer, not a
    // transient failure — retrying it just doubled the request count.
    retry: false,
  });

  const answer = useMutation({
    mutationFn: (input: { questionId: string; optionKey?: string; answerText?: string }) =>
      saveAnswer({ data: input }),
    // No invalidation here: the local optimistic selection already paints the
    // choice, and refetching every question on each click was the single
    // heaviest request during Round 1.
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Could not save your answer."),
  });

  // Rapid A → B → C clicks collapse into one background save of the last choice,
  // so requests can never land out of order.
  const saveTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const pending = useRef<Record<string, { optionKey?: string; answerText?: string }>>({});
  const queueSave = (
    questionId: string,
    payload: { optionKey?: string; answerText?: string },
    delay = 200,
  ) => {
    const existing = saveTimers.current[questionId];
    if (existing) clearTimeout(existing);
    pending.current[questionId] = payload;
    saveTimers.current[questionId] = setTimeout(() => {
      delete pending.current[questionId];
      answer.mutate({ questionId, ...payload });
    }, delay);
  };
  /** Writes every still-debounced answer before the round is finalised. */
  const flushSaves = async () => {
    const entries = Object.entries(pending.current);
    for (const timer of Object.values(saveTimers.current)) clearTimeout(timer);
    saveTimers.current = {};
    pending.current = {};
    await Promise.all(
      entries.map(([questionId, payload]) =>
        saveAnswer({ data: { questionId, ...payload } }).catch(() => undefined),
      ),
    );
  };
  useEffect(
    () => () => {
      for (const t of Object.values(saveTimers.current)) clearTimeout(t);
    },
    [],
  );

  const finish = useMutation({
    mutationFn: async () => {
      await flushSaves();
      return submitRound({ data: { roundId } });
    },
    onSuccess: () => {
      toast.success("Round submitted.");
      queryClient.invalidateQueries({ queryKey: ["round-play", roundId] });
      queryClient.invalidateQueries({ queryKey: ["student-dashboard"] });
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Could not submit the round."),
  });

  const data = q.data;
  const sync = useLiveSync(roundId);
  const liveRound = sync.round;
  // The clock and the state are the round's, issued by the server for everyone.
  const remaining = liveRound?.remainingSeconds ?? data?.remainingSeconds ?? 0;
  const roundState = liveRound?.state ?? data?.round.state ?? "DRAFT";
  const myStatus = sync.live?.myStatus[roundId] ?? data?.status;
  const canPlay = Boolean(data?.canPlay) && roundState === "LIVE";
  const paused = roundState === "PAUSED";
  const proctor = useProctor(roundId, canPlay);
  const navigate = useNavigate();

  // Round 2 / Round 3 are problem rounds: entering the round opens the first
  // Admin-configured problem straight away, and the workspace's problem
  // navigator handles Next / Submit from there.
  const firstProblem = data?.debugProblems[0] ?? data?.codeProblems[0] ?? null;
  const problemKind: "debug" | "code" = data?.debugProblems.length ? "debug" : "code";
  const hasProblemList = Boolean(
    data && data.questions.length === 0 && (data.debugProblems.length || data.codeProblems.length),
  );
  useEffect(() => {
    if (!canPlay || !firstProblem) return;
    if (data && data.questions.length > 0) return;
    void navigate({
      to: "/problems/$problemId",
      params: { problemId: firstProblem.id },
      search: { kind: problemKind },
      replace: true,
    });
  }, [canPlay, firstProblem?.id, problemKind]);

  // Any admin action (start, pause, end, restart) or an expired clock reloads
  // the authoritative attempt immediately — no manual refresh.
  useRefetchOnChange(
    `${roundState}|${myStatus ?? ""}`,
    () => void q.refetch(),
    q.isSuccess && !sync.isLoading,
  );

  return (
    <AppShell
      nav={STUDENT_NAV}
      title={data?.round.name ?? "Round"}
      subtitle={data ? `${data.round.type} · ${data.round.maxMarks} marks` : "Loading round…"}
    >
      {q.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : q.isError ? (
        <p className="text-sm text-destructive">
          {q.error instanceof Error ? q.error.message : "Could not load this round."}
        </p>
      ) : !data ? null : !canPlay ? (
        (myStatus ?? data.status) === "SUBMITTED" || (myStatus ?? data.status) === "LOCKED" ? (
          <div className="surface rounded-lg border border-border/70 p-6">
            <Badge>Submission Successful</Badge>
            <p className="mt-3 text-sm text-muted-foreground">
              {data.round.name} has been submitted and scored on the server. It is now locked.
            </p>
            {data.nextRound ? (
              <Button asChild className="mt-4">
                <Link to="/rounds/$roundId" params={{ roundId: data.nextRound.id }}>
                  Go to {data.nextRound.name}
                </Link>
              </Button>
            ) : (
              <Button asChild className="mt-4">
                <Link to="/results">Finish Competition</Link>
              </Button>
            )}
          </div>
        ) : (
          <div className="surface rounded-lg border border-border/70 p-6">
            <Badge variant="secondary">{myStatus ?? data.status}</Badge>
            <p className="mt-3 text-sm text-muted-foreground">
              {roundState === "PAUSED"
                ? "This round is paused by the organisers. Stay on this page — your clock is frozen."
                : roundState === "ENDED"
                  ? "This round has ended."
                  : (data.gate.reason ?? "This round is not open yet.")}
            </p>
            <p className="mono-label mt-4 text-muted-foreground">Round state · {roundState}</p>
          </div>
        )
      ) : (
        <>
          <div className="surface mb-6 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/70 px-5 py-3">
            <span className="mono-label text-muted-foreground">
              Round in progress · the countdown stays on screen
            </span>
            {proctor.count > 0 ? (
              <Badge variant="secondary">{proctor.count} integrity warning(s)</Badge>
            ) : null}
            {!sync.fullscreen ? (
              <Button
                size="sm"
                variant={sync.needsFullscreen ? "destructive" : "outline"}
                onClick={proctor.requestFullscreen}
              >
                {sync.needsFullscreen ? "Fullscreen required" : "Enter fullscreen"}
              </Button>
            ) : null}
          </div>

          <FloatingTimer
            serverSeconds={remaining}
            state={roundState}
            label="Time left"
            paused={paused}
            onExpire={() => void q.refetch()}
          />

          {/* One question at a time: Previous / Next, and Submit on the last one. */}
          {data.questions.map((question, index) =>
            index !== current ? null : (
              <div
                key={question.id}
                className="surface mb-4 rounded-lg border border-border/70 p-5"
              >
                <p className="mono-label text-muted-foreground">
                  Question {index + 1} of {data.questions.length}
                </p>
                <p className="mt-2 text-sm font-medium">
                  {index + 1}. {question.prompt}
                </p>
                {question.codeSnippet ? (
                  <pre className="mt-3 overflow-x-auto rounded-md bg-muted p-3 text-xs">
                    {question.codeSnippet}
                  </pre>
                ) : null}
                {question.type === "MCQ" ? (
                  <div className="mt-4 grid gap-2">
                    {question.options.map((option) => (
                      <Button
                        key={option.key}
                        variant={
                          (picked[question.id] ?? question.selectedOptionKey) === option.key
                            ? "default"
                            : "outline"
                        }
                        className="justify-start"
                        onClick={() => {
                          setPicked((prev) => ({ ...prev, [question.id]: option.key }));
                           queueSave(question.id, { optionKey: option.key });
                        }}
                      >
                        <span className="mr-2 font-mono">{option.key}</span>
                        {option.text}
                      </Button>
                    ))}
                  </div>
                ) : (
                  <Textarea
                    className="mt-4 font-mono"
                    value={typed[question.id] ?? question.answerText ?? ""}
                    placeholder="Type the exact program output"
                    onChange={(event) => {
                      const text = event.target.value;
                      setTyped((prev) => ({ ...prev, [question.id]: text }));
                      // Autosave while typing; the local value keeps the field
                      // filled even before the save lands.
                      queueSave(question.id, { answerText: text }, 700);
                    }}
                    onBlur={(event) =>
                      queueSave(question.id, { answerText: event.target.value }, 0)
                    }
                  />
                )}
              </div>
            ),
          )}

          {data.questions.length ? (
            <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
              <Button
                variant="outline"
                disabled={current === 0}
                onClick={() => setCurrent((i) => Math.max(0, i - 1))}
              >
                Previous
              </Button>
              <div className="flex flex-wrap items-center gap-1">
                {data.questions.map((question, index) => (
                  <Button
                    key={question.id}
                    size="sm"
                    variant={index === current ? "default" : "outline"}
                    className="h-8 w-10 font-mono text-xs"
                    onClick={() => setCurrent(index)}
                  >
                    {String(index + 1).padStart(2, "0")}
                  </Button>
                ))}
              </div>
              {current < data.questions.length - 1 ? (
                <Button onClick={() => setCurrent((i) => i + 1)}>Next</Button>
              ) : (
                <Button disabled={finish.isPending} onClick={() => setConfirmFinish(true)}>
                  {finish.isPending ? "Submitting…" : `Submit ${data.round.name}`}
                </Button>
              )}
            </div>
          ) : null}

          {data.debugProblems.map((problem) => (
            <Link
              key={problem.id}
              to="/problems/$problemId"
              params={{ problemId: problem.id }}
              search={{ kind: "debug" }}
              className="surface mb-3 flex items-center justify-between rounded-lg border border-border/70 px-5 py-4"
            >
              <div>
                <p className="text-sm font-medium">{problem.title}</p>
                <p className="text-xs text-muted-foreground">
                  {problem.bugsFound} bug(s) fixed · {problem.attempts} attempt(s)
                </p>
              </div>
              <span className="font-mono text-sm">
                {problem.earned} / {problem.marks}
              </span>
            </Link>
          ))}

          {data.codeProblems.map((problem) => (
            <Link
              key={problem.id}
              to="/problems/$problemId"
              params={{ problemId: problem.id }}
              search={{ kind: "code" }}
              className="surface mb-3 flex items-center justify-between rounded-lg border border-border/70 px-5 py-4"
            >
              <div>
                <p className="text-sm font-medium">{problem.title}</p>
                <p className="text-xs text-muted-foreground">
                  {problem.attempts} attempt(s) {problem.solved ? "· solved" : ""}
                </p>
              </div>
              <span className="font-mono text-sm">
                {problem.bestScore} / {problem.marks}
              </span>
            </Link>
          ))}

          {data.questions.length === 0 ? (
            hasProblemList ? null : (
              <p className="text-sm text-destructive">
                No problems have been configured for this round.
              </p>
            )
          ) : null}

          {data.questions.length === 0 && hasProblemList ? (
            <Button
              className="mt-6"
              disabled={finish.isPending}
              onClick={() => setConfirmFinish(true)}
            >
              {finish.isPending ? "Submitting…" : `Submit ${data.round.name}`}
            </Button>
          ) : null}

          <AlertDialog open={confirmFinish} onOpenChange={setConfirmFinish}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Submit {data.round.name}?</AlertDialogTitle>
                <AlertDialogDescription>
                  Your latest answers are saved and scored on the server, then the round is locked.
                  Once submitted you cannot return to this round or change any answer.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Keep working</AlertDialogCancel>
                <AlertDialogAction onClick={() => finish.mutate()}>Submit round</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
      )}
    </AppShell>
  );
}
