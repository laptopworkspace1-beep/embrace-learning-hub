import { formatIst } from "@/lib/datetime";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { AppShell, ADMIN_NAV } from "@/components/AppShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  deleteExecutionEngine,
  listExecutionEngines,
  refreshEngineHealth,
  saveExecutionEngine,
  setExecutionMode,
  testExecutionEngine,
} from "@/lib/engines.functions";
import {
  EXECUTABLE_LANGUAGES,
  LANGUAGE_LABELS,
  MAX_ENGINES,
  PROVIDERS,
  PROVIDER_LABELS,
  healthEndpointFor,
  type EngineHealth,
  type EngineSummary,
  type Language,
  type Provider,
} from "@/lib/exec-engines";

export const Route = createFileRoute("/_authenticated/admin/engines")({
  head: () => ({
    meta: [
      { title: "Execution engines — CodeArena admin" },
      {
        name: "description",
        content:
          "Configure, test, prioritise and monitor the code execution engines (Piston, Judge0) that compile and run participant submissions.",
      },
      { property: "og:title", content: "Execution engines — CodeArena admin" },
      {
        property: "og:description",
        content: "Multi-engine execution routing with health checks and automatic failover.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: AdminEngines,
});

type FormState = {
  id?: string;
  slot: number;
  name: string;
  provider: Provider;
  baseUrl: string;
  apiKey: string;
  enabled: boolean;
  priority: number;
  timeoutMs: number;
  supportedLanguages: Language[];
};

function emptyForm(slot: number): FormState {
  return {
    slot,
    name: `Execution Engine ${slot}`,
    provider: slot === 1 ? "PISTON" : "JUDGE0",
    baseUrl: "",
    apiKey: "",
    enabled: true,
    priority: slot,
    timeoutMs: 20000,
    supportedLanguages: ["C"],
  };
}

const HEALTH_STYLES: Record<EngineHealth, string> = {
  HEALTHY: "bg-emerald-500/15 text-emerald-600 border-emerald-500/30",
  DEGRADED: "bg-amber-500/15 text-amber-600 border-amber-500/30",
  UNAVAILABLE: "bg-destructive/15 text-destructive border-destructive/30",
  DISABLED: "bg-muted text-muted-foreground border-border",
  UNKNOWN: "bg-muted text-muted-foreground border-border",
};

function HealthBadge({ status }: { status: EngineHealth }) {
  return (
    <Badge variant="outline" className={HEALTH_STYLES[status]}>
      ● {status}
    </Badge>
  );
}

type TestResult = Awaited<ReturnType<typeof testExecutionEngine>>;
type TestPayload = Parameters<typeof testExecutionEngine>[0]["data"];

function AdminEngines() {
  const qc = useQueryClient();
  const navigate = useNavigate();

  const [form, setForm] = useState<FormState | null>(null);
  const [results, setResults] = useState<Record<string, TestResult>>({});

  const q = useQuery({
    queryKey: ["execution-engines"],
    queryFn: () => listExecutionEngines(),
    // Live status: the panel re-reads engine health every 15 seconds.
    refetchInterval: 15_000,
    retry: false,
  });

  // An expired/absent session must not blank the panel: send the admin to the
  // sign-in screen instead of surfacing a raw server-function error.
  const errorMessage = q.error instanceof Error ? q.error.message : "";
  useEffect(() => {
    if (/session has expired|Forbidden/i.test(errorMessage)) {
      toast.error("Your session has expired. Please sign in again.");
      void navigate({ to: "/auth", search: { redirect: "/admin/engines" } });
    }
  }, [errorMessage, navigate]);

  const invalidate = () => void qc.invalidateQueries({ queryKey: ["execution-engines"] });


  const save = useMutation({
    mutationFn: (state: FormState) =>
      saveExecutionEngine({
        data: {
          ...(state.id ? { id: state.id } : {}),
          name: state.name.trim(),
          provider: state.provider,
          baseUrl: state.baseUrl.trim(),
          ...(state.apiKey.trim() ? { apiKey: state.apiKey.trim() } : {}),
          enabled: state.enabled,
          priority: state.priority,
          timeoutMs: state.timeoutMs,
          supportedLanguages: state.supportedLanguages,
        },
      }),
    onSuccess: () => {
      toast.success("Engine saved — health re-checked with the new configuration.");
      setForm(null);
      invalidate();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not save that engine."),
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteExecutionEngine({ data: { id } }),
    onSuccess: () => {
      toast.success("Execution engine removed.");
      invalidate();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not remove that engine."),
  });

  const test = useMutation({
    mutationFn: (input: { key: string; payload: TestPayload }) =>
      testExecutionEngine({ data: input.payload }).then((r) => ({ key: input.key, result: r })),
    onSuccess: ({ key, result }) => {
      setResults((prev) => ({ ...prev, [key]: result }));
      if (result.mode === "COMPILER") {
        if (result.executionReady) toast.success("C compiled and executed — this engine is execution-ready.");
        else toast.error("The C test program did not succeed — see the diagnostic.");
      } else if (result.connected) {
        toast.success("Provider API reachable and returning valid JSON.");
      } else {
        toast.error("Could not reach the provider API — see the diagnostic.");
      }
      invalidate();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "The test could not be completed."),
  });

  const refresh = useMutation({
    mutationFn: () => refreshEngineHealth(),
    onSuccess: () => {
      toast.success("Health check completed.");
      invalidate();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Health check failed."),
  });

  const mode = useMutation({
    mutationFn: (next: "AUTO_FAILOVER" | "LOAD_BALANCED") => setExecutionMode({ data: { mode: next } }),
    onSuccess: (r) => {
      toast.success(r.mode === "AUTO_FAILOVER" ? "Automatic failover enabled." : "Load balancing enabled.");
      invalidate();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not change the routing mode."),
  });

  const engines = q.data?.engines ?? [];
  const stats = q.data?.stats;
  const busy = test.isPending || save.isPending || remove.isPending;
  const slots = Array.from({ length: MAX_ENGINES }, (_, index) => engines[index] ?? null);

  return (
    <AppShell
      nav={ADMIN_NAV}
      title="Execution engines"
      subtitle="Up to three compilation providers, each independently configured, tested and monitored"
    >
      <div className="space-y-8">
        <section className="rounded-lg border border-border bg-card p-5">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold">Routing</h2>
              <p className="text-sm text-muted-foreground">
                Submissions go to the healthy, enabled engine with the lowest priority number that supports the
                requested language. When it fails, the next one takes over automatically — participants never choose
                a provider.
              </p>
            </div>
            <div className="flex items-center gap-3">
              <Button
                variant={q.data?.mode === "AUTO_FAILOVER" ? "default" : "outline"}
                size="sm"
                onClick={() => mode.mutate("AUTO_FAILOVER")}
                disabled={mode.isPending}
              >
                Automatic failover
              </Button>
              <Button
                variant={q.data?.mode === "LOAD_BALANCED" ? "default" : "outline"}
                size="sm"
                onClick={() => mode.mutate("LOAD_BALANCED")}
                disabled={mode.isPending}
              >
                Load balanced
              </Button>
              <Button size="sm" variant="secondary" onClick={() => refresh.mutate()} disabled={refresh.isPending}>
                {refresh.isPending ? "Checking…" : "Check all engines"}
              </Button>
            </div>
          </div>
          {stats ? (
            <dl className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-4">
              {[
                { label: "Executions", value: stats.total },
                { label: "Successful", value: stats.successful },
                { label: "Infrastructure failures", value: stats.failed },
                { label: "Average latency", value: `${stats.averageLatencyMs} ms` },
              ].map((item) => (
                <div key={item.label} className="rounded-md border border-border p-3">
                  <dt className="text-xs uppercase tracking-wide text-muted-foreground">{item.label}</dt>
                  <dd className="mt-1 text-xl font-semibold">{item.value}</dd>
                </div>
              ))}
            </dl>
          ) : null}
        </section>

        <section className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">Execution engines</h2>
            <Button
              size="sm"
              onClick={() => setForm(emptyForm(engines.length + 1))}
              disabled={engines.length >= MAX_ENGINES || busy}
            >
              + Add engine
            </Button>
          </div>

          {q.isLoading ? (
            <div className="space-y-3">
              <Skeleton className="h-32 w-full" />
              <Skeleton className="h-32 w-full" />
            </div>
          ) : (
            <ul className="space-y-4">
              {slots.map((engine, index) =>
                engine ? (
                  <EngineCard
                    key={engine.id}
                    slot={index + 1}
                    engine={engine}
                    result={results[engine.id]}
                    busy={busy}
                    onEdit={() =>
                      setForm({
                        id: engine.id,
                        slot: index + 1,
                        name: engine.name,
                        provider: engine.provider,
                        baseUrl: engine.baseUrl,
                        apiKey: "",
                        enabled: engine.enabled,
                        priority: engine.priority,
                        timeoutMs: engine.timeoutMs,
                        supportedLanguages: engine.supportedLanguages,
                      })
                    }
                    onSaveBaseUrl={(baseUrl) =>
                      save.mutate({
                        id: engine.id,
                        slot: index + 1,
                        name: engine.name,
                        provider: engine.provider,
                        baseUrl,
                        apiKey: "",
                        enabled: engine.enabled,
                        priority: engine.priority,
                        timeoutMs: engine.timeoutMs,
                        supportedLanguages: engine.supportedLanguages,
                      })
                    }
                    onPriority={(priority) =>
                      save.mutate({
                        id: engine.id,
                        slot: index + 1,
                        name: engine.name,
                        provider: engine.provider,
                        baseUrl: engine.baseUrl,
                        apiKey: "",
                        enabled: engine.enabled,
                        priority,
                        timeoutMs: engine.timeoutMs,
                        supportedLanguages: engine.supportedLanguages,
                      })
                    }
                    onTest={(testMode) =>
                      test.mutate({ key: engine.id, payload: { id: engine.id, mode: testMode } })
                    }
                    onToggle={(enabled) =>
                      save.mutate({
                        id: engine.id,
                        slot: index + 1,
                        name: engine.name,
                        provider: engine.provider,
                        baseUrl: engine.baseUrl,
                        apiKey: "",
                        enabled,
                        priority: engine.priority,
                        timeoutMs: engine.timeoutMs,
                        supportedLanguages: engine.supportedLanguages,
                      })
                    }
                    onDelete={() => {
                      if (confirm(`Remove ${engine.name}? Submissions will no longer be routed to it.`))
                        remove.mutate(engine.id);
                    }}
                  />
                ) : (
                  <li
                    key={`slot-${index + 1}`}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-dashed border-border p-5"
                  >
                    <div>
                      <h3 className="font-semibold">Execution Engine {index + 1}</h3>
                      <p className="text-sm text-muted-foreground">Not configured</p>
                    </div>
                    <Button size="sm" variant="outline" onClick={() => setForm(emptyForm(index + 1))} disabled={busy}>
                      + Configure engine
                    </Button>
                  </li>
                ),
              )}
            </ul>
          )}
        </section>

        {form ? (
          <EngineForm
            state={form}
            onChange={setForm}
            onCancel={() => setForm(null)}
            onSave={() => save.mutate(form)}
            onTest={(testMode) =>
              test.mutate({
                key: "form",
                payload: {
                  ...(form.id ? { id: form.id } : {}),
                  provider: form.provider,
                  baseUrl: form.baseUrl.trim(),
                  ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}),
                  timeoutMs: form.timeoutMs,
                  mode: testMode,
                },
              })
            }
            result={results["form"]}
            busy={save.isPending || test.isPending}
          />
        ) : null}

        <section className="space-y-3">
          <h2 className="text-lg font-semibold">Recent engine status changes</h2>
          {(q.data?.events ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">No status changes recorded yet.</p>
          ) : (
            <ul className="divide-y divide-border rounded-lg border border-border">
              {(q.data?.events ?? []).map((event) => (
                <li key={event.id} className="flex flex-wrap items-center gap-3 p-3 text-sm">
                  <span className="font-medium">{event.engineName}</span>
                  <span className="text-muted-foreground">
                    {event.fromStatus} → {event.toStatus}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {formatIst(event.createdAt)}
                  </span>
                  <span className="w-full truncate text-xs text-muted-foreground">{event.message}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </AppShell>
  );
}

function EngineCard({
  slot,
  engine,
  result,
  busy,
  onEdit,
  onSaveBaseUrl,
  onPriority,
  onTest,
  onToggle,
  onDelete,
}: {
  slot: number;
  engine: EngineSummary;
  result?: TestResult | undefined;
  busy: boolean;
  onEdit: () => void;
  onSaveBaseUrl: (baseUrl: string) => void;
  onPriority: (priority: number) => void;
  onTest: (mode: "CONNECTION" | "COMPILER") => void;
  onToggle: (enabled: boolean) => void;
  onDelete: () => void;
}) {
  const [baseUrl, setBaseUrl] = useState(engine.baseUrl);
  useEffect(() => setBaseUrl(engine.baseUrl), [engine.baseUrl]);

  const successRate = engine.requestCount
    ? Math.round((engine.successCount / engine.requestCount) * 100)
    : null;
  const dirty = baseUrl.trim() !== engine.baseUrl;

  return (
    <li className="rounded-lg border border-border bg-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-3">
            <h3 className="font-semibold">
              Execution Engine {slot} · {engine.name}
            </h3>
            <Badge variant="secondary">Priority {engine.priority}</Badge>
            <Badge variant="outline">{engine.enabled ? "Enabled" : "Disabled"}</Badge>
          </div>
          <div className="flex flex-wrap items-center gap-3 pt-1">
            <span className="flex items-center gap-2 text-xs text-muted-foreground">
              API
              <HealthBadge status={engine.apiHealth} />
            </span>
            <span className="flex items-center gap-2 text-xs text-muted-foreground">
              Execution
              <HealthBadge status={engine.executionHealth} />
            </span>
          </div>
          {engine.executionHealth !== "HEALTHY" && engine.lastError ? (
            <p className="max-w-2xl text-xs text-destructive">Reason: {engine.lastError}</p>
          ) : null}

          <p className="text-sm text-muted-foreground">
            {PROVIDER_LABELS[engine.provider]}
            {engine.apiKeySet ? " · API key stored on the server" : " · no API key"}
          </p>
          <p className="text-xs text-muted-foreground">
            Health endpoint: {engine.baseUrl ? healthEndpointFor(engine.provider, engine.baseUrl) : "—"}
          </p>
          <p className="text-xs text-muted-foreground">
            Languages: {engine.supportedLanguages.map((lang) => LANGUAGE_LABELS[lang]).join(", ")} · timeout{" "}
            {Math.round(engine.timeoutMs / 1000)}s · latency {engine.lastLatencyMs}ms · failures{" "}
            {engine.failureCount}
            {successRate === null ? "" : ` · ${successRate}% success over ${engine.requestCount} runs`}
          </p>
          <p className="text-xs text-muted-foreground">
            Last health check:{" "}
            {engine.lastHealthCheck ? formatIst(engine.lastHealthCheck) : "never"}
          </p>
          {engine.healthDetail ? (
            <p
              className={`max-w-2xl text-xs ${
                engine.healthStatus === "HEALTHY" ? "text-muted-foreground" : "text-destructive"
              }`}
            >
              Last diagnostic: {engine.healthDetail}
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-2 pr-2">
            <Switch checked={engine.enabled} onCheckedChange={onToggle} disabled={busy} aria-label="Enabled" />
            <span className="text-xs text-muted-foreground">{engine.enabled ? "Enabled" : "Disabled"}</span>
          </div>
          <Button size="sm" variant="secondary" onClick={() => onTest("CONNECTION")} disabled={busy}>
            Test connection
          </Button>
          <Button size="sm" variant="secondary" onClick={() => onTest("COMPILER")} disabled={busy}>
            Test C compiler
          </Button>
          <Button size="sm" variant="outline" onClick={onEdit} disabled={busy}>
            Edit
          </Button>
          <Button size="sm" variant="ghost" onClick={onDelete} disabled={busy}>
            Delete
          </Button>
        </div>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_auto_auto] sm:items-end">
        <div className="space-y-2">
          <Label htmlFor={`base-url-${engine.id}`}>Base URL</Label>
          <Input
            id={`base-url-${engine.id}`}
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://my-judge0-host"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`priority-${engine.id}`}>Priority</Label>
          <Input
            id={`priority-${engine.id}`}
            type="number"
            min={1}
            max={99}
            className="w-24"
            defaultValue={engine.priority}
            onBlur={(e) => {
              const next = Number(e.target.value) || engine.priority;
              if (next !== engine.priority) onPriority(next);
            }}
          />
        </div>
        <Button size="sm" onClick={() => onSaveBaseUrl(baseUrl.trim())} disabled={busy || !dirty}>
          Save
        </Button>
      </div>

      {result ? <TestPanel result={result} /> : null}
    </li>
  );
}

function TestPanel({ result }: { result: TestResult }) {
  const compiler = result.compilerTest;
  return (
    <pre className="mt-4 max-h-72 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3 text-xs">
      {[
        `Test:       ${result.mode === "COMPILER" ? "Connection + C compiler" : "Connection only"}`,
        `Provider:   ${PROVIDER_LABELS[result.provider as Provider] ?? result.provider}`,
        `URL:        ${result.baseUrl}`,
        `Endpoint:   ${result.endpoint}`,
        `Connection: ${result.connected ? "OK — valid JSON API response" : "FAILED"}`,
        `Status:     ${result.status}`,
        `Latency:    ${result.latencyMs} ms`,
        result.mode === "COMPILER" ? `Compiler:   ${compiler?.ok ? "PASS" : "FAIL"}` : "",
        result.mode === "COMPILER" ? `Execution:  ${compiler?.status ?? "—"}` : "",
        compiler?.output ? `Output:     ${compiler.output.trim()}` : "",
        compiler?.compileOutput ? `Compile log: ${compiler.compileOutput.trim()}` : "",
        compiler ? `Time:       ${compiler.executionTimeMs} ms` : "",
        compiler ? `Memory:     ${compiler.memoryKb} KB` : "",
        result.languages.length ? `Languages:  ${result.languages.slice(0, 12).join(", ")}` : "",
        `Diagnostic: ${result.detail}`,
        `Tested:     ${formatIst(result.testedAt)}`,
      ]
        .filter(Boolean)
        .join("\n")}
    </pre>
  );
}

function EngineForm({
  state,
  onChange,
  onCancel,
  onSave,
  onTest,
  result,
  busy,
}: {
  state: FormState;
  onChange: (next: FormState) => void;
  onCancel: () => void;
  onSave: () => void;
  onTest: (mode: "CONNECTION" | "COMPILER") => void;
  result?: TestResult | undefined;
  busy: boolean;
}) {
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => onChange({ ...state, [key]: value });
  const toggleLanguage = (lang: Language) =>
    set(
      "supportedLanguages",
      state.supportedLanguages.includes(lang)
        ? state.supportedLanguages.filter((item) => item !== lang)
        : [...state.supportedLanguages, lang],
    );

  return (
    <section className="rounded-lg border border-border bg-card p-5">
      <h2 className="text-lg font-semibold">
        {state.id ? `Edit ${state.name}` : `Configure Execution Engine ${state.slot}`}
      </h2>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="engine-name">Display name</Label>
          <Input
            id="engine-name"
            value={state.name}
            onChange={(e) => set("name", e.target.value)}
            placeholder="Judge0 (self-hosted)"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="engine-provider">Provider</Label>
          <select
            id="engine-provider"
            className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
            value={state.provider}
            onChange={(e) => set("provider", e.target.value as Provider)}
          >
            {PROVIDERS.map((provider) => (
              <option key={provider} value={provider}>
                {PROVIDER_LABELS[provider]}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-2 sm:col-span-2">
          <Label htmlFor="engine-url">Base URL (API root)</Label>
          <Input
            id="engine-url"
            value={state.baseUrl}
            onChange={(e) => set("baseUrl", e.target.value)}
            placeholder="https://my-engine-host"
          />
          <p className="text-xs text-muted-foreground">
            Store the API root only — no <code>/api/v2</code>, <code>/languages</code>, <code>/submissions</code> or{" "}
            <code>/about</code> suffix. The backend calls{" "}
            {state.baseUrl.trim() ? healthEndpointFor(state.provider, state.baseUrl.trim().replace(/\/+$/, "")) : "—"}.
            localhost and 127.0.0.1 cannot be reached from the CodeArena backend.
          </p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="engine-key">API key / token (optional)</Label>
          <Input
            id="engine-key"
            type="password"
            value={state.apiKey}
            onChange={(e) => set("apiKey", e.target.value)}
            placeholder={state.id ? "leave blank to keep the stored key" : "only if the engine requires one"}
          />
          <p className="text-xs text-muted-foreground">
            Stored on the server only and never sent to participants. Leave blank for self-hosted engines with no
            authentication.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="engine-priority">Priority</Label>
            <Input
              id="engine-priority"
              type="number"
              min={1}
              max={99}
              value={state.priority}
              onChange={(e) => set("priority", Number(e.target.value) || 1)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="engine-timeout">Timeout (ms)</Label>
            <Input
              id="engine-timeout"
              type="number"
              min={2000}
              max={60000}
              step={1000}
              value={state.timeoutMs}
              onChange={(e) => set("timeoutMs", Number(e.target.value) || 20000)}
            />
          </div>
        </div>
        <div className="space-y-2 sm:col-span-2">
          <Label>Supported languages</Label>
          <div className="flex flex-wrap gap-2">
            {EXECUTABLE_LANGUAGES.map((lang) => (
              <Button
                key={lang}
                type="button"
                size="sm"
                variant={state.supportedLanguages.includes(lang) ? "default" : "outline"}
                onClick={() => toggleLanguage(lang)}
              >
                {LANGUAGE_LABELS[lang]}
              </Button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2 sm:col-span-2">
          <Switch
            checked={state.enabled}
            onCheckedChange={(checked) => set("enabled", checked)}
            aria-label="Enabled"
          />
          <span className="text-sm text-muted-foreground">Enabled for routing</span>
        </div>
      </div>
      <div className="mt-5 flex flex-wrap gap-2">
        <Button onClick={onSave} disabled={busy || !state.name.trim() || !state.supportedLanguages.length}>
          {busy ? "Saving…" : "Save engine"}
        </Button>
        <Button variant="secondary" onClick={() => onTest("CONNECTION")} disabled={busy || !state.baseUrl.trim()}>
          Test connection
        </Button>
        <Button variant="secondary" onClick={() => onTest("COMPILER")} disabled={busy || !state.baseUrl.trim()}>
          Test C compiler
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
      {result ? <TestPanel result={result} /> : null}
    </section>
  );
}
