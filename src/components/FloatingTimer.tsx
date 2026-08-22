import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * Fixed floating countdown. The server sends the authoritative number of
 * seconds left; this component only renders it and ticks locally between
 * refreshes. It never decides when a round is over — it asks the server.
 */
export function FloatingTimer({
  serverSeconds,
  state,
  label,
  onExpire,
  paused = false,
}: {
  serverSeconds: number;
  state: string;
  label: string;
  onExpire?: () => void;
  paused?: boolean;
}) {
  const [seconds, setSeconds] = useState(serverSeconds);
  // Already-expired rounds must not re-fire onExpire on mount: that fired a
  // second, pointless refetch of the whole round payload on every open.
  const fired = useRef(serverSeconds <= 0);

  useEffect(() => {
    setSeconds(serverSeconds);
    if (serverSeconds > 0) fired.current = false;
  }, [serverSeconds]);

  useEffect(() => {
    if (paused) return;
    const id = setInterval(() => {
      setSeconds((s) => {
        const next = Math.max(0, s - 1);
        if (next === 0 && !fired.current) {
          fired.current = true;
          onExpire?.();
        }
        return next;
      });
    }, 1000);
    return () => clearInterval(id);
    // onExpire may be a fresh closure each render
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paused]);

  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const urgent = seconds <= 120 && !paused;

  return (
    <div
      className={cn(
        // Mobile: bottom-right pill so it never covers the header nav or the
        // page title. Desktop: unchanged top-right card.
        "pointer-events-none fixed bottom-4 right-4 z-[100] flex justify-end sm:bottom-auto sm:right-6 sm:top-20",
      )}
      role="timer"
      aria-live="off"
      style={{ opacity: 0.85 }}
    >
      <div
        className={cn(
          "rounded-xl border px-3 py-2 shadow-2xl backdrop-blur-[2px] sm:w-44 sm:p-4",
          "bg-background/80 sm:bg-background/40",
          urgent ? "border-destructive/50" : "border-border/70",
        )}
      >
        <p className="mono-label hidden text-[10px] tracking-widest text-muted-foreground sm:block">
          {label}
        </p>
        <p
          className={cn(
            "font-mono text-xl font-bold tabular-nums sm:mt-1 sm:text-2xl",
            urgent ? "text-destructive" : "text-foreground",
          )}
        >
          {h > 0 ? `${String(h).padStart(2, "0")}:` : ""}
          {String(m).padStart(2, "0")}:{String(s).padStart(2, "0")}
        </p>
        <p className="mt-1 hidden items-center gap-1.5 text-[11px] text-muted-foreground sm:flex">
          <span
            className={cn(
              "inline-block size-2 rounded-full",
              paused ? "bg-amber-500" : state === "LIVE" ? "animate-pulse bg-emerald-500" : "bg-muted-foreground",
            )}
          />
          {paused ? "PAUSED" : state}
        </p>
      </div>
    </div>
  );
}
