import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { getLiveState, heartbeat, logActivity } from "@/lib/live.functions";

/**
 * Keeps a student screen in lockstep with the server: it polls the
 * authoritative round state every two seconds (so an admin START appears
 * without a manual refresh), sends a presence heartbeat with the current
 * fullscreen status, and reports monitoring signals to the admin feed.
 */
export function useLiveSync(roundId: string | null = null, options?: { monitor?: boolean }) {
  const monitor = options?.monitor ?? true;
  const [fullscreen, setFullscreen] = useState(false);
  const lastSignal = useRef<string | null>(null);
  const lastLog = useRef(0);

  const live = useQuery({
    queryKey: ["live-state"],
    queryFn: () => getLiveState(),
    refetchInterval: 2000,
    refetchIntervalInBackground: true,
    retry: false,
  });

  const enterFullscreen = useCallback(() => {
    if (typeof document === "undefined" || document.fullscreenElement) return;
    void document.documentElement.requestFullscreen?.().catch(() => undefined);
  }, []);

  // Track fullscreen locally so the heartbeat always carries the truth.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const sync = () => setFullscreen(Boolean(document.fullscreenElement));
    sync();
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, []);

  // Presence heartbeat. The fullscreen flag is read through a ref so a local
  // fullscreen change does not restart the interval and fire an extra beat.
  const fullscreenRef = useRef(fullscreen);
  fullscreenRef.current = fullscreen;
  useEffect(() => {
    let cancelled = false;
    const beat = () => {
      if (cancelled) return;
      void heartbeat({ data: { roundId, fullscreen: fullscreenRef.current } }).catch(
        () => undefined,
      );
    };
    beat();
    // Presence stays "online" for 20s server-side, so an 8s beat keeps the
    // admin monitor just as accurate with ~40% fewer writes per student.
    const id = setInterval(beat, 8000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [roundId]);

  // Monitoring feed.
  useEffect(() => {
    if (!monitor || typeof document === "undefined") return;
    const send = (type: string, details: string, severity: "INFO" | "WARNING" | "CRITICAL") => {
      const now = Date.now();
      if (now - lastLog.current < 1000) return;
      lastLog.current = now;
      void logActivity({ data: { roundId, type, details, severity } }).catch(() => undefined);
    };
    send("CONNECTED", "Opened the competition screen", "INFO");

    const onVisibility = () =>
      document.visibilityState === "hidden"
        ? send("TAB_SWITCH", "Switched away from the tab", "WARNING")
        : send("TAB_RETURN", "Returned to the tab", "INFO");
    const onBlur = () => send("WINDOW_BLUR", "Window lost focus", "WARNING");
    const onFs = () =>
      send(
        document.fullscreenElement ? "FULLSCREEN_ENTER" : "FULLSCREEN_EXIT",
        document.fullscreenElement ? "Entered fullscreen" : "Left fullscreen",
        document.fullscreenElement ? "INFO" : "CRITICAL",
      );
    const onCopy = () => send("COPY", "Copied content", "WARNING");
    const onPaste = () => send("PASTE", "Pasted content", "WARNING");
    const onContext = () => send("RIGHT_CLICK", "Opened the context menu", "INFO");
    const onUnload = () => send("DISCONNECTED", "Left the competition screen", "WARNING");

    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("blur", onBlur);
    document.addEventListener("fullscreenchange", onFs);
    document.addEventListener("copy", onCopy);
    document.addEventListener("paste", onPaste);
    document.addEventListener("contextmenu", onContext);
    window.addEventListener("pagehide", onUnload);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("fullscreenchange", onFs);
      document.removeEventListener("copy", onCopy);
      document.removeEventListener("paste", onPaste);
      document.removeEventListener("contextmenu", onContext);
      window.removeEventListener("pagehide", onUnload);
    };
  }, [monitor, roundId]);

  // Admin fullscreen broadcast: a new signal re-prompts the student.
  const signalAt = live.data?.fullscreenSignalAt ?? null;
  useEffect(() => {
    if (!signalAt || signalAt === lastSignal.current) return;
    lastSignal.current = signalAt;
    if (live.data?.fullscreenRequired) enterFullscreen();
  }, [signalAt, live.data?.fullscreenRequired, enterFullscreen]);

  const rounds = live.data?.rounds ?? [];
  const round = roundId ? (rounds.find((r) => r.id === roundId) ?? null) : null;

  return {
    live: live.data ?? null,
    rounds,
    round,
    isLoading: live.isLoading,
    fullscreen,
    enterFullscreen,
    needsFullscreen: Boolean(live.data?.fullscreenRequired) && !fullscreen,
  };
}
