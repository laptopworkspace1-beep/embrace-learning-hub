/**
 * Competition timestamps.
 *
 * Instants are stored in UTC (the database columns are `timestamp without time
 * zone` holding UTC values, so a value arriving without an offset must be read
 * as UTC — not as the viewer's or the server's local time). Everything shown to
 * a human is formatted in the IANA zone `Asia/Kolkata`, never with a hard-coded
 * offset.
 */
export const COMPETITION_TIMEZONE = "Asia/Kolkata";

/** Parses a stored timestamp into a real instant, treating naive values as UTC. */
export function toInstant(value: string | number | Date | null | undefined): Date | null {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "number") return new Date(value);
  const raw = value.trim();
  // "2026-08-17T16:30:00" / "2026-08-17 16:30:00.123" — no zone designator: UTC.
  const naive = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(raw);
  const date = new Date(naive ? `${raw.replace(" ", "T")}Z` : raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

function format(value: Parameters<typeof toInstant>[0], options: Intl.DateTimeFormatOptions) {
  const date = toInstant(value);
  if (!date) return "—";
  return new Intl.DateTimeFormat("en-IN", { timeZone: COMPETITION_TIMEZONE, ...options }).format(date);
}

/** e.g. "17 Aug 2026, 10:42 PM IST" */
export function formatIst(value: Parameters<typeof toInstant>[0]): string {
  const out = format(value, {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  return out === "—" ? out : `${out} IST`;
}

/** e.g. "10:42:07 PM IST" — for dense live feeds. */
export function formatIstTime(value: Parameters<typeof toInstant>[0]): string {
  const out = format(value, { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true });
  return out === "—" ? out : `${out} IST`;
}
