import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { Timer } from "lucide-react";

export function CountdownTimer({
  endsAt,
  onExpire,
  className,
}: {
  endsAt: string | null;
  onExpire?: () => void;
  className?: string;
}) {
  const [remaining, setRemaining] = useState(() =>
    endsAt ? Math.max(0, new Date(endsAt).getTime() - Date.now()) : 0,
  );

  useEffect(() => {
    if (!endsAt) return;
    // Fire onExpire only on a genuine >0 → 0 transition, so opening an
    // already-finished round does not trigger an extra refetch.
    let fired = new Date(endsAt).getTime() - Date.now() <= 0;
    const tick = () => {
      const left = Math.max(0, new Date(endsAt).getTime() - Date.now());
      setRemaining(left);
      if (left === 0 && !fired) {
        fired = true;
        onExpire?.();
      }
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
    // onExpire is intentionally excluded: it may be a new closure each render
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endsAt]);

  if (!endsAt) return null;

  const totalSeconds = Math.floor(remaining / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const urgent = totalSeconds <= 120;

  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-md border px-3 py-1.5 font-mono text-sm font-bold tabular-nums",
        urgent
          ? "border-destructive/40 bg-destructive/15 text-destructive"
          : "border-border bg-secondary text-foreground",
        className,
      )}
    >
      <Timer className="size-4" />
      {h > 0 ? `${String(h).padStart(2, "0")}:` : ""}
      {String(m).padStart(2, "0")}:{String(s).padStart(2, "0")}
    </div>
  );
}
