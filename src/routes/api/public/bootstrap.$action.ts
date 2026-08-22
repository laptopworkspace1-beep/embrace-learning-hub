/**
 * Bootstrap configuration API — intentionally public (setup endpoint).
 *
 * These endpoints work with NO database configured and never touch Supabase
 * Auth or Lovable Cloud. Secrets are only ever written, never read back.
 *
 *   GET  /api/public/bootstrap/status
 *   POST /api/public/bootstrap/test-database          { value }
 *   POST /api/public/bootstrap/test-service-role-key  { value }
 *   POST /api/public/bootstrap/save                   { key, value }
 *   POST /api/public/bootstrap/generate-session-secret
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

const valueSchema = z.object({ value: z.string().min(1).max(4096) });
const saveSchema = z.object({
  key: z.enum(CONFIG_KEY_VALUES),
  value: z.string().min(1).max(4096),
});

export const Route = createFileRoute("/api/public/bootstrap/$action")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        if (params.action !== "status") return new Response("Not found", { status: 404 });
        const { getConfigStatus } = await import("@/lib/app-config.server");
        return Response.json(
          { backend: "online", ...(await getConfigStatus()) },
          { headers: { "cache-control": "no-store" } },
        );
      },
      POST: async ({ params, request }) => {
        const body = await request.json().catch(() => null);
        const config = await import("@/lib/app-config.server");

        // Open only until the deployment is fully configured; afterwards the
        // caller must be the signed-in administrator.
        try {
          await config.assertConfigurationMutationAllowed();
        } catch (error) {
          return Response.json(
            { ok: false, reason: (error as Error).message },
            { status: 403, headers: { "cache-control": "no-store" } },
          );
        }

        if (params.action === "generate-session-secret") {
          const result = await config.setConfig(
            "APP_SESSION_SECRET",
            config.generateSessionSecret(),
          );
          return Response.json({ ok: true, durable: result.durable, restartRequired: true });
        }

        if (params.action === "test-database") {
          const parsed = valueSchema.safeParse(body);
          if (!parsed.success) return Response.json({ ok: false, reason: "Invalid request." });
          return Response.json(await config.testDatabaseUrl(parsed.data.value.trim()));
        }

        if (params.action === "test-service-role-key") {
          const parsed = valueSchema.safeParse(body);
          if (!parsed.success) return Response.json({ ok: false, reason: "Invalid request." });
          return Response.json(await config.testServiceRoleKey(parsed.data.value.trim()));
        }

        if (params.action === "save") {
          const parsed = saveSchema.safeParse(body);
          if (!parsed.success) {
            return Response.json({ ok: false, reason: "Invalid request." }, { status: 400 });
          }
          const value = parsed.data.value.trim();
          if (parsed.data.key === "OWN_SUPABASE_DB_URL") {
            const test = await config.testDatabaseUrl(value);
            if (!test.ok) {
              return Response.json(
                { ok: false, reason: test.reason ?? "The database connection failed." },
                { status: 400 },
              );
            }
          }
          const { durable } = await config.setConfig(parsed.data.key, value);
          return Response.json({
            ok: true,
            durable,
            restartRequired: parsed.data.key === "APP_SESSION_SECRET",
          });
        }

        return new Response("Not found", { status: 404 });
      },
    },
  },
});
