/**
 * Best-effort rate limiting for competition endpoints.
 *
 * LIMITATION (documented in DEPLOYMENT.md): counters live in the memory of the
 * server instance that handled the request. On a multi-instance deployment the
 * effective limit is per instance, not global. It is enough to stop brute-force
 * password guessing and accidental submit-spam from a single client, and it is
 * deliberately generous so normal competition activity is never blocked.
 */
import { getRequestHeader } from "@tanstack/react-start/server";

type Bucket = { hits: number[]; };

const buckets = new Map<string, Bucket>();
const MAX_KEYS = 5000;

/** Coarse client identity. Never logged, never returned to the client. */
export function clientKey(): string {
  const forwarded = getRequestHeader("x-forwarded-for") ?? "";
  const ip = forwarded.split(",")[0]?.trim() || getRequestHeader("cf-connecting-ip") || "unknown";
  return ip;
}

export type RateRule = { limit: number; windowSeconds: number };

export const RATE_RULES = {
  // Keyed per account (see signIn), not per IP: a whole lab shares one public
  // IP, so an IP-keyed login limit blocked simultaneous exam sign-ins.
  login: { limit: 10, windowSeconds: 60 },
  // Keyed per batch number (see registerStudentAccount), not per IP.
  register: { limit: 8, windowSeconds: 60 },
  run: { limit: 40, windowSeconds: 60 },
  submit: { limit: 60, windowSeconds: 60 },
  violation: { limit: 60, windowSeconds: 60 },
} satisfies Record<string, RateRule>;

/**
 * Throws a user-safe error when the caller exceeded the rule.
 * `scope` groups the counter (e.g. "login"), `subject` narrows it (e.g. IP).
 */
export function enforceRateLimit(scope: keyof typeof RATE_RULES, subject?: string): void {
  const rule = RATE_RULES[scope];
  const key = `${scope}:${subject ?? clientKey()}`;
  const now = Date.now();
  const cutoff = now - rule.windowSeconds * 1000;

  if (buckets.size > MAX_KEYS) buckets.clear(); // bounded memory; worst case resets counters

  const bucket = buckets.get(key) ?? { hits: [] };
  bucket.hits = bucket.hits.filter((t) => t > cutoff);
  if (bucket.hits.length >= rule.limit) {
    buckets.set(key, bucket);
    throw new Error("Too many attempts. Please wait a moment and try again.");
  }
  bucket.hits.push(now);
  buckets.set(key, bucket);
}
