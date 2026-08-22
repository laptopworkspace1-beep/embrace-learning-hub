# Coding Challenge 2026 — Competition Platform

A single full-stack TanStack Start application that runs a three-round coding competition:
Round 1 (MCQ Quiz), Round 2 (Bug Hunt) and Round 3 (Code Sprint), with an administrator
control panel, server-authoritative timing and scoring, anti-cheating signals and results
publication.

## Stack

- **TanStack Start v1** (React 19, Vite 8) — SSR + server functions, one deployable app
- **TypeScript**, **Tailwind CSS v4**, shadcn/ui components
- **Postgres (Supabase)** for all competition data, reached through a server-only
  service-role client
- **Own cookie session auth** (JWT in an httpOnly cookie, mirrored in a `sessions` table)
- **Self-hosted Piston** for server-side C, C++, Java, Python and JavaScript execution

There is no separate Express backend, no Prisma and no Socket.IO server; live updates are
delivered by polling, and all backend logic lives in `createServerFn` handlers.

## Prerequisites

- Bun (or Node 20+) for local development
- Access to the competition Postgres/Supabase project
- The environment values listed in `.env.example`
- A Piston service reachable from the CodeArena backend

## Getting started

```sh
git clone <this-repository-url>
cd coding-event-platform
bun install
cp .env.example .env    # fill in locally; never commit the result
bun run dev             # http://localhost:8080
```

## Scripts

| Command | Purpose |
| --- | --- |
| `bun run dev` | Development server with HMR |
| `bun run build` | Production build (SSR worker + client assets) |
| `bun run lint` | ESLint |
| `bun run format` | Prettier |

## Project layout

```
src/lib/*.functions.ts   server functions callable from the UI
src/lib/*.server.ts      server-only logic (sessions, database, sandbox, scoring)
src/routes/              file-based routes, including /api/public/health
tmpscripts/              additive schema/inspection scripts for the competition DB
```

## Environment variables

Server-only secrets and browser-visible values are documented in `.env.example`.
Anything prefixed `VITE_` is public and ships in the browser bundle — never put a
database URL, session secret, service-role key or admin password there.

`PISTON_BASE_URL` is server-only. For local host-based development it may be
`http://localhost:2001`. Production must use the internal or external address of a
Piston service reachable from the deployed backend; never use a loopback address or a
GitHub Codespaces browser URL in production.

## Health check

`GET /api/public/health` → `{"status":"ok","database":"ok", ...}`. It exposes no
configuration, credentials or connection details.

## Operations

- Deployment, backup/restore, security posture and code-execution isolation:
  see [DEPLOYMENT.md](./DEPLOYMENT.md)
- Event-day runbook: see [COMPETITION_DAY_CHECKLIST.md](./COMPETITION_DAY_CHECKLIST.md)
