import { CONFIG_KEYS, readBootstrap, writeBootstrap, type BootstrapStore } from "./bootstrap-store.server";
import { applyOwnDbOverrides, projectUrlFromDbUrl } from "./own-db.server";
import { ddlAlreadyApplied, forgetDdl, markDdlApplied, requestPg, throwawayPg } from "./pg-request.server";



export { CONFIG_KEYS };
export type ConfigKey = (typeof CONFIG_KEYS)[number];

type ConfigurationStatus = {
  configured: boolean;
  mode: "BOOTSTRAP" | "NORMAL";
  durableStore: boolean;
  fields: Record<ConfigKey, boolean>;
  adminEmail: string;
  database: { configured: boolean; connected: boolean; reason?: string };
};

type PgClient = {
  unsafe: (query: string, parameters?: unknown[]) => Promise<Record<string, unknown>[]>;
  end: (options?: { timeout?: number }) => Promise<void>;
};

const TABLE_SQL = `
  create schema if not exists codearena_private;
  create table if not exists codearena_private.application_configuration (
    key text primary key,
    value text not null,
    updated_at timestamptz not null default now(),
    constraint application_configuration_key_check check (key in (
      'APP_SESSION_SECRET', 'ADMIN_EMAIL', 'ADMIN_PASSWORD',
      'DEFAULT_STUDENT_PASSWORD', 'OWN_SUPABASE_DB_URL',
      'OWN_SUPABASE_SERVICE_ROLE_KEY'
    ))
  )
`;

function isComplete(values: BootstrapStore): boolean {
  return CONFIG_KEYS.every((key) => Boolean(values[key]));
}

/**
 * Clients are request-scoped. Cloudflare Workers refuse to let a socket opened
 * during one request be used by another request handler ("Cannot perform I/O
 * on behalf of a different request"), so nothing is pooled in module scope.
 */
function openDatabase(databaseUrl: string): PgClient {
  return requestPg(databaseUrl) as PgClient;
}

/** Temporary, non-pooled client used only by the Test Connection endpoint. */
function openThrowawayDatabase(databaseUrl: string): PgClient {
  return throwawayPg(databaseUrl) as PgClient;
}

// The configuration DDL is idempotent, so it only needs to run once per
// isolate per connection string. Only the string key is remembered across
// requests — never a promise, which would capture request-scoped I/O.
async function ensureTable(databaseUrl: string): Promise<void> {
  const key = `config:${databaseUrl}`;
  if (ddlAlreadyApplied(key)) return;
  try {
    await openDatabase(databaseUrl).unsafe(TABLE_SQL);
    markDdlApplied(key);
  } catch (error) {
    forgetDdl(key);
    throw error;
  }
}


async function readDatabaseStore(databaseUrl: string): Promise<BootstrapStore> {
  await ensureTable(databaseUrl);
  const rows = await openDatabase(databaseUrl).unsafe(
    "select key, value from codearena_private.application_configuration",
  );
  const values: BootstrapStore = {};
  for (const row of rows) {
    const key = row["key"];
    const value = row["value"];
    if (CONFIG_KEYS.includes(key as ConfigKey) && typeof value === "string" && value) {
      values[key as ConfigKey] = value;
    }
  }
  return values;
}

