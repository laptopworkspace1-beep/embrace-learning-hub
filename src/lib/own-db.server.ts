/**
 * Server-only access layer for the customer's own Supabase project.
 * All data lives in THEIR project; nothing here touches any other database.
 * The service-role key never leaves the server.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let cached: SupabaseClient | null = null;
let overrideKey: string | null = null;
let overrideDbUrl: string | null = null;

/**
 * Resolves the Supabase project REST URL from any supported Postgres
 * connection string form:
 *   postgresql://postgres.<ref>:pw@aws-0-<region>.pooler.supabase.com:6543/postgres
 *   postgresql://postgres:pw@db.<ref>.supabase.co:5432/postgres
 *   postgresql://<user>:pw@<ref>.supabase.co:5432/postgres
 * Also accepts a plain project ref or an https project URL.
 */
export function projectUrlFromDbUrl(dbUrl: string): string | null {
  const raw = dbUrl.trim();
  if (!raw) return null;

  // Already a project URL.
  const asUrl = raw.match(/^https?:\/\/([a-z0-9]{16,})\.supabase\.(co|in)/i);
  if (asUrl) return `https://${asUrl[1]}.supabase.co`;

  // Bare project ref.
  if (/^[a-z0-9]{16,}$/i.test(raw)) return `https://${raw}.supabase.co`;

  // username of the form postgres.<ref>
  const viaUser = raw.match(/:\/\/[^:/@]*postgres\.([a-z0-9]{16,})[:@]/i);
  if (viaUser) return `https://${viaUser[1]}.supabase.co`;

  // host of the form db.<ref>.supabase.co or <ref>.supabase.co
  const viaHost = raw.match(/@(?:db\.)?([a-z0-9]{16,})\.supabase\.(?:co|in)/i);
  if (viaHost) return `https://${viaHost[1]}.supabase.co`;

  return null;
}


/**
 * Applies connection overrides stored in the configuration table so the
 * running server can switch credentials without a redeploy.
 */
export function applyOwnDbOverrides(next: { dbUrl?: string | null; serviceRoleKey?: string | null }) {
  let changed = false;
  if (next.dbUrl !== undefined && next.dbUrl !== overrideDbUrl) {
    overrideDbUrl = next.dbUrl;
    changed = true;
  }
  if (next.serviceRoleKey !== undefined && next.serviceRoleKey !== overrideKey) {
    overrideKey = next.serviceRoleKey;
    changed = true;
  }
  if (changed) cached = null;
}

/** Service-role client for the customer's project (server-side only). */
export function ownDb(): SupabaseClient {
  if (cached) return cached;

  const key = overrideKey ?? process.env["OWN_SUPABASE_SERVICE_ROLE_KEY"];
  const url =
    (overrideDbUrl ? projectUrlFromDbUrl(overrideDbUrl) : null) ??
    process.env["OWN_SUPABASE_URL"] ??
    projectUrlFromDbUrl(process.env["OWN_SUPABASE_DB_URL"] ?? "") ??
    null;

  if (!key || !url) {
    throw new Error(
      "The application is not connected to the Supabase project. Missing OWN_SUPABASE_SERVICE_ROLE_KEY or OWN_SUPABASE_URL.",
    );
  }


  cached = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: (input, init) => {
        const h = new Headers(init?.headers);
        if (key.startsWith("sb_") && h.get("Authorization") === `Bearer ${key}`) {
          h.delete("Authorization");
        }
        h.set("apikey", key);
        return fetch(input, { ...init, headers: h });
      },
    },
  });
  return cached;
}

export function newId(): string {
  return crypto.randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** Writes an entry to the existing audit_logs table. */
export async function audit(entry: {
  actorUserId?: string | null;
  targetUserId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
}) {
  const { error } = await ownDb()
    .from("audit_logs")
    .insert({
      id: newId(),
      actorUserId: entry.actorUserId ?? null,
      targetUserId: entry.targetUserId ?? null,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      metadata: entry.metadata ?? {},
      createdAt: nowIso(),
    });
  if (error) console.error("[audit] failed", entry.action, error.message);
}
