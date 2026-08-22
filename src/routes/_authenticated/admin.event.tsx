import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { controlRound, setResultsVisibility } from "@/lib/admin.functions";
import { controlEvent, getEventControl } from "@/lib/admin-manage.functions";
import { AppShell, ADMIN_NAV } from "@/components/AppShell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
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

export const Route = createFileRoute("/_authenticated/admin/event")({
  head: () => ({
    meta: [
      { title: "Event control — CodeArena admin" },
      { name: "description", content: "Start, pause and end the event and each individual round." },
      { property: "og:title", content: "Event control — CodeArena admin" },
      { property: "og:description", content: "Live competition control room." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: AdminEvent,
});

type EventAction = "start" | "emergency_pause" | "resume" | "end";

function AdminEvent() {
  const qc = useQueryClient();
  const [pending, setPending] = useState<
    | { kind: "event"; action: EventAction; label: string; body: string }
    | { kind: "round"; roundId: string; action: "reset" | "end"; label: string; body: string }
    | null
  >(null);

  const q = useQuery({
    queryKey: ["event-control"],
    queryFn: () => getEventControl(),
    refetchInterval: 10_000,
  });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["event-control"] });
    void qc.invalidateQueries({ queryKey: ["admin-rounds"] });
  };
  const fail = (e: unknown) => toast.error(e instanceof Error ? e.message : "Something went wrong.");

  const evt = useMutation({
    mutationFn: (action: EventAction) => controlEvent({ data: { action } }),
    onSuccess: () => {
      toast.success("Event updated.");
      setPending(null);
      refresh();
    },
    onError: fail,
  });

  const round = useMutation({
    mutationFn: (v: { roundId: string; action: "start" | "pause" | "resume" | "end" | "reset" }) =>
      controlRound({ data: v }),
    onSuccess: () => {
      toast.success("Round updated.");
      setPending(null);
      refresh();
    },
    onError: fail,
  });

  const visibility = useMutation({
    mutationFn: (v: { showResults: boolean; showAnswers: boolean }) => setResultsVisibility({ data: v }),
    onSuccess: () => {
      toast.success("Visibility updated.");
      refresh();
    },
    onError: fail,
  });

  const data = q.data;

  return (
    <AppShell nav={ADMIN_NAV} title="Event control" subtitle="Everything here changes the live competition.">
      {q.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : q.isError ? (
        <p className="text-sm text-destructive">
          {q.error instanceof Error ? q.error.message : "Could not load event control."}
        </p>
      ) : (
        <>
          <div className="surface rounded-lg border border-border/70 p-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-sm font-semibold">{data?.event?.title ?? "No event"}</p>
                <p className="text-xs text-muted-foreground">Event-wide lifecycle</p>
              </div>
              <Badge variant={data?.event?.status === "LIVE" ? "default" : "secondary"}>
                {data?.event?.status ?? "—"}
              </Badge>
            </div>
            <div className="mt-5 flex flex-wrap gap-2">
              <Button size="sm" disabled={evt.isPending} onClick={() => evt.mutate("start")}>
                Start event
              </Button>
              <Button
                size="sm"
                variant="destructive"
                onClick={() =>
                  setPending({
                    kind: "event",
                    action: "emergency_pause",
                    label: "Emergency pause the whole event?",
                    body: "Every live round is paused and all clocks freeze. Students cannot submit until you resume.",
                  })
                }
              >
                Emergency pause all
              </Button>
              <Button size="sm" variant="outline" disabled={evt.isPending} onClick={() => evt.mutate("resume")}>
                Resume event
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  setPending({
                    kind: "event",
                    action: "end",
                    label: "End the event?",
                    body: "All rounds are ended, remaining attempts are auto-submitted and scored, then everything locks.",
                  })
                }
              >
                End event
              </Button>
            </div>
          </div>

          <div className="surface mt-6 rounded-lg border border-border/70 p-6">
            <p className="text-sm font-semibold">Result visibility</p>
            <p className="mt-1 text-xs text-muted-foreground">
              The server hides scores and correct answers from students until you enable them here.
            </p>
            <div className="mt-4 flex flex-wrap gap-8">
              <div className="flex items-center gap-3">
                <Switch
                  id="showResults"
                  checked={Boolean(data?.visibility.showResults)}
                  onCheckedChange={(v) =>
                    visibility.mutate({
                      showResults: v,
                      showAnswers: Boolean(data?.visibility.showAnswers),
                    })
                  }
                />
                <Label htmlFor="showResults">Show scores to students</Label>
              </div>
              <div className="flex items-center gap-3">
                <Switch
                  id="showAnswers"
                  checked={Boolean(data?.visibility.showAnswers)}
                  onCheckedChange={(v) =>
                    visibility.mutate({
                      showResults: Boolean(data?.visibility.showResults),
                      showAnswers: v,
                    })
                  }
                />
                <Label htmlFor="showAnswers">Show correct answers</Label>
              </div>
            </div>
          </div>

          <h2 className="mt-10 text-lg font-semibold">Rounds</h2>
          <div className="mt-4 space-y-3">
            {(data?.rounds ?? []).map((r) => (
              <div key={r.id} className="surface rounded-lg border border-border/70 p-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium">
                      #{r.orderNo} · {r.name}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {r.type} · {r.durationMinutes} min · {r.maxMarks} marks
                    </p>
                  </div>
                  <Badge variant={r.state === "LIVE" ? "default" : "secondary"}>{r.state}</Badge>
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    disabled={r.state === "LIVE" || round.isPending}
                    onClick={() => round.mutate({ roundId: r.id, action: "start" })}
                  >
                    Start
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={r.state !== "LIVE" || round.isPending}
                    onClick={() => round.mutate({ roundId: r.id, action: "pause" })}
                  >
                    Pause
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={r.state !== "PAUSED" || round.isPending}
                    onClick={() => round.mutate({ roundId: r.id, action: "resume" })}
                  >
                    Resume
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      setPending({
                        kind: "round",
                        roundId: r.id,
                        action: "reset",
                        label: `Restart the ${r.name} timer?`,
                        body: "Every student in this round gets a brand new deadline. Progress is kept, the clock is not.",
                      })
                    }
                  >
                    Restart timer
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={r.state === "ENDED"}
                    onClick={() =>
                      setPending({
                        kind: "round",
                        roundId: r.id,
                        action: "end",
                        label: `End ${r.name}?`,
                        body: "Open attempts are auto-submitted and scored, then the round locks for everyone.",
                      })
                    }
                  >
                    End round
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      <AlertDialog open={Boolean(pending)} onOpenChange={(open) => (open ? null : setPending(null))}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{pending?.label}</AlertDialogTitle>
            <AlertDialogDescription>{pending?.body}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (!pending) return;
                if (pending.kind === "event") evt.mutate(pending.action);
                else round.mutate({ roundId: pending.roundId, action: pending.action });
              }}
            >
              Confirm
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AppShell>
  );
}
