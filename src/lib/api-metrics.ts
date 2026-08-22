/**
 * Per-endpoint API instrumentation for the event dashboard.
 *
 * Usage on a server function:
 *   createServerFn({ method: "POST" }).middleware([apiMetrics("student.runCode")])
 *
 * The label is explicit so the dashboard shows the endpoint an administrator
 * recognises instead of a build hash. Measurement is server-side only, and the
 * server-only monitor module is imported inside the handler so this file stays
 * safe to import from client-reachable *.functions.ts modules.
 */
import { createMiddleware } from "@tanstack/react-start";

export function apiMetrics(label: string) {
  return createMiddleware({ type: "function" }).server(async ({ next }) => {
    const started = Date.now();
    let ok = false;
    try {
      const result = await next();
      ok = true;
      return result;
    } finally {
      // Monitoring must never fail a request, so every call is best effort.
      try {
        const monitor = await import("./event-monitor.server");
        monitor.recordApiCall(label, ok, Date.now() - started);
        // Awaited on purpose: a floating flush keeps writing on a socket that
        // belongs to a request that has already finished, which the Worker
        // runtime rejects. The flush itself is rate-limited to once per 15s,
        // so at most one request in fifteen seconds pays for it.
        await monitor.flushApiMetrics();
      } catch {
        /* ignore */
      }
    }
  });
}

