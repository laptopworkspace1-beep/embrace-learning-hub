import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { currentUserQuery, type CurrentUser } from "@/lib/auth-context";

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async ({ location, context }) => {
    // Reuse the cached session for a short window so navigating between
    // authenticated pages doesn't re-hit the server every time. Every server
    // function still re-verifies the session and role independently.
    let user: CurrentUser | null | undefined;
    try {
      user = await context.queryClient.ensureQueryData(currentUserQuery);
    } catch (error) {
      // A failed identity check is "unknown", not "signed out": fall back to
      // the last known identity so a network blip never ejects an active user.
      user = context.queryClient.getQueryData<CurrentUser | null>(currentUserQuery.queryKey);
      if (user === undefined) throw error;
    }
    if (!user) {
      throw redirect({ to: "/auth", search: { redirect: location.href } });
    }
    return { user };
  },
  component: () => <Outlet />,
});
