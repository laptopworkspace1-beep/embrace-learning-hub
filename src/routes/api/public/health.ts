import { createFileRoute } from "@tanstack/react-router";

/**
 * Liveness / readiness probe. Returns only a coarse status — never any
 * configuration value, credential, connection string or environment variable.
 */
export const Route = createFileRoute("/api/public/health")({
  server: {
    handlers: {
      GET: async () => {
        const started = Date.now();
        let database: "ok" | "degraded" | "unconfigured" = "ok";
        try {
          const { ownDb } = await import("@/lib/own-db.server");
          const { error } = await ownDb().from("rounds").select("id").limit(1);
          if (error) {
            console.error("[health] database check failed", error.message);
            database = "degraded";
          }
        } catch {
          database = "unconfigured";
        }

        const body = {
          status: database === "ok" ? "ok" : "degraded",
          database,
          checkedInMs: Date.now() - started,
          time: new Date().toISOString(),
        };
        return new Response(JSON.stringify(body), {
          status: database === "ok" ? 200 : 503,
          headers: { "content-type": "application/json", "cache-control": "no-store" },
        });
      },
    },
  },
});
