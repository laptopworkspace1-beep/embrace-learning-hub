import { useEffect, useRef } from "react";

/**
 * Refetches a query only when the authoritative key actually changes.
 *
 * The naive `useEffect(() => refetch(), [state])` fires on mount as well, which
 * duplicated the page's own first request, and fired again as soon as the 2s
 * live-sync replaced the placeholder state with the real one. This hook records
 * the first *ready* key and then refetches on genuine transitions only.
 */
export function useRefetchOnChange(key: string, refetch: () => void, ready = true) {
  const previous = useRef<string | null>(null);
  const refetchRef = useRef(refetch);
  refetchRef.current = refetch;

  useEffect(() => {
    if (!ready) return;
    if (previous.current === null) {
      previous.current = key;
      return;
    }
    if (previous.current === key) return;
    previous.current = key;
    refetchRef.current();
  }, [key, ready]);
}
