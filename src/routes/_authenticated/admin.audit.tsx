import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { listAuditLogs } from "@/lib/admin-manage.functions";
import { AppShell, ADMIN_NAV } from "@/components/AppShell";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatIst } from "@/lib/datetime";

export const Route = createFileRoute("/_authenticated/admin/audit")({
  head: () => ({
    meta: [
      { title: "Audit log — CodeArena admin" },
      { name: "description", content: "Every administrative action recorded with actor, target and time." },
      { property: "og:title", content: "Audit log — CodeArena admin" },
      { property: "og:description", content: "Traceability for competition administration." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: AdminAudit,
});

function AdminAudit() {
  const [search, setSearch] = useState("");
  const q = useQuery({
    queryKey: ["admin-audit", search],
    queryFn: () => listAuditLogs({ data: { search } }),
  });

  return (
    <AppShell nav={ADMIN_NAV} title="Audit log" subtitle="The last 500 administrative actions.">
      <Input
        className="mb-6 max-w-xs"
        placeholder="Search action, actor or entity"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      {q.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : q.isError ? (
        <p className="text-sm text-destructive">Could not load the audit log.</p>
      ) : (
        <div className="surface overflow-x-auto rounded-lg border border-border/70">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Actor</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Entity</TableHead>
                <TableHead>Metadata</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(q.data ?? []).map((l) => (
                <TableRow key={l.id}>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                    {formatIst(l.createdAt)}
                  </TableCell>
                  <TableCell className="text-xs">{l.actor}</TableCell>
                  <TableCell className="font-mono text-xs">{l.action}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {l.entityType}
                    {l.entityId ? ` · ${l.entityId.slice(0, 8)}` : ""}
                  </TableCell>
                  <TableCell className="max-w-xs truncate font-mono text-xs text-muted-foreground">
                    {l.metadata}
                  </TableCell>
                </TableRow>
              ))}
              {(q.data ?? []).length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-sm text-muted-foreground">
                    Nothing logged yet.
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
