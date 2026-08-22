import { Badge } from "@/components/ui/badge";

export type VisibleTest = { index: number; input: string; expectedOutput: string };

export type TestRun = {
  index: number;
  passed: boolean;
  status?: string | undefined;
  actual?: string | undefined;
  error?: string | undefined;
  durationMs?: number | undefined;
};

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="mono-label text-muted-foreground">{label}</p>
      <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-2 font-mono text-xs">
        {value.length ? value : "(empty)"}
      </pre>
    </div>
  );
}

function statusFor(run: TestRun | undefined): { label: string; tone: "ok" | "error" | "idle" } {
  if (!run) return { label: "Not run", tone: "idle" };
  const raw = (run.status ?? "").toLowerCase();
  if (raw.includes("compil")) return { label: "Compilation Error", tone: "error" };
  if (raw.includes("time")) return { label: "Time Limit Exceeded", tone: "error" };
  if (raw.includes("runtime") || raw.includes("terminated"))
    return { label: "Runtime Error", tone: "error" };
  return run.passed ? { label: "Passed", tone: "ok" } : { label: "Failed", tone: "error" };
}

/**
 * Student-facing test cases: the admin's configured input and expected output,
 * plus the program's own output from the last run — always kept separate.
 */
export function TestCaseResults({
  tests,
  runs,
  title = "Test cases",
}: {
  tests: VisibleTest[];
  runs?: TestRun[] | undefined;
  title?: string | undefined;
}) {
  if (!tests.length) return null;
  return (
    <section className="mt-6">
      <h2 className="text-sm font-semibold">{title}</h2>
      <div className="mt-3 space-y-3">
        {tests.map((test) => {
          const run = runs?.find((r) => r.index === test.index);
          const status = statusFor(run);
          return (
            <div key={test.index} className="surface rounded-lg border border-border/70 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm font-medium">Test Case {test.index}</p>
                <div className="flex items-center gap-2">
                  {run?.durationMs != null ? (
                    <span className="font-mono text-xs text-muted-foreground">
                      {run.durationMs} ms
                    </span>
                  ) : null}
                  <Badge
                    variant={
                      status.tone === "ok"
                        ? "default"
                        : status.tone === "error"
                          ? "destructive"
                          : "secondary"
                    }
                  >
                    {status.label}
                  </Badge>
                </div>
              </div>

              <div className="mt-3 grid gap-3 sm:grid-cols-3">
                <Field label="Input" value={test.input} />
                <Field label="Expected Output" value={test.expectedOutput} />
                <Field label="Program Output" value={run?.actual ?? ""} />
              </div>
              {run?.error ? (
                <div className="mt-3">
                  <Field label="Errors" value={run.error} />
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}
