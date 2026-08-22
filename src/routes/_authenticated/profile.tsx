import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { getMyProfile } from "@/lib/student.functions";
import { AppShell, STUDENT_NAV } from "@/components/AppShell";
import { Skeleton } from "@/components/ui/skeleton";
import { formatIst } from "@/lib/datetime";

export const Route = createFileRoute("/_authenticated/profile")({
  head: () => ({
    meta: [
      { title: "My profile — CodeArena" },
      { name: "description", content: "Review your competitor details and batch enrolment." },
      { property: "og:title", content: "My profile — CodeArena" },
      { property: "og:description", content: "Your CodeArena competitor profile." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: ProfilePage,
});

function ProfilePage() {
  const q = useQuery({ queryKey: ["my-profile"], queryFn: () => getMyProfile() });

  return (
    <AppShell nav={STUDENT_NAV} title="My profile" subtitle="Details registered for this event.">
      {q.isLoading ? (
        <Skeleton className="h-48 w-full" />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[
            ["Full name", q.data?.fullName ?? "—"],
            ["Student ID", q.data?.studentCode ?? "—"],
            ["Batch number", q.data?.batchNumber ?? "—"],
            ["Status", q.data?.status ?? "—"],
            ["Active sessions", String(q.data?.activeSessions ?? 0)],
            ["Registered", q.data?.joinedAt ? formatIst(q.data.joinedAt) : "—"],
          ].map(([label, value]) => (
            <div key={label} className="surface rounded-lg border border-border/70 p-5">
              <p className="mono-label text-muted-foreground">{label}</p>
              <p className="mt-3 text-sm font-medium">{value}</p>
            </div>
          ))}
        </div>
      )}
    </AppShell>
  );
}
