import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  getEventControl,
  saveEventSettings,
  savePistonSettings,
  saveRound3Languages,
  testPistonConnection,
} from "@/lib/admin-manage.functions";

type Round3Language = "C" | "CPP" | "JAVA" | "PYTHON" | "JAVASCRIPT";

const LANGUAGE_OPTIONS: { value: Round3Language; label: string }[] = [
  { value: "C", label: "C" },
  { value: "CPP", label: "C++" },
  { value: "JAVA", label: "Java" },
  { value: "PYTHON", label: "Python" },
  { value: "JAVASCRIPT", label: "JavaScript" },
];

import { AppShell, ADMIN_NAV } from "@/components/AppShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { formatIst } from "@/lib/datetime";

export const Route = createFileRoute("/_authenticated/admin/settings")({
  head: () => ({
    meta: [
      { title: "Settings — CodeArena admin" },
      { name: "description", content: "Event title, proctoring limits, autosave timing and the continuation password." },
      { property: "og:title", content: "Settings — CodeArena admin" },
      { property: "og:description", content: "Configuration for the coding competition." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: AdminSettings,
});

function AdminSettings() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["event-control"], queryFn: () => getEventControl() });

  const [title, setTitle] = useState("");
  const [limit, setLimit] = useState(3);
  const [debounce, setDebounce] = useState(1500);
  const [password, setPassword] = useState("");
  const [pistonEnabled, setPistonEnabled] = useState(true);
  const [pistonTimeout, setPistonTimeout] = useState(20000);
  const [pistonBaseUrl, setPistonBaseUrl] = useState("");
  const [health, setHealth] = useState<string | null>(null);
  const [languages, setLanguages] = useState<Round3Language[]>([]);

  useEffect(() => {
    if (!q.data) return;
    setTitle(q.data.event?.title ?? "");
    setLimit(q.data.settings?.fullscreenViolationLimit ?? 3);
    setDebounce(q.data.settings?.autosaveDebounceMs ?? 1500);
    setPistonEnabled(q.data.settings?.pistonEnabled ?? true);
    setPistonTimeout(q.data.settings?.pistonTimeoutMs ?? 20000);
    setPistonBaseUrl(q.data.settings?.pistonBaseUrl ?? "");
    const stored = (q.data.settings?.round3Languages ?? []) as string[];
    setLanguages(
      LANGUAGE_OPTIONS.filter((o) => stored.includes(o.value)).map((o) => o.value),
    );
  }, [q.data]);

  const saveLanguages = useMutation({
    mutationFn: () => saveRound3Languages({ data: { languages } }),
    onSuccess: () => {
      toast.success("Round 3 languages saved.");
      void qc.invalidateQueries({ queryKey: ["event-control"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not save the languages."),
  });



  const savePiston = useMutation({
    mutationFn: () =>
      savePistonSettings({
        data: { baseUrl: pistonBaseUrl, enabled: pistonEnabled, timeoutMs: pistonTimeout },
      }),
    onSuccess: () => {
      toast.success("Execution engine settings saved.");
      void qc.invalidateQueries({ queryKey: ["event-control"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not save the engine settings."),
  });

  const testPiston = useMutation({
    mutationFn: () => testPistonConnection({ data: { baseUrl: pistonBaseUrl } }),
    onSuccess: (r) => {
      const stamp = formatIst(r.testedAt);
      if (r.connected) {
        setHealth(
          `Piston: CONNECTED\nC Runtime: ${r.cRuntimeVersion ? `C ${r.cRuntimeVersion} ` : ""}${r.cRuntimeAvailable ? "AVAILABLE" : "NOT FOUND"}\nC compile and execution: ${r.executionVerified ? "PASS" : "FAIL"}\nLast tested: ${stamp}`,
        );
        toast.success("Execution engine reachable.");
      } else {
        setHealth(
          `Piston: UNAVAILABLE${r.hint ? `\nDiagnostic: ${r.hint}` : ""}${r.detail ? `\n${r.detail}` : ""}\nLast tested: ${stamp}`,
        );
        toast.error("Execution engine is not reachable.");
      }
    },

    onError: (e) => toast.error(e instanceof Error ? e.message : "Connection test failed."),
  });

  const save = useMutation({
    mutationFn: () =>
      saveEventSettings({
        data: {
          title,
          fullscreenViolationLimit: limit,
          autosaveDebounceMs: debounce,
          ...(password ? { continuationPassword: password } : {}),
        },
      }),
    onSuccess: () => {
      toast.success("Settings saved.");
      setPassword("");
      void qc.invalidateQueries({ queryKey: ["event-control"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not save settings."),
  });

  return (
    <AppShell nav={ADMIN_NAV} title="Settings" subtitle="Applies to the whole event immediately.">
      {q.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : q.isError ? (
        <p className="text-sm text-destructive">Could not load settings.</p>
      ) : (
        <div className="surface max-w-xl rounded-lg border border-border/70 p-6">
          <div className="grid gap-5">
            <div className="grid gap-2">
              <Label htmlFor="title">Event title</Label>
              <Input id="title" value={title} onChange={(e) => setTitle(e.target.value)} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="limit">Fullscreen violation limit</Label>
              <Input
                id="limit"
                type="number"
                value={limit}
                onChange={(e) => setLimit(Number(e.target.value))}
              />
              <p className="text-xs text-muted-foreground">
                A student is locked out of the round after this many proctoring violations.
              </p>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="debounce">Autosave delay (ms)</Label>
              <Input
                id="debounce"
                type="number"
                value={debounce}
                onChange={(e) => setDebounce(Number(e.target.value))}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="cont">Continuation password</Label>
              <Input
                id="cont"
                type="password"
                autoComplete="new-password"
                placeholder={
                  q.data?.settings?.continuationPasswordSet ? "Set — leave blank to keep" : "Not set yet"
                }
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Invigilators type this to let a locked-out student back into their round.
              </p>
            </div>
            <div>
              <Button disabled={save.isPending} onClick={() => save.mutate()}>
                {save.isPending ? "Saving…" : "Save settings"}
              </Button>
            </div>
          </div>

          <div className="mt-8 border-t border-border/70 pt-6">
            <h2 className="text-sm font-semibold">Execution engine</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Round 2 and Round 3 compile and run participant code on this Piston server. Nothing is
              ever executed in the participant&apos;s browser.
            </p>
            <div className="mt-4 grid gap-5">
              <div className="grid gap-2">
                <Label htmlFor="pistonBaseUrl">Piston Base URL</Label>
                <Input
                  id="pistonBaseUrl"
                  type="url"
                  spellCheck={false}
                  placeholder="https://my-piston-host or http://localhost:2001"
                  value={pistonBaseUrl}
                  onChange={(e) => setPistonBaseUrl(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Used by the backend only. Validity is decided by calling{" "}
                  <code>/api/v2/runtimes</code> on this address — any host that answers the Piston
                  API is accepted.
                </p>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="pistonTimeout">Request timeout (ms)</Label>
                <Input
                  id="pistonTimeout"
                  type="number"
                  value={pistonTimeout}
                  onChange={(e) => setPistonTimeout(Number(e.target.value))}
                />
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={pistonEnabled}
                  onChange={(e) => setPistonEnabled(e.target.checked)}
                />
                Engine enabled
              </label>
              <div className="flex flex-wrap gap-3">
                <Button disabled={savePiston.isPending} onClick={() => savePiston.mutate()}>
                  {savePiston.isPending ? "Saving…" : "Save engine settings"}
                </Button>
                <Button
                  variant="outline"
                  disabled={testPiston.isPending}
                  onClick={() => testPiston.mutate()}
                >
                  {testPiston.isPending ? "Testing…" : "Test connection"}
                </Button>
              </div>
              {health ? (
                <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">{health}</p>
              ) : null}

            </div>
          </div>

          <div className="mt-8 border-t border-border/70 pt-6">
            <h2 className="text-sm font-semibold">Round 3 languages</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Only the languages ticked here appear in the Code Sprint editor, and the server rejects
              any submission in a language that is not enabled.
            </p>
            <div className="mt-4 grid gap-2">
              {LANGUAGE_OPTIONS.map((option) => (
                <label key={option.value} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={languages.includes(option.value)}
                    onChange={(e) =>
                      setLanguages((current) =>
                        e.target.checked
                          ? [...current, option.value]
                          : current.filter((l) => l !== option.value),
                      )
                    }
                  />
                  {option.label}
                </label>
              ))}
            </div>
            <div className="mt-4">
              <Button
                disabled={saveLanguages.isPending || languages.length === 0}
                onClick={() => saveLanguages.mutate()}
              >
                {saveLanguages.isPending ? "Saving…" : "Save languages"}
              </Button>
              {languages.length === 0 ? (
                <p className="mt-2 text-xs text-destructive">Enable at least one language.</p>
              ) : null}
            </div>
          </div>
        </div>

      )}
    </AppShell>
  );
}
