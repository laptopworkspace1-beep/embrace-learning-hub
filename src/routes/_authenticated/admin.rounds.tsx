import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { controlRound, getAdminRounds, updateRound } from "@/lib/admin.functions";
import { createRound, deleteRound, duplicateRound, moveRound } from "@/lib/admin-manage.functions";
import { AppShell, ADMIN_NAV } from "@/components/AppShell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatIst } from "@/lib/datetime";

export const Route = createFileRoute("/_authenticated/admin/rounds")({
  head: () => ({
    meta: [
      { title: "Rounds — CodeArena admin" },
      { name: "description", content: "Create, order, time and run every round of the competition." },
      { property: "og:title", content: "Rounds — CodeArena admin" },
      { property: "og:description", content: "Round lifecycle control for your coding event." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: AdminRounds,
});

type RoundType = "ROUND1" | "ROUND2" | "ROUND3";
type Draft = {
  roundId?: string;
  name: string;
  type: RoundType;
  durationMinutes: number;
  maxMarks: number;
};

function AdminRounds() {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [confirm, setConfirm] = useState<{ id: string; name: string; action: "delete" | "reset" } | null>(
    null,
  );

  const q = useQuery({ queryKey: ["admin-rounds"], queryFn: () => getAdminRounds(), refetchInterval: 15_000 });
  const refresh = () => qc.invalidateQueries({ queryKey: ["admin-rounds"] });
  const fail = (e: unknown) => toast.error(e instanceof Error ? e.message : "Something went wrong.");

  const save = useMutation({
    mutationFn: (d: Draft) =>
      d.roundId
        ? updateRound({
            data: {
              roundId: d.roundId,
              name: d.name,
              durationMinutes: d.durationMinutes,
              maxMarks: d.maxMarks,
            },
          })
        : createRound({
            data: {
              name: d.name,
              type: d.type,
              durationMinutes: d.durationMinutes,
              maxMarks: d.maxMarks,
            },
          }),
    onSuccess: () => {
      toast.success("Round saved.");
      setDraft(null);
      void refresh();
    },
    onError: fail,
  });

  const lifecycle = useMutation({
    mutationFn: (v: { roundId: string; action: "start" | "pause" | "resume" | "end" | "reset" }) =>
      controlRound({ data: v }),
    onSuccess: (_r, v) => {
      toast.success(`Round ${v.action === "reset" ? "timer restarted" : v.action + "ed"}.`);
      setConfirm(null);
      void refresh();
    },
    onError: fail,
  });

  const dup = useMutation({
    mutationFn: (roundId: string) => duplicateRound({ data: { roundId } }),
    onSuccess: () => {
      toast.success("Round duplicated.");
      void refresh();
    },
    onError: fail,
  });

  const move = useMutation({
    mutationFn: (v: { roundId: string; direction: "up" | "down" }) => moveRound({ data: v }),
    onSuccess: () => void refresh(),
    onError: fail,
  });

  const remove = useMutation({
    mutationFn: (roundId: string) => deleteRound({ data: { roundId } }),
    onSuccess: () => {
      toast.success("Round deleted.");
      setConfirm(null);
      void refresh();
    },
    onError: fail,
  });

  return (
    <AppShell
      nav={ADMIN_NAV}
      title="Rounds"
      subtitle="Order, duration, marks and live state. Timers are owned by the server."
      actions={
        <Button
          size="sm"
          onClick={() =>
            setDraft({ name: "", type: "ROUND1", durationMinutes: 20, maxMarks: 100 })
          }
        >
          New round
        </Button>
      }
    >
      {q.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : q.isError ? (
        <p className="text-sm text-destructive">
          {q.error instanceof Error ? q.error.message : "Could not load rounds."}
        </p>
      ) : (
        <div className="space-y-3">
          {(q.data?.rounds ?? []).map((r) => (
            <div key={r.id} className="surface rounded-lg border border-border/70 p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="mono-label text-muted-foreground">#{r.orderNo}</span>
                    <p className="text-sm font-semibold">{r.name}</p>
                    <Badge variant={r.state === "LIVE" ? "default" : "secondary"}>{r.state}</Badge>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {r.type} · {r.durationMinutes} min · {r.maxMarks} marks · {r.itemCount} item(s) ·{" "}
                    {r.inProgress} in progress · {r.submitted} submitted
                  </p>
                  {r.startTime ? (
                    <p className="mt-1 text-xs text-muted-foreground">
                      Started {formatIst(r.startTime)}
                    </p>
                  ) : null}
                </div>
                <div className="flex flex-wrap gap-1">
                  <Button size="sm" variant="ghost" onClick={() => move.mutate({ roundId: r.id, direction: "up" })}>
                    ↑
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => move.mutate({ roundId: r.id, direction: "down" })}
                  >
                    ↓
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      setDraft({
                        roundId: r.id,
                        name: r.name,
                        type: r.type as RoundType,
                        durationMinutes: r.durationMinutes,
                        maxMarks: r.maxMarks,
                      })
                    }
                  >
                    Edit
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => dup.mutate(r.id)}>
                    Duplicate
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-destructive"
                    onClick={() => setConfirm({ id: r.id, name: r.name, action: "delete" })}
                  >
                    Delete
                  </Button>
                </div>
              </div>

              <div className="mt-4 flex flex-wrap gap-2 border-t border-border/60 pt-4">
                <Button
                  size="sm"
                  disabled={r.state === "LIVE" || lifecycle.isPending}
                  onClick={() => lifecycle.mutate({ roundId: r.id, action: "start" })}
                >
                  Start
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={r.state !== "LIVE" || lifecycle.isPending}
                  onClick={() => lifecycle.mutate({ roundId: r.id, action: "pause" })}
                >
                  Pause
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={r.state !== "PAUSED" || lifecycle.isPending}
                  onClick={() => lifecycle.mutate({ roundId: r.id, action: "resume" })}
                >
                  Resume
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setConfirm({ id: r.id, name: r.name, action: "reset" })}
                >
                  Restart timer
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={r.state === "ENDED" || lifecycle.isPending}
                  onClick={() => lifecycle.mutate({ roundId: r.id, action: "end" })}
                >
                  End round
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <Dialog open={Boolean(draft)} onOpenChange={(open) => (open ? null : setDraft(null))}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{draft?.roundId ? "Edit round" : "New round"}</DialogTitle>
            <DialogDescription>
              Duration is the authoritative attempt window applied by the server when the round starts.
            </DialogDescription>
          </DialogHeader>
          {draft ? (
            <div className="grid gap-4">
              <div className="grid gap-2">
                <Label htmlFor="rname">Name</Label>
                <Input
                  id="rname"
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                />
              </div>
              {!draft.roundId ? (
                <div className="grid gap-2">
                  <Label>Type</Label>
                  <Select
                    value={draft.type}
                    onValueChange={(v) => setDraft({ ...draft, type: v as RoundType })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="ROUND1">Quiz / output prediction</SelectItem>
                      <SelectItem value="ROUND2">Bug hunt (debugging)</SelectItem>
                      <SelectItem value="ROUND3">Code sprint (programming)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              ) : null}
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="grid gap-2">
                  <Label htmlFor="dur">Duration (minutes)</Label>
                  <Input
                    id="dur"
                    type="number"
                    value={draft.durationMinutes}
                    onChange={(e) => setDraft({ ...draft, durationMinutes: Number(e.target.value) })}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="marks">Maximum marks</Label>
                  <Input
                    id="marks"
                    type="number"
                    value={draft.maxMarks}
                    onChange={(e) => setDraft({ ...draft, maxMarks: Number(e.target.value) })}
                  />
                </div>
              </div>
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDraft(null)}>
              Cancel
            </Button>
            <Button disabled={save.isPending} onClick={() => draft && save.mutate(draft)}>
              {save.isPending ? "Saving…" : "Save round"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={Boolean(confirm)} onOpenChange={(open) => (open ? null : setConfirm(null))}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm?.action === "delete" ? `Delete ${confirm?.name}?` : `Restart the ${confirm?.name} timer?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm?.action === "delete"
                ? "Rounds that already hold student data cannot be deleted — disable them instead."
                : "Restarting creates a brand new deadline for every student currently in this round. Nobody keeps their old clock."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (!confirm) return;
                if (confirm.action === "delete") remove.mutate(confirm.id);
                else lifecycle.mutate({ roundId: confirm.id, action: "reset" });
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
