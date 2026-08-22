# CodeArena execution engine (Piston) deployment

## Request path (never changes)

```
Student browser → CodeArena backend (server functions) → Piston → GCC
              ← CodeArena backend ← Piston ←
```

The browser never talks to Piston. `PISTON_BASE_URL` is read only on the
server (inside server-function handlers), is never sent to the client, and is
never shown on the Admin Configuration page.

## Configuration

Single server-side variable:

```
PISTON_BASE_URL=<scheme>://<host>:<port>     # no /api/v2 suffix
```

The backend calls `GET {PISTON_BASE_URL}/api/v2/runtimes` for health and
`POST {PISTON_BASE_URL}/api/v2/execute` for compile/run.

### Local development (Codespace / your machine)

```
PISTON_BASE_URL=http://localhost:2001
```

This is accepted **only** when the app runs on the local dev server, because
there Piston really is on the same host. Verified with:

```
curl http://localhost:2001/api/v2/runtimes
```

### Production (deployed CodeArena backend)

The deployed backend runs in Lovable Cloud's hosting runtime, not in your
Codespace. Therefore:

- `http://localhost:2001`, `127.0.0.1`, `0.0.0.0` → rejected. On the deployed
  backend `localhost` never reaches your Codespace; the request leaves the
  runtime and the edge answers `403 error code: 1003` in `text/plain`. That is
  the 403 you saw — a network/deployment problem, not a compiler, C-code or
  PostgreSQL problem.
- `https://*.app.github.dev` → rejected. Those are browser/proxy endpoints and
  return HTML or Cloudflare pages, never the Piston JSON API.

Production therefore requires a Piston instance that is reachable over the
public internet from the deployed backend. Deploy the same Piston container to
a host you control, for example:

```
docker run -d --name piston_api -p 2000:2000 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  ghcr.io/engineer-man/piston
# then install the C/C++ runtimes as you did in the Codespace
```

Put it behind HTTPS on a stable hostname (a small VM + Caddy/nginx, or any
container host), restrict access to the CodeArena backend, and set:

```
PISTON_BASE_URL=https://piston.<your-domain>
```

No production URL is invented here — supply the address of the Piston service
you deploy.

## Health check

Admin Configuration → Execution engine → **Test connection** runs, server-side:

1. `GET {PISTON_BASE_URL}/api/v2/runtimes` — requires HTTP 200 **and**
   `Content-Type: application/json`. A non-JSON body is never parsed as JSON;
   a short diagnostic is logged server-side instead.
2. Checks a `c` runtime is present.
3. Compiles and runs the reference program

   ```c
   #include <stdio.h>
   int main() { int a = 10; int b = 20; printf("%d\n", a + b); return 0; }
   ```

   and requires the output `30`.

Only when all three pass does it report:

```
Piston: CONNECTED
C Runtime: AVAILABLE
C compile and execution: PASS
```

Otherwise it reports `Piston: UNAVAILABLE` plus a non-secret hint describing
the next step (unset variable, proxy URL, loopback URL in production, or an
unreachable service). Credentials, database URLs, service-role keys, JWT
secrets and the Piston URL itself are never displayed.
