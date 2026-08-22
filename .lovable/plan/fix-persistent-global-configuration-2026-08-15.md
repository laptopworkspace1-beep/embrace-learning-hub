# Fix persistent global configuration

## Root cause

- The current bootstrap store writes to `.data/codearena-config.json`, which is not a durable volume in the deployed server runtime.
- When that write fails, the code silently keeps configuration in a module-level object, so another server instance or restart sees an empty installation.
- `GET /api/bootstrap/status` catches every configuration error and reports `BOOTSTRAP`, incorrectly treating temporary failures as an unconfigured app.
- Database client overrides are populated only when configuration status is requested or a value is saved, rather than being loaded through one authoritative service.

## Implementation

1. **Create one `ConfigurationService`**
   - Provide `getStatus()`, `get(key)`, `set(key, value)`, and `isConfigured()`.
   - Centralize validation-safe reads, runtime database credential application, and status calculation.
   - Remove process memory as a persistence fallback.

2. **Use durable storage in two stages**
   - Keep the existing bootstrap store only for the credentials needed to reach PostgreSQL, with deployment secrets as the restart-safe bootstrap source.
   - Once the configured PostgreSQL connection is reachable, create/use one additive application-configuration table and migrate the six effective values into it.
   - Read normal-mode configuration from PostgreSQL on every fresh backend instance; never erase stored values when PostgreSQL is temporarily unavailable.
   - Preserve all existing competition tables, rows, migrations, and features.

3. **Make runtime consumers authoritative**
   - Route session secrets, admin bootstrap credentials, student default password, and database client setup through `ConfigurationService`.
   - Initialize database overrides from the service rather than depending on a page/status request.
   - Keep secret values server-only.

4. **Correct status behavior and API**
   - Add `GET /api/configuration/status` returning only `{ "configured": true|false }`.
   - Return `configured: false` only when durable storage genuinely contains no complete configuration.
   - Return an error status for storage/connection failures instead of converting them to bootstrap mode.
   - Keep the richer internal status response secret-safe for the configuration page.

5. **Update the configuration page behavior**
   - After setup, show “Application Configured” plus database, session secret, admin account, student password, and service-role status.
   - Keep replacement fields optional and empty; never require existing secrets to be entered merely to view the page.
   - On request failure, show a connection/error state and do not render first-time configuration.

## Verification

- Add focused tests for persistence selection, status semantics, no in-memory fallback, and error-vs-unconfigured behavior.
- Verify `/`, `/auth`, `/admin`, and `/configuration` in separate browser tabs after saving.
- Verify a hard refresh keeps normal mode.
- Restart the backend process, then re-check homepage, auth, configuration status, database connection, admin login, and admin dashboard.
- Confirm no secret values appear in status API responses or browser output.
