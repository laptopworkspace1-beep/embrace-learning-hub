import { useRef } from "react";

/**
 * Turns the server's `remainingSeconds` (which arrives fresh every poll) into a
 * stable absolute deadline.
 *
 * The server stays authoritative — the deadline is always derived from its
 * value — but a new ISO string is only produced when the server clock actually
 * disagrees with the deadline we are already counting down to by more than the
 * tolerance. Without this, every 2s poll handed the countdown a brand new
 * prop and re-rendered everything below it for no visible change.
 */
export function useStableDeadline(
  remainingSeconds: number,
  resetKey?: string | number | null,
  toleranceMs = 2500,
): string | null {
  const ref = useRef<{ endsAt: string | null; key: string | number | null | undefined }>({
    endsAt: null,
    key: resetKey,
  });

  if (remainingSeconds <= 0) {
    ref.current = { endsAt: null, key: resetKey };
    return null;
  }

  const projected = Date.now() + remainingSeconds * 1000;
  const current = ref.current.endsAt ? Date.parse(ref.current.endsAt) : NaN;
  const drifted = Number.isNaN(current) || Math.abs(projected - current) > toleranceMs;

  if (drifted || ref.current.key !== resetKey) {
    ref.current = { endsAt: new Date(projected).toISOString(), key: resetKey };
  }
  return ref.current.endsAt;
}
