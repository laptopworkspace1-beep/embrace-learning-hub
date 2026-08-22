import { formatIst } from "@/lib/datetime";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { AppShell, ADMIN_NAV } from "@/components/AppShell";
import { EventHealthPanel } from "@/components/EventHealthPanel";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  checkPistonNode,
  deletePistonNode,
  listPistonExecutions,
  listPistonNodes,
  refreshPistonHealth,
  savePistonNode,
  setPistonNodeEnabled,
} from "@/lib/piston-nodes.functions";

export const Route = createFileRoute("/_authenticated/admin/infrastructure")({
  head: () => ({
    meta: [
      { title: "Execution infrastructure — CodeArena admin" },
      {
        name: "description",
        content:
          "Manage the Piston node pool: add VMs, check health, set concurrency limits and watch how submissions are distributed across nodes.",
      },
      { property: "og:title", content: "Execution infrastructure — CodeArena admin" },
      {
        property: "og:description",
        content: "Piston node pool with health checks, capacity limits and automatic failover.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: AdminInfrastructure,
});

type NodeSummary = Awaited<ReturnType<typeof listPistonNodes>>["nodes"][number];
type NodeHealth = NodeSummary["healthStatus"];

type FormState = {
  id?: string;
  nodeId: string;
  url: string;
  enabled: boolean;
  maxConcurrentJobs: number;
  timeoutMs: number;
};

function emptyForm(index: number): FormState {
  return {
    nodeId: `piston-vm-${index}`,
    url: "",
    enabled: true,
    maxConcurrentJobs: 20,
    timeoutMs: 20000,
  };
}

const HEALTH_STYLES: Record<NodeHealth, string> = {
  ONLINE: "bg-emerald-500/15 text-emerald-600 border-emerald-500/30",
  UNHEALTHY: "bg-amber-500/15 text-amber-600 border-amber-500/30",
  OFFLINE: "bg-destructive/15 text-destructive border-destructive/30",
  DISABLED: "bg-muted text-muted-foreground border-border",
};

function when(value: string | null): string {
  if (!value) return "never";
  return formatIst(value);
}

function AdminInfrastructure() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [form, setForm] = useState<FormState | null>(null);

  // Fast, non-blocking read: just the node pool straight from the DB.
  const q = useQuery({
    queryKey: ["piston-nodes"],
    queryFn: () => listPistonNodes(),
    refetchInterval: 30_000,
    staleTime: 10_000,
    placeholderData: (prev) => prev,
    retry: false,
  });

  // Health probing runs after the shell has rendered and patches only the node
  // rows in the cache, so the page never waits on the VMs.
  const health = useQuery({
    queryKey: ["piston-nodes", "health"],
    queryFn: () => refreshPistonHealth(),
    enabled: q.isSuccess,
    refetchInterval: 60_000,
    refetchOnWindowFocus: false,
    retry: false,
  });

  // Execution history is a separate, lower-priority read so the node pool
  // renders first and the (much larger) log streams in behind it.
  const logs = useQuery({
    queryKey: ["piston-executions"],
    queryFn: () => listPistonExecutions(),
    refetchInterval: 30_000,
    staleTime: 10_000,
    placeholderData: (prev) => prev,
    retry: false,
  });

  const healthNodes = health.data?.nodes;
  useEffect(() => {
    if (!healthNodes) return;
    qc.setQueryData(["piston-nodes"], (prev: typeof q.data) =>
      prev ? { ...prev, nodes: healthNodes, checkedAt: health.data?.checkedAt ?? prev.checkedAt } : prev,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [healthNodes, qc]);

  const errorMessage = q.error instanceof Error ? q.error.message : "";
  useEffect(() => {
    if (/session has expired|Forbidden/i.test(errorMessage)) {
      toast.error("Your session has expired. Please sign in again.");
      void navigate({ to: "/auth", search: { redirect: "/admin/infrastructure" } });
    }
  }, [errorMessage, navigate]);

  const invalidate = () => void qc.invalidateQueries({ queryKey: ["piston-nodes"] });


  const save = useMutation({
    mutationFn: (state: FormState) =>
      savePistonNode({
        data: {
          ...(state.id ? { id: state.id } : {}),
          nodeId: state.nodeId.trim(),
          url: state.url.trim(),
          enabled: state.enabled,
          maxConcurrentJobs: state.maxConcurrentJobs,
          timeoutMs: state.timeoutMs,
        },
      }),
    onSuccess: (r) => {
      toast.success(`Node saved — ${r.detail}`);
      setForm(null);
      invalidate();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not save that node."),
  });

  const check = useMutation({
    mutationFn: (id: string) => checkPistonNode({ data: { id } }),
    onSuccess: (r) => {
      if (r.status === "ONLINE") toast.success(r.detail);
      else toast.error(`${r.status}: ${r.detail}`);
      invalidate();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Health check failed."),
  });

  const toggle = useMutation({
    mutationFn: (input: { id: string; enabled: boolean }) => setPistonNodeEnabled({ data: input }),
    onSuccess: (_r, input) => {
      toast.success(input.enabled ? "Node enabled." : "Node disabled — it receives no new executions.");
      invalidate();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not change that node."),
  });

  const remove = useMutation({
    mutationFn: (id: string) => deletePistonNode({ data: { id } }),
    onSuccess: (r) => {
      toast.success(
        r.remainingUsable === 0
          ? "Node removed. No usable Piston node remains — execution now depends on the Judge0 fallback."
          : "Node removed. Historical execution records were kept.",
      );
      invalidate();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not remove that node."),
  });

  const nodes = q.data?.nodes ?? [];
  const executions = logs.data?.executions ?? [];
  const busy = save.isPending || check.isPending || toggle.isPending || remove.isPending;
  const usable = nodes.filter((node) => node.enabled && node.healthStatus !== "OFFLINE").length;

  const confirmRemove = (node: NodeSummary) => {
    const last = usable <= 1 && node.enabled;
    const message = last
      ? `Remove ${node.nodeId}? This is the last usable execution node — student submissions will depend on the Judge0 fallback.`
      : `Remove ${node.nodeId}? Historical execution records are kept.`;
    if (window.confirm(message)) remove.mutate(node.id);
  };

  return (
    <AppShell
      nav={ADMIN_NAV}
      title="Execution infrastructure"
      subtitle="Piston node pool — students always call the same CodeArena execution API; the backend picks the node"
    >
      <div className="space-y-8">
        <EventHealthPanel />

        <section className="rounded-lg border border-border bg-card p-5">

          <h2 className="text-lg font-semibold">Piston nodes</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Each student is assigned a node server-side for the round and keeps it across submissions. If that node
            is full, unhealthy or offline, the router fails over to another healthy node, and finally to the
            configured Judge0 fallback. Adding a node here is all that is needed — no code change.
          </p>
          <dl className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-4">
            {[
              { label: "Configured nodes", value: nodes.length },
              { label: "Usable now", value: usable },
              { label: "Executions", value: nodes.reduce((sum, node) => sum + node.totalExecutions, 0) },
              { label: "Failures", value: nodes.reduce((sum, node) => sum + node.totalFailures, 0) },
            ].map((item) => (
              <div key={item.label} className="rounded-md border border-border p-3">
                <dt className="text-xs uppercase tracking-wide text-muted-foreground">{item.label}</dt>
                <dd className="mt-1 text-xl font-semibold">{item.value}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">Nodes</h2>
            <Button size="sm" onClick={() => setForm(emptyForm(nodes.length + 1))} disabled={busy}>
              + Add Piston VM
            </Button>
          </div>

          {q.isLoading ? (
            <div className="space-y-3">
              <Skeleton className="h-28 w-full" />
              <Skeleton className="h-28 w-full" />
            </div>
          ) : nodes.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border p-6 text-sm text-muted-foreground">
              No Piston nodes are configured yet. Add one to start distributing executions.
            </p>
          ) : (
            <ul className="space-y-4">
              {nodes.map((node) => (
                <li key={node.id} className="rounded-lg border border-border bg-card p-5">
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div>
                      <div className="flex items-center gap-3">
                        <h3 className="font-semibold">{node.nodeId}</h3>
                        <Badge variant="outline" className={HEALTH_STYLES[node.healthStatus]}>
                          ● {node.healthStatus}
                        </Badge>
                      </div>
                      <p className="mt-1 font-mono text-xs text-muted-foreground">{node.url}</p>
                      <p className="mt-2 text-sm text-muted-foreground">
                        Load: {node.currentLoad}/{node.maxConcurrentJobs} · Executions: {node.totalExecutions} ·
                        Failures: {node.totalFailures} · Last health check: {when(node.lastHealthCheck)}
                      </p>
                      {node.lastError ? (
                        <p className="mt-1 text-sm text-destructive">{node.lastError}</p>
                      ) : null}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => check.mutate(node.id)}
                        disabled={busy}
                      >
                        Health check
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          setForm({
                            id: node.id,
                            nodeId: node.nodeId,
                            url: node.url,
                            enabled: node.enabled,
                            maxConcurrentJobs: node.maxConcurrentJobs,
                            timeoutMs: node.timeoutMs,
                          })
                        }
                        disabled={busy}
                      >
                        Edit
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => toggle.mutate({ id: node.id, enabled: !node.enabled })}
                        disabled={busy}
                      >
                        {node.enabled ? "Disable" : "Enable"}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-destructive"
                        onClick={() => confirmRemove(node)}
                        disabled={busy}
                      >
                        Remove
                      </Button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        {form ? (
          <section className="rounded-lg border border-border bg-card p-5">
            <h2 className="text-lg font-semibold">{form.id ? "Edit Piston node" : "Add Piston VM"}</h2>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="nodeId">Node ID</Label>
                <Input
                  id="nodeId"
                  value={form.nodeId}
                  onChange={(e) => setForm({ ...form, nodeId: e.target.value })}
                  placeholder="piston-vm-3"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="url">Piston API URL</Label>
                <Input
                  id="url"
                  value={form.url}
                  onChange={(e) => setForm({ ...form, url: e.target.value })}
                  placeholder="http://203.0.113.10:8080"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="max">Maximum concurrent jobs</Label>
                <Input
                  id="max"
                  type="number"
                  min={1}
                  max={200}
                  value={form.maxConcurrentJobs}
                  onChange={(e) =>
                    setForm({ ...form, maxConcurrentJobs: Number(e.target.value) || 1 })
                  }
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="timeout">Request timeout (ms)</Label>
                <Input
                  id="timeout"
                  type="number"
                  min={2000}
                  max={60000}
                  step={1000}
                  value={form.timeoutMs}
                  onChange={(e) => setForm({ ...form, timeoutMs: Number(e.target.value) || 20000 })}
                />
              </div>
              <div className="flex items-center gap-3">
                <Switch
                  id="enabled"
                  checked={form.enabled}
                  onCheckedChange={(checked) => setForm({ ...form, enabled: checked })}
                />
                <Label htmlFor="enabled">Enabled</Label>
              </div>
            </div>
            <p className="mt-3 text-sm text-muted-foreground">
              The address is validated and health-checked on the server before the node is saved.
            </p>
            <div className="mt-4 flex gap-2">
              <Button onClick={() => save.mutate(form)} disabled={save.isPending}>
                {save.isPending ? "Checking and saving…" : "Save node"}
              </Button>
              <Button variant="ghost" onClick={() => setForm(null)} disabled={save.isPending}>
                Cancel
              </Button>
            </div>
          </section>
        ) : null}

        <section className="space-y-3">
          <h2 className="text-lg font-semibold">Recent executions</h2>
          <p className="text-sm text-muted-foreground">
            Which node actually ran each submission, including failovers and retries.
          </p>
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2">Student</th>
                  <th className="px-3 py-2">Round</th>
                  <th className="px-3 py-2">Submission</th>
                  <th className="px-3 py-2">Assigned</th>
                  <th className="px-3 py-2">Executed</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Duration</th>
                  <th className="px-3 py-2">Retries</th>
                </tr>
              </thead>
              <tbody>
                {executions.length === 0 ? (
                  <tr>
                    <td className="px-3 py-4 text-muted-foreground" colSpan={8}>
                      {logs.isLoading
                        ? "Loading recent executions…"
                        : "No executions have run through the node pool yet."}
                    </td>
                  </tr>
                ) : (
                  executions.map((row) => (
                    <tr key={row.id} className="border-t border-border">
                      <td className="px-3 py-2 font-mono text-xs">{row.studentId ?? "—"}</td>
                      <td className="px-3 py-2 font-mono text-xs">{row.roundId || "—"}</td>
                      <td className="px-3 py-2 font-mono text-xs">{row.submissionId ?? "—"}</td>
                      <td className="px-3 py-2">{row.assignedNodeId || "—"}</td>
                      <td className="px-3 py-2">
                        {row.actualNodeId || "—"}
                        {row.assignedNodeId && row.actualNodeId && row.assignedNodeId !== row.actualNodeId ? (
                          <Badge variant="outline" className="ml-2 border-amber-500/30 text-amber-600">
                            failover
                          </Badge>
                        ) : null}
                      </td>
                      <td className="px-3 py-2">{row.status}</td>
                      <td className="px-3 py-2">{row.durationMs} ms</td>
                      <td className="px-3 py-2">{row.retryCount}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </AppShell>
  );
}
