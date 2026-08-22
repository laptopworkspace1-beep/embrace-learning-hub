import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

/** The only six keys this endpoint will ever accept. */
const CONFIG_KEY_VALUES = [
  "APP_SESSION_SECRET",
  "ADMIN_EMAIL",
  "ADMIN_PASSWORD",
  "DEFAULT_STUDENT_PASSWORD",
  "OWN_SUPABASE_DB_URL",
  "OWN_SUPABASE_SERVICE_ROLE_KEY",
] as const;

const saveSchema = z.object({
  key: z.enum(CONFIG_KEY_VALUES),
  value: z.string().min(1, "A value is required."),
});

const testSchema = z.object({ value: z.string().min(1) });

/** Status only — no secret value is ever returned. Works with no database. */
export const getConfiguration = createServerFn({ method: "POST" }).handler(async () => {
  const { getConfigStatus } = await import("./app-config.server");
  return getConfigStatus();
});

export const testConfigurationDatabase = createServerFn({ method: "POST" })
  .inputValidator((input: z.infer<typeof testSchema>) => testSchema.parse(input))
  .handler(async ({ data }) => {
    const { testDatabaseUrl, assertConfigurationMutationAllowed } = await import(
      "./app-config.server"
    );
    await assertConfigurationMutationAllowed();
    return testDatabaseUrl(data.value.trim());
  });

export const testConfigurationServiceKey = createServerFn({ method: "POST" })
  .inputValidator((input: z.infer<typeof testSchema>) => testSchema.parse(input))
  .handler(async ({ data }) => {
    const { testServiceRoleKey, assertConfigurationMutationAllowed } = await import(
      "./app-config.server"
    );
    await assertConfigurationMutationAllowed();
    return testServiceRoleKey(data.value.trim());
  });

/** Generates a session secret server-side and stores it. Never returned. */
export const generateConfigurationSecret = createServerFn({ method: "POST" }).handler(async () => {
  const { generateSessionSecret, setConfig, assertConfigurationMutationAllowed } = await import(
    "./app-config.server"
  );
  await assertConfigurationMutationAllowed();
  const result = await setConfig("APP_SESSION_SECRET", generateSessionSecret());
  return { ok: true as const, durable: result.durable, restartRequired: true };
});

export const saveConfiguration = createServerFn({ method: "POST" })
  .inputValidator((input: z.infer<typeof saveSchema>) => saveSchema.parse(input))
  .handler(async ({ data }) => {
    const { setConfig, testDatabaseUrl, assertConfigurationMutationAllowed } = await import(
      "./app-config.server"
    );
    await assertConfigurationMutationAllowed();

    const value = data.value.trim();

    if (data.key === "ADMIN_EMAIL" && !/^[^\s@]+@[^\s@]+$/.test(value)) {
      throw new Error("Enter a valid administrator email address.");
    }
    if (data.key === "APP_SESSION_SECRET" && value.length < 32) {
      throw new Error("The session secret must be at least 32 characters long.");
    }
    if (data.key === "OWN_SUPABASE_DB_URL") {
      const result = await testDatabaseUrl(value);
      if (!result.ok) {
        throw new Error(
          `${result.reason ?? "The database connection failed."} Existing configuration has not been changed.`,
        );
      }
    }

    const { durable } = await setConfig(data.key, value);

    // Best effort only: on a fresh deployment there may be no database yet.
    if (data.key === "ADMIN_EMAIL" || data.key === "ADMIN_PASSWORD") {
      try {
        const { ensureAdminAccount } = await import("./admin-bootstrap.server");
        await ensureAdminAccount(undefined, { force: true });
      } catch {
        /* database not configured yet — the admin is provisioned on first use */
      }
    }

    try {
      const { audit } = await import("./own-db.server");
      await audit({
        actorUserId: null,
        action: "CONFIG_UPDATED",
        entityType: "app_config",
        entityId: data.key,
        metadata: { key: data.key },
      });
    } catch {
      /* auditing requires the application database; ignore during bootstrap */
    }

    return {
      ok: true as const,
      durable,
      restartRequired: data.key === "APP_SESSION_SECRET",
    };
  });
