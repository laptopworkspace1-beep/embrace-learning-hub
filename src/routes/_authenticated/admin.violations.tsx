import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { listViolations } from "@/lib/admin.functions";
import { AppShell, ADMIN_NAV } from "@/components/AppShell";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatIst } from "@/lib/datetime";

export const Route = createFileRoute("/_authenticated/admin/violations")({
  head: () => ({
    meta: [
      { title: "Violations — CodeArena admin" },
      { name: "description", content: "Fullscreen exits, tab switches and other proctoring events in real time." },
      { property: "og:title", content: "Violations — CodeArena admin" },
      { property: "og:description", content: "Live proctoring feed for the coding event." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: AdminViolations,
});

function AdminViolations() {
  const q = useQuery({
    queryKey: ["admin-violations"],
    queryFn: () => listViolations(),
    refetchInterval: 15_000,
  });

  return (
    <AppShell
      nav={ADMIN_NAV}
      title="Violations"
      subtitle="Refreshes automatically. Students are locked out once they pass the configured limit."
    >
      {q.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : q.isError ? (
        <p className="text-sm text-destructive">Could not load violations.</p>
      ) : (
        <div className="surface overflow-x-auto rounded-lg border border-border/70">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Student</TableHead>
                <TableHead>Round</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Details</TableHead>
                <TableHead>When</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(q.data ?? []).map((v) => (
                <TableRow key={v.id}>
                  <TableCell className="font-medium">{v.student}</TableCell>
                  <TableCell>{v.round}</TableCell>
                  <TableCell>
                    <Badge variant="secondary">{v.type}</Badge>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{v.details || "—"}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {formatIst(v.createdAt)}
                  </TableCell>
                </TableRow>
              ))}
              {(q.data ?? []).length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-sm text-muted-foreground">
                    No violations recorded — everyone is behaving.
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </div>
      )}
    </AppShell>
  );
}
