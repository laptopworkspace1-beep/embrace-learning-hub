import { useCallback, useEffect, useRef, useState } from "react";
import { reportViolation } from "@/lib/student.functions";

type ViolationType = "TAB_HIDDEN" | "WINDOW_BLUR" | "FULLSCREEN_EXIT" | "COPY_PASTE";

/**
 * Records integrity signals while a timed attempt is active and offers a
 * fullscreen request for the exam surface. Purely observational: the server
 * decides what a violation means (and when to lock the student out).
 */
export function useProctor(roundId: string | null, active: boolean) {
  const [count, setCount] = useState(0);
  const [locked, setLocked] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const last = useRef(0);

  const requestFullscreen = useCallback(() => {
    if (typeof document === "undefined" || document.fullscreenElement) return;
    void document.documentElement.requestFullscreen?.().catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!active || !roundId) return;

    const report = (type: ViolationType, details: string) => {
      const now = Date.now();
      if (now - last.current < 1500) return;
      last.current = now;
      setCount((c) => c + 1);
      void reportViolation({ data: { type, details, roundId } })
        .then((r) => {
          if (r?.locked) setLocked(true);
        })
        .catch(() => undefined);
    };

    const onVisibility = () => {
      if (document.visibilityState === "hidden") report("TAB_HIDDEN", "Tab left the foreground");
    };
    const onBlur = () => report("WINDOW_BLUR", "Window lost focus");
    const onFullscreen = () => {
      setFullscreen(Boolean(document.fullscreenElement));
      if (!document.fullscreenElement) report("FULLSCREEN_EXIT", "Exited fullscreen");
    };
    const onPaste = () => report("COPY_PASTE", "Paste detected in the attempt view");

    setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("blur", onBlur);
    document.addEventListener("fullscreenchange", onFullscreen);
    document.addEventListener("paste", onPaste);

    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("fullscreenchange", onFullscreen);
      document.removeEventListener("paste", onPaste);
    };
  }, [roundId, active]);

  return { count, locked, fullscreen, requestFullscreen };
}
