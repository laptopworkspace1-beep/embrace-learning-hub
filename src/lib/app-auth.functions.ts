import { createServerFn } from "@tanstack/react-start";
import { registrationSchema, signInSchema, type RegistrationInput, type SignInInput } from "./schemas";
import { apiMetrics } from "./api-metrics";

/** Signs in a student (batch number) or the administrator (admin@it). */
export const signIn = createServerFn({ method: "POST" }).middleware([apiMetrics("auth.signIn")])
  .inputValidator((input: SignInInput) => signInSchema.parse(input))
  .handler(async ({ data }) => {
    const { ownDb, audit } = await import("./own-db.server");
    const { verifyPassword, startSession } = await import("./app-session.server");
    const { enforceRateLimit } = await import("./rate-limit.server");
    const { ensureAdminAccount } = await import("./admin-bootstrap.server");
    // Rate-limit per account, not per IP: an entire lab of students shares one
    // public IP, so an IP-keyed limit blocked legitimate simultaneous logins.
    enforceRateLimit("login", `acct:${data.identifier.trim().toLowerCase()}`);
    // Provisions/repairs the ADMIN account from the server-side bootstrap
    // credentials before the credentials below are checked.
    await ensureAdminAccount(data.identifier);
    const db = ownDb();


    const identifier = data.identifier.trim();
    const escaped = identifier.replace(/[%_\\]/g, (c) => `\\${c}`);
    const columns = "id, role, username, studentId, passwordHash, isActive";

    // Username / email match is case-insensitive; batch numbers match exactly.
    let user: Record<string, unknown> | null = null;
    const { data: byUsername } = await db.from("users").select(columns).ilike("username", escaped).limit(1);
    if (byUsername?.[0]) {
      user = byUsername[0] as Record<string, unknown>;
    } else {
      const { data: byStudentId } = await db
        .from("users")
        .select(columns)
        .ilike("studentId", escaped)
        .limit(1);
      if (byStudentId?.[0]) user = byStudentId[0] as Record<string, unknown>;
    }

    const genericError = "Incorrect username / batch number or password.";
    if (!user) throw new Error(genericError);
    if (!user["isActive"]) throw new Error("This account has been disabled. Contact an organiser.");

    const ok = await verifyPassword(data.password, String(user["passwordHash"]));
    if (!ok) throw new Error(genericError);


    const role = user["role"] === "ADMIN" ? ("ADMIN" as const) : ("STUDENT" as const);
    const userId = String(user["id"]);

    let studentId: string | null = null;
    let fullName = "Administrator";
    if (role === "STUDENT") {
      const { data: student } = await db
        .from("students")
        .select("id, fullName, status")
        .eq("userId", userId)
        .maybeSingle();
      if (!student) throw new Error("Your student record is missing. Contact an organiser.");
      if (student["status"] === "BLOCKED") throw new Error("Your account is blocked.");
      studentId = String(student["id"]);
      fullName = String(student["fullName"]);
    } else {
      const { data: admin } = await db
        .from("admins")
        .select("displayName")
        .eq("userId", userId)
        .maybeSingle();
      if (admin?.["displayName"]) fullName = String(admin["displayName"]);
    }

    await startSession({ userId, role, studentId });
    await audit({
      actorUserId: userId,
      action: "auth.login",
      entityType: "users",
      entityId: userId,
      metadata: { role },
    });

    return { ok: true as const, role, fullName };
  });

/**
 * Registers a student with full name + 6-digit batch number only, then signs
 * them straight in. The password is the platform's configured default.
 */
