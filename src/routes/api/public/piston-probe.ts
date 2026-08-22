import { createFileRoute } from "@tanstack/react-router";

/**
 * Read-only outbound-connectivity diagnostic for the configured Piston nodes.
 *
 * Administrator-only: the response names the configured nodes and the HTTP
 * status the backend observed, which is infrastructure detail no student needs.
 * It never accepts a URL from the caller (no SSRF surface) and never returns
 * credentials, connection strings or student data.
 */
export const Route = createFileRoute("/api/public/piston-probe")({
  server: {
    handlers: {
      GET: async () => {
        try {
          const { requireAdmin } = await import("@/lib/app-session.server");
          await requireAdmin();
        } catch {
          return new Response(JSON.stringify({ error: "Not found" }), {
            status: 404,
            headers: { "content-type": "application/json", "cache-control": "no-store" },
          });
        }
        const out: Array<Record<string, unknown>> = [];

        try {
          const pool = await import("@/lib/piston-pool.server");
          const nodes = await pool.listNodes();
          for (const node of nodes) {
            const started = Date.now();
            let port = "";
            try {
              const u = new URL(node.url);
              port = u.port || (u.protocol === "https:" ? "443" : "80");
            } catch {
              port = "?";
            }
            try {
              const res = await fetch(`${node.url}/api/v2/runtimes`, {
                method: "GET",
                headers: { accept: "application/json" },
                // Never let a silent VM hold this diagnostic open forever.
                signal: AbortSignal.timeout(8000),
              });

              const body = (await res.text()).slice(0, 200).replace(/\s+/g, " ").trim();
              out.push({
                nodeId: node.nodeId,
                port,
                status: res.status,
                contentType: res.headers.get("content-type") ?? "unknown",
                cfRay: res.headers.has("cf-ray"),
                bodyStart: body,
                ms: Date.now() - started,
              });
            } catch (err) {
              out.push({
                nodeId: node.nodeId,
                port,
                error: err instanceof Error ? `${err.name}: ${err.message}` : "unknown",
                ms: Date.now() - started,
              });
            }
          }
        } catch (err) {
          out.push({ fatal: err instanceof Error ? err.message : "unknown" });
        }
        return new Response(JSON.stringify({ probes: out }, null, 2), {
          status: 200,
          headers: { "content-type": "application/json", "cache-control": "no-store" },
        });
      },
    },
  },
});
