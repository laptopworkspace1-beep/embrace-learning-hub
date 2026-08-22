import { useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type ProblemLink = { id: string; title: string };

/**
 * Previous / Next plus a compact numeric navigator for the problems in a round.
 * Navigation only changes the route — every workspace autosaves its own code to
 * the database, so moving between problems never loses work.
 */
export function ProblemNav({
  problems,
  currentId,
  kind,
  roundLabel,
  finalLabel,
  onFinalAction,
  finalPending,
  finalDisabled,
}: {
  problems: ProblemLink[];
  currentId: string;
  kind: "debug" | "code";
  roundLabel: string;
  /** Label for the button that replaces Next on the last problem. */
  finalLabel?: string;
  onFinalAction?: (() => void) | undefined;
  finalPending?: boolean;
  finalDisabled?: boolean;
}) {
  const navigate = useNavigate();
  if (problems.length === 0) return null;

  const index = problems.findIndex((p) => p.id === currentId);
  const go = (problemId: string) =>
    void navigate({ to: "/problems/$problemId", params: { problemId }, search: { kind } });

  const prev = index > 0 ? problems[index - 1] : undefined;
  const next = index >= 0 && index < problems.length - 1 ? problems[index + 1] : undefined;

  return (
    <div className="surface mb-5 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/70 px-4 py-3">
      <div>
        <p className="mono-label text-muted-foreground">{roundLabel}</p>
        <p className="text-sm font-medium">
          Problem {index < 0 ? 1 : index + 1} of {problems.length}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-1">
        {problems.map((p, i) => (
          <Button
            key={p.id}
            size="sm"
            variant={p.id === currentId ? "default" : "outline"}
            className={cn("h-8 w-10 font-mono text-xs", p.id === currentId && "ring-2 ring-ring")}
            title={p.title}
            onClick={() => go(p.id)}
          >
            {String(i + 1).padStart(2, "0")}
          </Button>
        ))}
      </div>

      <div className="flex items-center gap-2">
        {problems.length > 1 ? (
          <Button size="sm" variant="outline" disabled={!prev} onClick={() => prev && go(prev.id)}>
            Previous
          </Button>
        ) : null}
        {next ? (
          <Button size="sm" variant="outline" onClick={() => go(next.id)}>
            Next
          </Button>
        ) : onFinalAction ? (
          // Last problem: never a dead Next button — this submits the round.
          <Button size="sm" disabled={finalPending || finalDisabled} onClick={onFinalAction}>
            {finalPending ? "Submitting…" : (finalLabel ?? "Submit round")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
