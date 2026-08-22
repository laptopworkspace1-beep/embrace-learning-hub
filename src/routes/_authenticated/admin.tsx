import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";

/**
 * Authorization gate for the whole admin portal. The backend still enforces
 * `requireAdmin()` on every admin server function — this only stops a signed-in
 * student from landing on admin screens and seeing raw "forbidden" errors.
 */
export const Route = createFileRoute("/_authenticated/admin")({
  beforeLoad: ({ context }) => {
    const user = (context as { user?: { role?: string } }).user;
    if (!user || user.role !== "ADMIN") {
      throw redirect({ to: "/dashboard" });
    }
  },
  component: () => <Outlet />,
});
