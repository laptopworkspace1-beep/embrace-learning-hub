/**
 * Alias of the bootstrap configuration API at the documented path:
 *
 *   GET  /api/bootstrap/status
 *   POST /api/bootstrap/test-database          { databaseUrl } | { value }
 *   POST /api/bootstrap/test-service-role-key  { value }
 *   POST /api/bootstrap/save                   { key, value }
 *   POST /api/bootstrap/generate-session-secret
 *
 * Works with no database configured. Secrets are only written, never read back,
 * and no raw database error ever reaches the caller.
 */
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

const CONFIG_KEY_VALUES = [
  "APP_SESSION_SECRET",
  "ADMIN_EMAIL",
  "ADMIN_PASSWORD",
  "DEFAULT_STUDENT_PASSWORD",
  "OWN_SUPABASE_DB_URL",
  "OWN_SUPABASE_SERVICE_ROLE_KEY",
] as const;

const valueSchema = z.object({
  value: z.string().min(1).max(4096).optional(),
  databaseUrl: z.string().min(1).max(4096).optional(),
});
const saveSchema = z.object({
  key: z.enum(CONFIG_KEY_VALUES),
  value: z.string().min(1).max(4096),
});

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

export const Route = createFileRoute("/api/bootstrap/$action")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        if (params.action !== "status") return new Response("Not found", { status: 404 });
        try {
          const { getConfigStatus } = await import("@/lib/app-config.server");
          return json({ backend: "online", ...(await getConfigStatus()) });
        } catch {
          return json({ error: "Configuration status is temporarily unavailable." }, 503);
        }
      },
      POST: async ({ params, request }) => {
        try {
          const body: unknown = await request.json().catch(() => null);
          const config = await import("@/lib/app-config.server");

          // Open only during first-time setup; administrator-only afterwards.
          try {
            await config.assertConfigurationMutationAllowed();
          } catch (error) {
            return json({ success: false, message: (error as Error).message }, 403);
          }

          if (params.action === "generate-session-secret") {
            const result = await config.setConfig(
              "APP_SESSION_SECRET",
              config.generateSessionSecret(),
            );
            return json({ success: true, durable: result.durable, restartRequired: true });
          }

          if (params.action === "test-database") {
            const parsed = valueSchema.safeParse(body);
            const url = parsed.success ? (parsed.data.databaseUrl ?? parsed.data.value) : undefined;
            if (!url) return json({ success: false, message: "Invalid database connection URL." });
            const result = await config.testDatabaseUrl(url.trim());
            return json({
              success: result.ok,
              message: result.ok ? "Database connection successful" : (result.reason ?? "Unable to connect to the database"),
            });
          }

          if (params.action === "test-service-role-key") {
            const parsed = valueSchema.safeParse(body);
            const key = parsed.success ? (parsed.data.value ?? "") : "";
            if (!key) return json({ success: false, message: "Enter a service-role key." });
            const result = await config.testServiceRoleKey(key.trim());
            return json({ success: result.ok, message: result.reason ?? "" });
          }

          if (params.action === "save") {
            const parsed = saveSchema.safeParse(body);
            if (!parsed.success) {
              return json({ success: false, message: "Unable to save configuration." }, 400);
            }
            const value = parsed.data.value.trim();
            if (parsed.data.key === "OWN_SUPABASE_DB_URL") {
              const test = await config.testDatabaseUrl(value);
              if (!test.ok) {
                return json(
                  { success: false, message: "Unable to save database configuration." },
                  400,
                );
              }
            }
            const { durable } = await config.setConfig(parsed.data.key, value);
            return json({
              success: true,
              message: "Database configuration saved.",
              durable,
              restartRequired: parsed.data.key === "APP_SESSION_SECRET",
            });
          }

          return new Response("Not found", { status: 404 });
        } catch {
          return json({ success: false, message: "Unable to complete the request." }, 200);
        }
      },
    },
  },
});
