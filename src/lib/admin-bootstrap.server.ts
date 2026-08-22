/**
 * Keeps the administrator account in sync with the server-side bootstrap
 * credentials (ADMIN_EMAIL / ADMIN_PASSWORD). These values live only in the
 * server environment, so they are the source of truth for admin access.
 *
 * This never weakens authorization: it only provisions or repairs the single
 * ADMIN user described by the environment. Everything else (sessions, role
 * checks) is unchanged.
 */
import { hashPassword, verifyPassword } from "./app-session.server";
import { newId, nowIso, ownDb } from "./own-db.server";

let lastRun = 0;

export async function ensureAdminAccount(
  identifier?: string,
  options?: { force?: boolean },
): Promise<void> {
  const { getConfig } = await import("./app-config.server");
  const email = (await getConfig("ADMIN_EMAIL"))?.trim();
  const password = await getConfig("ADMIN_PASSWORD");
  if (!email || !password) return;

  // Only relevant when somebody is actually signing in as the admin.
  if (identifier && identifier.trim().toLowerCase() !== email.toLowerCase()) return;

  // Cheap guard so repeated sign-in attempts do not hammer the database.
  if (!options?.force && Date.now() - lastRun < 5_000) return;
  lastRun = Date.now();

  const db = ownDb();
  const now = nowIso();

  const { data: rows, error } = await db
    .from("users")
    .select("id, role, isActive, passwordHash")
    .ilike("username", email)
    .limit(1);
  if (error) {
    console.error("[admin-bootstrap] lookup failed", error.message);
    return;
  }

  let userId: string;
  const existing = rows?.[0] as
    | { id: string; role: string; isActive: boolean; passwordHash: string }
    | undefined;

  if (existing) {
    userId = existing.id;
    const patch: Record<string, unknown> = {};
    if (existing.role !== "ADMIN") patch["role"] = "ADMIN";
    if (!existing.isActive) patch["isActive"] = true;
    if (!(await verifyPassword(password, existing.passwordHash))) {
      patch["passwordHash"] = await hashPassword(password);
    }
    if (Object.keys(patch).length > 0) {
      const { error: updateError } = await db
        .from("users")
        .update({ ...patch, updatedAt: now })
        .eq("id", userId);
      if (updateError) console.error("[admin-bootstrap] update failed", updateError.message);
    }
  } else {
    userId = newId();
    const { error: insertError } = await db.from("users").insert({
      id: userId,
      role: "ADMIN",
      username: email,
      studentId: null,
      passwordHash: await hashPassword(password),
      isActive: true,
      createdAt: now,
      updatedAt: now,
    });
    if (insertError) {
      console.error("[admin-bootstrap] insert failed", insertError.message);
      return;
    }
  }

  const { data: adminRow } = await db
    .from("admins")
    .select("id")
    .eq("userId", userId)
    .maybeSingle();
  if (!adminRow) {
    const { error: adminError } = await db.from("admins").insert({
      id: newId(),
      userId,
      displayName: "Event Admin",
      createdAt: now,
      updatedAt: now,
    });
    if (adminError) console.error("[admin-bootstrap] admin row failed", adminError.message);
  }
}
