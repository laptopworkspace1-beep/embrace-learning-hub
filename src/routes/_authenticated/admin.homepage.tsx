import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  getHomepageContent,
  saveHomepageContent,
  HOMEPAGE_FALLBACK,
  type HomepageContent,
} from "@/lib/homepage.functions";
import { AppShell, ADMIN_NAV } from "@/components/AppShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";

export const Route = createFileRoute("/_authenticated/admin/homepage")({
  head: () => ({
    meta: [
      { title: "Homepage content — CodeArena admin" },
      { name: "description", content: "Edit the public landing page copy, round names and headline stats." },
      { property: "og:title", content: "Homepage content — CodeArena admin" },
      { property: "og:description", content: "Control every word on the public homepage." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: AdminHomepage,
});

const FIELDS: { key: keyof HomepageContent; label: string; long?: boolean }[] = [
  { key: "siteName", label: "Website name" },
  { key: "departmentName", label: "Department" },
  { key: "mainHeading", label: "Main heading (last word is highlighted)" },
  { key: "subtitle", label: "Subtitle" },
  { key: "heroText", label: "Hero tagline" },
  { key: "description", label: "Statement paragraph", long: true },
  { key: "round1Name", label: "Round 1 name" },
  { key: "round1Description", label: "Round 1 description" },
  { key: "round2Name", label: "Round 2 name" },
  { key: "round2Description", label: "Round 2 description" },
  { key: "round3Name", label: "Round 3 name" },
  { key: "round3Description", label: "Round 3 description" },
  { key: "footerText", label: "Footer text" },
];

function AdminHomepage() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["homepage-content"], queryFn: () => getHomepageContent() });
  const [form, setForm] = useState<HomepageContent>(HOMEPAGE_FALLBACK);

  useEffect(() => {
    if (q.data) setForm(q.data);
  }, [q.data]);

  const save = useMutation({
    mutationFn: (value: HomepageContent) => saveHomepageContent({ data: value }),
    onSuccess: () => {
      toast.success("Homepage updated.");
      void qc.invalidateQueries({ queryKey: ["homepage-content"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not save the homepage."),
  });

  const set = (key: keyof HomepageContent, value: string) =>
    setForm((f) => ({ ...f, [key]: value }) as HomepageContent);

  return (
    <AppShell
      nav={ADMIN_NAV}
      title="Homepage content"
      subtitle="Everything on the public landing page, stored in the database."
      actions={
        <Button size="sm" disabled={save.isPending} onClick={() => save.mutate(form)}>
          Save changes
        </Button>
      }
    >
      {q.isLoading ? (
        <Skeleton className="h-96 w-full" />
      ) : (
        <div className="grid gap-6 lg:grid-cols-2">
          {FIELDS.map((field) => (
            <div key={field.key} className="space-y-2">
              <Label htmlFor={field.key}>{field.label}</Label>
              {field.long ? (
                <Textarea
                  id={field.key}
                  rows={4}
                  value={String(form[field.key] ?? "")}
                  onChange={(e) => set(field.key, e.target.value)}
                />
              ) : (
                <Input
                  id={field.key}
                  value={String(form[field.key] ?? "")}
                  onChange={(e) => set(field.key, e.target.value)}
                />
              )}
            </div>
          ))}

          <div className="lg:col-span-2">
            <p className="text-sm font-semibold">Headline stats</p>
            <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {form.stats.map((stat, index) => (
                <div key={index} className="surface space-y-2 rounded-lg border border-border/70 p-4">
                  <Label htmlFor={`stat-value-${index}`}>Value</Label>
                  <Input
                    id={`stat-value-${index}`}
                    value={stat.value}
                    onChange={(e) =>
                      setForm((f) => ({
                        ...f,
                        stats: f.stats.map((s, i) => (i === index ? { ...s, value: e.target.value } : s)),
                      }))
                    }
                  />
                  <Label htmlFor={`stat-label-${index}`}>Label</Label>
                  <Input
                    id={`stat-label-${index}`}
                    value={stat.label}
                    onChange={(e) =>
                      setForm((f) => ({
                        ...f,
                        stats: f.stats.map((s, i) => (i === index ? { ...s, label: e.target.value } : s)),
                      }))
                    }
                  />
                </div>
              ))}
            </div>
          </div>

          <div className="lg:col-span-2">
            <Button disabled={save.isPending} onClick={() => save.mutate(form)}>
              Save changes
            </Button>
          </div>
        </div>
      )}
    </AppShell>
  );
}
