/**
 * Bootstrap persistence used only until PostgreSQL can be reached.
 *
 * Deployment secrets are the restart-safe bootstrap source. A local JSON file
 * is supported for self-hosted installations with a persistent volume. There
 * is deliberately no process-memory fallback: a successful write is durable or
 * it fails.
 */
export const CONFIG_KEYS = [
  "APP_SESSION_SECRET",
  "ADMIN_EMAIL",
  "ADMIN_PASSWORD",
  "DEFAULT_STUDENT_PASSWORD",
  "OWN_SUPABASE_DB_URL",
  "OWN_SUPABASE_SERVICE_ROLE_KEY",
] as const;

export type ConfigKey = (typeof CONFIG_KEYS)[number];
export type BootstrapStore = Partial<Record<ConfigKey, string>>;

function filePath(): string {
  return process.env["BOOTSTRAP_CONFIG_PATH"] ?? ".data/codearena-config.json";
}

async function readFileStore(): Promise<BootstrapStore> {
  try {
    const { readFile } = await import("node:fs/promises");
    const parsed = JSON.parse(await readFile(filePath(), "utf8")) as Record<string, unknown>;
    const values: BootstrapStore = {};
    for (const key of CONFIG_KEYS) {
      const value = parsed[key];
      if (typeof value === "string" && value.length > 0) values[key] = value;
    }
    return values;
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    if (code === "ENOENT") return {};
    if (error instanceof SyntaxError) {
      throw new Error("The bootstrap configuration store is invalid JSON.");
    }
    return {};
  }
}

/** Reads deployment secrets plus an optional persistent bootstrap file. */
export async function readBootstrap(): Promise<BootstrapStore> {
  const values = await readFileStore();
  for (const key of CONFIG_KEYS) {
    if (values[key]) continue;
    const value = process.env[key];
    if (value) values[key] = value;
  }
  return values;
}

/** Writes the bootstrap file atomically. Throws instead of falling back to RAM. */
export async function writeBootstrap(values: BootstrapStore): Promise<void> {
  const { mkdir, rename, writeFile } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  const path = filePath();
  const temporaryPath = `${path}.${crypto.randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(temporaryPath, JSON.stringify(values, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporaryPath, path);
}