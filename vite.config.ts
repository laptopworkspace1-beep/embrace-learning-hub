// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - TanStack devtools (dev-only, first), tanstackStart, viteReact, tailwindcss, tsConfigPaths,
//     nitro (build-only using cloudflare as a default target), VITE_* env injection, @ path alias,
//     React/TanStack dedupe, error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";

// Vercel builds set VERCEL=1. In that environment we pin Nitro's `vercel`
// preset (Node serverless functions, Build Output API in .vercel/output) so the
// server functions, Postgres/Supabase access and outbound Piston fetches run on
// a Node runtime. Everywhere else the Lovable/Cloudflare default is untouched.
const isVercel = !!process.env["VERCEL"] || process.env["NITRO_PRESET"] === "vercel";

export default defineConfig({
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
  },
  ...(isVercel ? { nitro: { preset: "vercel" as const } } : {}),
});