export const registerStudentAccount = createServerFn({ method: "POST" }).middleware([apiMetrics("auth.register")])
  .inputValidator((input: RegistrationInput) => registrationSchema.parse(input))
  .handler(async ({ data }) => {
    const { ownDb, audit, newId, nowIso } = await import("./own-db.server");
    const { hashPassword, startSession } = await import("./app-session.server");
    const { enforceRateLimit } = await import("./rate-limit.server");
    const code = data.batchNumber;
    enforceRateLimit("register", `batch:${code.trim().toLowerCase()}`);
    const db = ownDb();

    const { getConfig } = await import("./app-config.server");
    const password = await getConfig("DEFAULT_STUDENT_PASSWORD");
    if (!password) throw new Error("Student sign-in is not configured. Contact an organiser.");

    const { data: existingUser } = await db
      .from("users")
      .select("id")
      .eq("username", code)
      .maybeSingle();
    if (existingUser) {
      throw new Error("That batch number is already registered. Please sign in instead.");
    }

    // Reuse the existing batch row when the code already exists; never recreate it.
    let batchId: string;
    const { data: batch } = await db.from("batches").select("id").eq("code", code).maybeSingle();
    if (batch) {
      batchId = String(batch["id"]);
    } else {
      batchId = newId();
      const { error } = await db
        .from("batches")
        .insert({ id: batchId, code, name: `Batch ${code}`, createdAt: nowIso(), updatedAt: nowIso() });
      if (error) {
        console.error("[register] batch insert failed", error.message);
        if (/invalid api key|jwt/i.test(error.message)) {
          throw new Error("Registration is unavailable: the competition database credentials are invalid. Contact an organiser.");
        }
        throw new Error("Could not register your batch number.");
      }
    }

    const userId = newId();
    const { error: userError } = await db.from("users").insert({
      id: userId,
      role: "STUDENT",
      username: code,
      studentId: null,
      passwordHash: await hashPassword(password),
      isActive: true,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
    if (userError) {
      console.error("[register] user insert failed", userError.message);
      throw new Error("Could not create your account. Please try again.");
    }

    const studentRowId = newId();
    const { error: studentError } = await db.from("students").insert({
      id: studentRowId,
      userId,
      fullName: data.fullName,
      batchId,
      status: "ACTIVE",
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
    if (studentError) {
      console.error("[register] student insert failed", studentError.message);
      await db.from("users").delete().eq("id", userId);
      throw new Error("Could not create your student profile. Please try again.");
    }

    await startSession({ userId, role: "STUDENT", studentId: studentRowId });
    await audit({
      actorUserId: userId,
      action: "student.registered",
      entityType: "students",
      entityId: studentRowId,
      metadata: { batchCode: code, fullName: data.fullName },
    });

    return { ok: true as const, role: "STUDENT" as const, fullName: data.fullName };
  });

/** Current signed-in identity, or null. Never throws. */
export const getCurrentUser = createServerFn({ method: "GET" }).middleware([apiMetrics("auth.getCurrentUser")]).handler(async () => {
  const { readSession } = await import("./app-session.server");
  const { ownDb } = await import("./own-db.server");
  const claims = await readSession();
  if (!claims) return null;

  const db = ownDb();
  if (claims.role === "ADMIN") {
    // Independent reads: one round trip instead of two on every page load.
    const [{ data: admin }, { data: user }] = await Promise.all([
      db.from("admins").select("displayName").eq("userId", claims.sub).maybeSingle(),
      db.from("users").select("username").eq("id", claims.sub).maybeSingle(),
    ]);
    return {
      userId: claims.sub,
      role: "ADMIN" as const,
      studentId: null,
      fullName: String(admin?.["displayName"] ?? "Administrator"),
      batchCode: null,
      username: String(user?.["username"] ?? ""),
    };
  }

  const { data: student } = await db
    .from("students")
    .select("id, fullName, status, batches:batchId(code)")
    .eq("id", claims.studentId ?? "")
    .maybeSingle();

  const batches = student?.["batches"] as { code?: string } | { code?: string }[] | null;
  const batchCode = Array.isArray(batches) ? (batches[0]?.code ?? null) : (batches?.code ?? null);

  return {
    userId: claims.sub,
    role: "STUDENT" as const,
    studentId: claims.studentId,
    fullName: String(student?.["fullName"] ?? "Student"),
    batchCode,
    username: batchCode ?? "",
  };
});

export const signOut = createServerFn({ method: "POST" }).handler(async () => {
  const { readSession, endSession } = await import("./app-session.server");
  const { audit } = await import("./own-db.server");
  const claims = await readSession();
  await endSession();
  if (claims) {
    await audit({
      actorUserId: claims.sub,
      action: "auth.logout",
      entityType: "users",
      entityId: claims.sub,
    });
  }
  return { ok: true as const };
});
