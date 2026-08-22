import { Link, useRouterState } from "@tanstack/react-router";
import { useSignOut } from "@/lib/auth-context";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { LogOut, Terminal } from "lucide-react";
import type { ReactNode } from "react";

export type NavItem = { to: string; label: string };

export function AppShell({
  nav,
  title,
  subtitle,
  actions,
  children,
}: {
  nav: NavItem[];
  title: string;
  subtitle?: string | undefined;
  actions?: ReactNode | undefined;
  children: ReactNode;
}) {
  const signOut = useSignOut();
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-40 border-b border-border/70 bg-background/85 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-7xl items-center gap-6 px-4">
          <Link to="/" className="flex items-center gap-2">
            <span className="grid size-8 place-items-center rounded-md bg-primary text-primary-foreground">
              <Terminal className="size-4" />
            </span>
            <span className="font-display text-base font-bold tracking-tight">CodeArena</span>
          </Link>
          <nav className="hidden min-w-0 flex-1 items-center gap-1 overflow-x-auto md:flex [scrollbar-width:thin]">
            {nav.map((item) => (
              <Link
                key={item.to}
                to={item.to}
                className={cn(
                  "shrink-0 whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground",
                  pathname === item.to && "bg-secondary text-foreground",
                )}
              >
                {item.label}
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            {actions}
            <Button variant="ghost" size="sm" onClick={() => void signOut()}>
              <LogOut className="size-4" />
              <span className="hidden sm:inline">Sign out</span>
            </Button>
          </div>
        </div>
        <nav className="flex gap-1 overflow-x-auto border-t border-border/70 px-4 py-2 md:hidden">
          {nav.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              className={cn(
                "whitespace-nowrap rounded-md px-3 py-1.5 text-xs font-medium text-muted-foreground",
                pathname === item.to && "bg-secondary text-foreground",
              )}
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-8">
        <div className="mb-8">
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{title}</h1>
          {subtitle ? <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p> : null}
        </div>
        {children}
      </main>
    </div>
  );
}

export const STUDENT_NAV: NavItem[] = [
  { to: "/dashboard", label: "Dashboard" },
  { to: "/submissions", label: "Submissions" },
  { to: "/results", label: "Results" },
  { to: "/profile", label: "Profile" },
];

export const ADMIN_NAV: NavItem[] = [
  { to: "/admin", label: "Overview" },
  { to: "/admin/monitor", label: "Live monitor" },
  { to: "/admin/homepage", label: "Homepage" },
  { to: "/admin/users", label: "Users" },
  { to: "/admin/rounds", label: "Rounds" },
  { to: "/admin/round1", label: "Quiz" },
  { to: "/admin/round2", label: "Bug Hunt" },
  { to: "/admin/round3", label: "Code Sprint" },
  { to: "/admin/submissions", label: "Submissions" },
  { to: "/admin/leaderboard", label: "Leaderboard" },
  { to: "/admin/violations", label: "Violations" },
  { to: "/admin/event", label: "Event control" },
  { to: "/admin/settings", label: "Settings" },
  { to: "/admin/engines", label: "Engines" },
  { to: "/admin/infrastructure", label: "Infrastructure" },
  { to: "/admin/audit", label: "Audit" },
];
