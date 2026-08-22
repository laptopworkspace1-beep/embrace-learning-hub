import { Badge } from "@/components/ui/badge";
import type { StatusTone } from "@/lib/exec-status";

function Block({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="mono-label text-muted-foreground">{label}</p>
      <pre className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 font-mono text-xs">
        {value.length ? value : "(empty)"}
      </pre>
    </div>
  );
}

/**
 * Compiler-style console: the exact input sent to the engine, the exact stdout
 * produced, real compiler/runtime errors, timings and the status. Newlines are
 * preserved verbatim — separate program output lines stay separate.
 */
export function CompilerOutput({
  status,
  tone,
  input,
  output,
  compileOutput,
  error,
  durationMs,
  memoryKb,
  message,
}: {
  status: string;
  tone: StatusTone;
  input?: string;
  output?: string;
  compileOutput?: string;
  error?: string;
  durationMs?: number;
  memoryKb?: number;
  message?: string;
}) {
  return (
    <section className="surface mt-4 rounded-lg border border-border/70 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-sm font-semibold">Compiler output</h3>
        <Badge variant={tone === "ok" ? "default" : tone === "error" ? "destructive" : "secondary"}>
          Status: {status}
        </Badge>
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <Block label="Input" value={input ?? ""} />
        <Block label="Output" value={output ?? ""} />
      </div>

      {compileOutput ? (
        <div className="mt-3">
          <Block label="Compiler messages" value={compileOutput} />
        </div>
      ) : null}
      <div className="mt-3">
        <Block label="Error" value={error ?? ""} />
      </div>

      <div className="mt-3 flex flex-wrap gap-4 font-mono text-xs text-muted-foreground">
        <span>Execution time: {durationMs ?? 0} ms</span>
        <span>Memory: {memoryKb ?? 0} KB</span>
        {message ? <span>{message}</span> : null}
      </div>
    </section>
  );
}
