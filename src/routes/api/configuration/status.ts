import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/configuration/status")({
  server: {
    handlers: {
      GET: async () => {
        try {
          const { configurationService } = await import("@/lib/app-config.server");
          return Response.json(
            { configured: await configurationService.isConfigured() },
            { headers: { "cache-control": "no-store" } },
          );
        } catch {
          return Response.json(
            { error: "Configuration status is temporarily unavailable." },
            { status: 503, headers: { "cache-control": "no-store" } },
          );
        }
      },
    },
  },
});