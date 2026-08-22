/**
 * Admin-editable homepage content, persisted in PostgreSQL so the landing page
 * survives restarts and is never hardcoded in the bundle.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

export type HomepageStat = { value: string; label: string };

export type HomepageContent = {
  siteName: string;
  departmentName: string;
  mainHeading: string;
  subtitle: string;
  description: string;
  heroText: string;
  round1Name: string;
  round1Description: string;
  round2Name: string;
  round2Description: string;
  round3Name: string;
  round3Description: string;
  stats: HomepageStat[];
  footerText: string;
};

export const HOMEPAGE_FALLBACK: HomepageContent = {
  siteName: "CodeArena",
  departmentName: "Information Technology",
  mainHeading: "INFORMATION TECHNOLOGY",
  subtitle: "College Coding Competition",
  description: "Three rounds. One arena. Proctored, timed and scored by the server.",
  heroText: "Compete. Solve. Debug. Code.",
  round1Name: "TECH QUIZ",
  round1Description: "MCQ + Output Prediction",
  round2Name: "BUG HUNT",
  round2Description: "Find. Fix. Submit.",
  round3Name: "CODE SPRINT",
  round3Description: "Build. Test. Solve.",
  stats: [
    { value: "03", label: "ROUNDS" },
    { value: "60+", label: "STUDENTS" },
    { value: "01", label: "PLATFORM" },
    { value: "LIVE", label: "CONTROL" },
  ],
  footerText: "College Coding Competition Platform",
};

const contentSchema = z.object({
  siteName: z.string().trim().min(1).max(80),
  departmentName: z.string().trim().min(1).max(120),
  mainHeading: z.string().trim().min(1).max(120),
  subtitle: z.string().trim().max(160),
  description: z.string().trim().max(600),
  heroText: z.string().trim().max(200),
  round1Name: z.string().trim().min(1).max(80),
  round1Description: z.string().trim().max(200),
  round2Name: z.string().trim().min(1).max(80),
  round2Description: z.string().trim().max(200),
  round3Name: z.string().trim().min(1).max(80),
  round3Description: z.string().trim().max(200),
  stats: z.array(z.object({ value: z.string().trim().max(12), label: z.string().trim().max(24) })).max(6),
  footerText: z.string().trim().max(200),
});

/** Public: read by the landing page during SSR. */
export const getHomepageContent = createServerFn({ method: "GET" }).handler(
  async (): Promise<HomepageContent> => {
    const { ownDb } = await import("./own-db.server");
    const { data } = await ownDb().from("homepage_content").select("*").limit(1);
    const row = data?.[0] as Record<string, unknown> | undefined;
    if (!row) return HOMEPAGE_FALLBACK;
    const pick = (key: keyof HomepageContent) =>
      typeof row[key] === "string" && String(row[key]).length
        ? String(row[key])
        : (HOMEPAGE_FALLBACK[key] as string);
    return {
      siteName: pick("siteName"),
      departmentName: pick("departmentName"),
      mainHeading: pick("mainHeading"),
      subtitle: pick("subtitle"),
      description: pick("description"),
      heroText: pick("heroText"),
      round1Name: pick("round1Name"),
      round1Description: pick("round1Description"),
      round2Name: pick("round2Name"),
      round2Description: pick("round2Description"),
      round3Name: pick("round3Name"),
      round3Description: pick("round3Description"),
      stats: Array.isArray(row["stats"]) ? (row["stats"] as HomepageStat[]) : HOMEPAGE_FALLBACK.stats,
      footerText: pick("footerText"),
    };
  },
);

/** Admin only: persist homepage copy. */
export const saveHomepageContent = createServerFn({ method: "POST" })
  .inputValidator((input: HomepageContent) => contentSchema.parse(input))
  .handler(async ({ data }) => {
    const { requireAdmin } = await import("./app-session.server");
    const { audit, nowIso, ownDb } = await import("./own-db.server");
    const claims = await requireAdmin();
    const { error } = await ownDb()
      .from("homepage_content")
      .upsert({ id: "default-event", ...data, updatedAt: nowIso() }, { onConflict: "id" });
    if (error) throw new Error("Could not save the homepage content.");
    await audit({
      actorUserId: claims.sub,
      action: "homepage.update",
      entityType: "homepage_content",
      entityId: "default-event",
    });
    return { ok: true as const };
  });