async function writeDatabaseStore(databaseUrl: string, values: BootstrapStore): Promise<void> {
  await ensureTable(databaseUrl);
  const entries = CONFIG_KEYS.filter((key) => values[key]).map((key) => [key, values[key]!]);
  if (entries.length === 0) return;

  // Single round trip instead of one statement per key.
  const tuples = entries.map((_, index) => `($${index * 2 + 1}, $${index * 2 + 2}, now())`).join(", ");
  await openDatabase(databaseUrl).unsafe(
    `insert into codearena_private.application_configuration (key, value, updated_at)
     values ${tuples}
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    entries.flat(),
  );
}

/** How long a successful configuration read is trusted before re-reading. */
const CONFIG_TTL_MS = 60_000;

type LoadedConfiguration = { values: BootstrapStore; connected: boolean; durable: boolean };

class ConfigurationService {
  /** Cached read of the durable store. PostgreSQL stays the source of truth. */
  private cache: { at: number; state: LoadedConfiguration } | null = null;
  private inFlight: Promise<LoadedConfiguration> | null = null;
  /** Bootstrap → PostgreSQL migration is a one-time job per process. */
  private migrated = false;

  private async readThrough(): Promise<LoadedConfiguration> {
    const bootstrap = await readBootstrap();
    const bootstrapUrl = bootstrap["OWN_SUPABASE_DB_URL"];
    const bootstrapKey = bootstrap["OWN_SUPABASE_SERVICE_ROLE_KEY"];

    applyOwnDbOverrides({ dbUrl: bootstrapUrl ?? null, serviceRoleKey: bootstrapKey ?? null });

    if (!bootstrapUrl) return { values: bootstrap, connected: false, durable: false };

    try {
      const stored = await readDatabaseStore(bootstrapUrl);
      const values = { ...bootstrap, ...stored };
      applyOwnDbOverrides({
        dbUrl: values["OWN_SUPABASE_DB_URL"] ?? null,
        serviceRoleKey: values["OWN_SUPABASE_SERVICE_ROLE_KEY"] ?? null,
      });

      // First successful connection migrates deployment/bootstrap values into
      // PostgreSQL. This is idempotent and never deletes an existing value.
      if (!this.migrated && Object.keys(bootstrap).length > 0) {
        const missing = CONFIG_KEYS.some((key) => bootstrap[key] && stored[key] !== bootstrap[key]);
        if (missing) await writeDatabaseStore(bootstrapUrl, values);
        this.migrated = true;
      }
      return { values, connected: true, durable: true };
    } catch (error) {
      if (isComplete(bootstrap)) {
        console.warn("[configuration] PostgreSQL configuration store is temporarily unavailable");
        return { values: bootstrap, connected: false, durable: true };
      }
      throw new Error("The persistent configuration store is temporarily unavailable.", {
        cause: error,
      });
    }
  }

  private async load(): Promise<LoadedConfiguration> {
    const cached = this.cache;
    if (cached && Date.now() - cached.at < CONFIG_TTL_MS) return cached.state;
    // Collapse concurrent callers onto a single read.
    if (this.inFlight) return this.inFlight;

    this.inFlight = this.readThrough()
      .then((state) => {
        // Only a healthy read refreshes the cache clock; a degraded read must
        // never erase a good configuration.
        if (state.connected || !cached) this.cache = { at: Date.now(), state };
        return state;
      })
      .catch((error: unknown) => {
        // Never drop known-good configuration because of a transient failure.
        if (cached) return cached.state;
        throw error;
      })
      .finally(() => {
        this.inFlight = null;
      });

    return this.inFlight;
  }

  async initialize(): Promise<void> {
    await this.load();
  }

  async get(key: ConfigKey): Promise<string | undefined> {
    return (await this.load()).values[key];
  }

  async set(key: ConfigKey, value: string): Promise<{ durable: true }> {
    const current = await this.load();
    const values = { ...current.values, [key]: value };
    const databaseUrl = values["OWN_SUPABASE_DB_URL"];
    this.cache = null;

    if (databaseUrl) {
      await writeDatabaseStore(databaseUrl, values);
      // Keep the bootstrap pointer restart-safe for local/persistent-volume
      // deployments. Deployment secrets remain the fallback on hosted runs.
      try {
        await writeBootstrap(values);
      } catch {
        // PostgreSQL is already the durable source of truth.
      }
      applyOwnDbOverrides({
        dbUrl: databaseUrl,
        serviceRoleKey: values["OWN_SUPABASE_SERVICE_ROLE_KEY"] ?? null,
      });
      return { durable: true };
    }

    await writeBootstrap(values);
    return { durable: true };
  }

  async isConfigured(): Promise<boolean> {
    return isComplete((await this.load()).values);
  }


  async getStatus(): Promise<ConfigurationStatus> {
    const state = await this.load();
    const fields = {} as Record<ConfigKey, boolean>;
    for (const key of CONFIG_KEYS) fields[key] = Boolean(state.values[key]);
    const configured = isComplete(state.values);
    return {
      configured,
      mode: configured ? "NORMAL" : "BOOTSTRAP",
      durableStore: state.durable,
      fields,
      adminEmail: state.values["ADMIN_EMAIL"] ?? "",
      database: {
        configured: Boolean(state.values["OWN_SUPABASE_DB_URL"]),
        connected: state.connected,
        ...(!state.connected && state.values["OWN_SUPABASE_DB_URL"]
          ? { reason: "Database connection is temporarily unavailable." }
          : {}),
      },
    };
  }
}

export const configurationService = new ConfigurationService();

// Compatibility exports keep existing backend modules on the one service.
export async function getConfig(key: ConfigKey): Promise<string | undefined> {
  return configurationService.get(key);
}

export async function setConfig(key: ConfigKey, value: string): Promise<{ durable: true }> {
  return configurationService.set(key, value);
}

export async function isConfigured(): Promise<boolean> {
  return configurationService.isConfigured();
}

/**
 * The bootstrap/configuration endpoints must stay open on a fresh deployment
 * (there is no admin account yet), but once every key is present they become
 * administrator-only. Without this an anonymous caller could overwrite
 * ADMIN_PASSWORD, the database URL or the session secret on a live event.
 */
export async function assertConfigurationMutationAllowed(): Promise<void> {
  let configured = false;
  try {
    configured = await configurationService.isConfigured();
  } catch {
    configured = false;
  }
  if (!configured) return;

  let isAdmin = false;
  try {
    const { readSession } = await import("./app-session.server");
    const claims = await readSession();
    isAdmin = claims?.role === "ADMIN";
  } catch {
    isAdmin = false;
  }
  if (!isAdmin) {
    throw new Error(
      "This deployment is already configured. Sign in as the administrator to change configuration.",
    );
  }
}

export async function getConfigStatus(): Promise<{
  configured: Record<ConfigKey, boolean>;
  applicationConfigured: boolean;
  mode: "BOOTSTRAP" | "NORMAL";
  durableStore: boolean;
  adminEmail: string;
  database: { configured: boolean; connected: boolean; reason?: string };
}> {
  const status = await configurationService.getStatus();
  // The configuration screen is reachable before sign-in (it has to be, so a
  // fresh deployment can be set up), so the administrator's sign-in identifier
  // is only returned to an administrator. Everyone else sees the status flags.
  let isAdmin = false;
  try {
    const { readSession } = await import("./app-session.server");
    isAdmin = (await readSession())?.role === "ADMIN";
  } catch {
    isAdmin = false;
  }
  return {
    configured: status.fields,
    applicationConfigured: status.configured,
    mode: status.mode,
    durableStore: status.durableStore,
    adminEmail: isAdmin || status.mode === "BOOTSTRAP" ? status.adminEmail : "",
    database: status.database,
  };
}


export function generateSessionSecret(): string {
  const bytes = new Uint8Array(48);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function testDatabaseUrl(dbUrl: string): Promise<{ ok: boolean; reason?: string }> {
  const raw = dbUrl.trim();
  try {
    const parsed = new URL(raw);
    if (!/^postgres(ql)?:$/i.test(parsed.protocol) || !parsed.hostname) throw new Error("invalid");
  } catch {
    return { ok: false, reason: "Invalid database connection URL." };
  }
  let sql: PgClient | null = null;
  try {
    sql = openThrowawayDatabase(raw);
    await sql.unsafe("select 1");
    return { ok: true };
  } catch {
    return { ok: false, reason: "Unable to connect to the database. Please check the database URL and try again." };
  } finally {
    await sql?.end({ timeout: 1 }).catch(() => undefined);
  }
}

export async function testServiceRoleKey(key: string, dbUrl?: string): Promise<{ ok: boolean; reason?: string }> {
  const value = key.trim();
  if (!value) return { ok: false, reason: "Enter a service-role key." };
  const connection = dbUrl?.trim() || (await configurationService.get("OWN_SUPABASE_DB_URL")) || "";
  const projectUrl = projectUrlFromDbUrl(connection);
  if (!projectUrl) return { ok: true, reason: "Service key saved. Validation will occur when the application connects." };
  try {
    const response = await fetch(`${projectUrl}/rest/v1/`, { headers: { apikey: value, Accept: "application/json" } });
    if (response.status === 401 || response.status === 403) return { ok: false, reason: "The service key was rejected." };
    if (response.status >= 500) return { ok: false, reason: "The service is temporarily unavailable." };
    return { ok: true, reason: "Service role key accepted" };
  } catch {
    return { ok: false, reason: "Unable to reach the configured service." };
  }
}