import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { listStudents, setStudentActive, revokeStudentSessions } from "@/lib/admin.functions";
import {
  createStudent,
  deleteStudent,
  getStudentRoundState,
  purgeStudent,
  resetStudentRound,
  unlockStudent,
  updateStudent,
} from "@/lib/admin-manage.functions";

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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export const Route = createFileRoute("/_authenticated/admin/users")({
  head: () => ({
    meta: [
      { title: "Students — CodeArena admin" },
      { name: "description", content: "Create, edit, disable and remove competition participants." },
      { property: "og:title", content: "Students — CodeArena admin" },
      { property: "og:description", content: "Participant management for your coding event." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: AdminUsers,
});

type Status = "ACTIVE" | "BLOCKED" | "WITHDRAWN";
type Draft = {
  studentId?: string;
  fullName: string;
  batchCode: string;
  studentCode: string;
  status: Status;
  password: string;
};

const emptyDraft: Draft = {
  fullName: "",
  batchCode: "",
  studentCode: "",
  status: "ACTIVE",
  password: "",
};

function AdminUsers() {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [batch, setBatch] = useState("all");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<{ id: string; name: string } | null>(null);

  const q = useQuery({
    queryKey: ["admin-students", search, batch],
    queryFn: () => listStudents({ data: { search, batch } }),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ["admin-students"] });
  const fail = (e: unknown) => toast.error(e instanceof Error ? e.message : "Something went wrong.");

  const save = useMutation({
    mutationFn: (d: Draft) =>
      d.studentId
        ? updateStudent({
            data: {
              studentId: d.studentId,
              fullName: d.fullName,
              batchCode: d.batchCode,
              status: d.status,
              ...(d.studentCode ? { studentCode: d.studentCode } : {}),
              ...(d.password ? { password: d.password } : {}),
            },
          })
        : createStudent({
            data: {
              fullName: d.fullName,
              batchCode: d.batchCode,
              status: d.status,
              ...(d.studentCode ? { studentCode: d.studentCode } : {}),
              ...(d.password ? { password: d.password } : {}),
            },
          }),
    onSuccess: () => {
      toast.success("Student saved.");
      setDraft(null);
      void refresh();
    },
    onError: fail,
  });

  const remove = useMutation({
    mutationFn: (studentId: string) => deleteStudent({ data: { studentId } }),
    onSuccess: (r) => {
      toast.success(r.softDeleted ? "Student withdrawn (records kept)." : "Student deleted.");
      setConfirmDelete(null);
      void refresh();
    },
    onError: fail,
  });

  const toggle = useMutation({
    mutationFn: (v: { userId: string; active: boolean }) => setStudentActive({ data: v }),
    onSuccess: () => void refresh(),
    onError: fail,
  });

  const revoke = useMutation({
    mutationFn: (userId: string) => revokeStudentSessions({ data: { userId } }),
    onSuccess: () => {
      toast.success("Sessions cleared.");
      void refresh();
    },
    onError: fail,
  });

  // Per-student round control: inspect every round, unlock a locked-out
  // student, or reopen exactly one round for exactly this student.
  const [manage, setManage] = useState<{ id: string; name: string } | null>(null);
  const [clearScore, setClearScore] = useState(false);
  const [confirmPurge, setConfirmPurge] = useState<{ id: string; name: string } | null>(null);

  const roundState = useQuery({
    queryKey: ["student-round-state", manage?.id],
    queryFn: () => getStudentRoundState({ data: { studentId: manage!.id } }),
    enabled: Boolean(manage),
  });

  const unlock = useMutation({
    mutationFn: (v: { studentId: string; roundId: string }) => unlockStudent({ data: v }),
    onSuccess: () => {
      toast.success("Student unlocked for that round.");
      void roundState.refetch();
      void refresh();
    },
    onError: fail,
  });

  const resetRound = useMutation({
    mutationFn: (v: { studentId: string; roundId: string }) =>
      resetStudentRound({ data: { ...v, clearScore } }),
    onSuccess: () => {
      toast.success("Round reopened for this student.");
      void roundState.refetch();
      void refresh();
    },
    onError: fail,
  });

  const purge = useMutation({
    mutationFn: (studentId: string) => purgeStudent({ data: { studentId } }),
    onSuccess: () => {
      toast.success("Student permanently deleted.");
      setConfirmPurge(null);
      setConfirmDelete(null);
      void refresh();
    },
    onError: fail,
  });



  return (
    <AppShell
      nav={ADMIN_NAV}
      title="Students"
      subtitle="Every account that can take part in the event."
      actions={<Button size="sm" onClick={() => setDraft({ ...emptyDraft })}>Add student</Button>}
    >
      <div className="mb-6 flex flex-wrap gap-3">
        <Input
          className="max-w-xs"
          placeholder="Search name, ID or batch"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <Select value={batch} onValueChange={setBatch}>
          <SelectTrigger className="w-44">
            <SelectValue placeholder="All batches" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All batches</SelectItem>
            {(q.data?.batches ?? []).map((b) => (
              <SelectItem key={b} value={b}>
                {b}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {q.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : q.isError ? (
        <p className="text-sm text-destructive">
          {q.error instanceof Error ? q.error.message : "Could not load students."}
        </p>
      ) : (
        <div className="surface overflow-x-auto rounded-lg border border-border/70">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Student</TableHead>
                <TableHead>ID</TableHead>
                <TableHead>Batch</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Sessions</TableHead>
                <TableHead>Score</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(q.data?.students ?? []).map((s) => (
                <TableRow key={s.id}>
                  <TableCell className="font-medium">{s.fullName}</TableCell>
                  <TableCell className="font-mono text-xs">{s.studentCode}</TableCell>
                  <TableCell>{s.batchNumber}</TableCell>
                  <TableCell>
                    <Badge variant={s.active && s.status === "ACTIVE" ? "default" : "secondary"}>
                      {s.active ? s.status : "DISABLED"}
                    </Badge>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{s.activeSessions}</TableCell>
                  <TableCell className="font-mono text-xs">{s.totalScore}</TableCell>
                  <TableCell className="space-x-1 text-right whitespace-nowrap">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        setDraft({
                          studentId: s.id,
                          fullName: s.fullName,
                          batchCode: s.batchNumber === "—" ? "" : s.batchNumber,
                          studentCode: s.studentCode === "—" ? "" : s.studentCode,
                          status: s.status as Status,
                          password: "",
                        })
                      }
                    >
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => toggle.mutate({ userId: s.userId, active: !s.active })}
                    >
                      {s.active ? "Disable" : "Enable"}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => revoke.mutate(s.userId)}>
                      Clear sessions
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setClearScore(false);
                        setManage({ id: s.id, name: s.fullName });
                      }}
                    >
                      Rounds
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-destructive"
                      onClick={() => setConfirmDelete({ id: s.id, name: s.fullName })}
                    >
                      Delete
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {(q.data?.students ?? []).length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-sm text-muted-foreground">
                    No students match this filter.
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </div>
      )}

      <Dialog open={Boolean(draft)} onOpenChange={(open) => (open ? null : setDraft(null))}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{draft?.studentId ? "Edit student" : "Add student"}</DialogTitle>
            <DialogDescription>
              Passwords are hashed on the server and are never shown again.
            </DialogDescription>
          </DialogHeader>
          {draft ? (
            <div className="grid gap-4">
              <div className="grid gap-2">
                <Label htmlFor="fullName">Full name</Label>
                <Input
                  id="fullName"
                  value={draft.fullName}
                  onChange={(e) => setDraft({ ...draft, fullName: e.target.value })}
                />
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="grid gap-2">
                  <Label htmlFor="studentCode">Student / register number</Label>
                  <Input
                    id="studentCode"
                    value={draft.studentCode}
                    onChange={(e) => setDraft({ ...draft, studentCode: e.target.value })}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="batchCode">Batch</Label>
                  <Input
                    id="batchCode"
                    value={draft.batchCode}
                    onChange={(e) => setDraft({ ...draft, batchCode: e.target.value })}
                  />
                </div>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="grid gap-2">
                  <Label>Status</Label>
                  <Select
                    value={draft.status}
                    onValueChange={(v) => setDraft({ ...draft, status: v as Status })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="ACTIVE">Active</SelectItem>
                      <SelectItem value="BLOCKED">Blocked</SelectItem>
                      <SelectItem value="WITHDRAWN">Withdrawn</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="password">
                    {draft.studentId ? "New password (optional)" : "Password (optional)"}
                  </Label>
                  <Input
                    id="password"
                    type="password"
                    autoComplete="new-password"
                    placeholder={draft.studentId ? "Leave blank to keep" : "Default password if blank"}
                    value={draft.password}
                    onChange={(e) => setDraft({ ...draft, password: e.target.value })}
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
              {save.isPending ? "Saving…" : "Save student"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={Boolean(confirmDelete)}
        onOpenChange={(open) => (open ? null : setConfirmDelete(null))}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {confirmDelete?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              If this student already has competition records they are withdrawn and deactivated instead of
              deleted, so no results are destroyed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button
              variant="outline"
              className="text-destructive"
              onClick={() => confirmDelete && setConfirmPurge(confirmDelete)}
            >
              Delete permanently
            </Button>
            <AlertDialogAction onClick={() => confirmDelete && remove.mutate(confirmDelete.id)}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={Boolean(confirmPurge)}
        onOpenChange={(open) => (open ? null : setConfirmPurge(null))}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Permanently delete {confirmPurge?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This erases the account and every answer, submission, violation and score belonging to this
              student. No other student is affected. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={purge.isPending}
              onClick={() => confirmPurge && purge.mutate(confirmPurge.id)}
            >
              {purge.isPending ? "Deleting…" : "Delete permanently"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={Boolean(manage)} onOpenChange={(open) => (open ? null : setManage(null))}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Round control — {manage?.name}</DialogTitle>
            <DialogDescription>
              Unlock or reopen a single round for this student only. Everyone else is unaffected.
            </DialogDescription>
          </DialogHeader>

          {roundState.isLoading ? (
            <Skeleton className="h-40 w-full" />
          ) : (
            <div className="grid gap-3">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={clearScore}
                  onChange={(e) => setClearScore(e.target.checked)}
                />
                Also clear this student&apos;s marks for the round being reopened
              </label>
              {(roundState.data?.rounds ?? []).map((r) => (
                <div
                  key={r.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border/70 px-4 py-3"
                >
                  <div>
                    <p className="text-sm font-medium">{r.name}</p>
                    <p className="text-xs text-muted-foreground">
                      Round {r.roundState} · Student {r.status} · {r.score} marks
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={r.status !== "LOCKED" || unlock.isPending}
                      onClick={() =>
                        manage && unlock.mutate({ studentId: manage.id, roundId: r.id })
                      }
                    >
                      Unlock
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={resetRound.isPending}
                      onClick={() =>
                        manage && resetRound.mutate({ studentId: manage.id, roundId: r.id })
                      }
                    >
                      Reset round
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setManage(null)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppShell>

  );
}
