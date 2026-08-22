import { createContext, useContext, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { getCurrentUser, signOut as signOutFn } from "@/lib/app-auth.functions";

export type CurrentUser = {
  userId: string;
  role: "ADMIN" | "STUDENT";
  studentId: string | null;
  fullName: string;
  batchCode: string | null;
  username: string;
};

export type SessionState = {
  user: CurrentUser | null;
  loading: boolean;
  isAdmin: boolean;
};

export const currentUserQuery = {
  queryKey: ["current-user"] as const,
  queryFn: () => getCurrentUser() as Promise<CurrentUser | null>,
  staleTime: 60_000,
  gcTime: 60 * 60_000,
  // A flaky request must never look like a sign-out: retry, and keep the last
  // known identity in cache instead of dropping it.
  retry: 3,
  retryDelay: (attempt: number) => Math.min(1000 * 2 ** attempt, 5000),
  refetchOnWindowFocus: false,
  refetchOnReconnect: true,
};

const AuthContext = createContext<SessionState>({ user: null, loading: true, isAdmin: false });

export function AuthProvider({ children }: { children: ReactNode }) {
  const { data, isPending } = useQuery(currentUserQuery);
  const user = data ?? null;
  // Only the very first resolution counts as "loading"; later background
  // refetches must not make an authenticated user look signed out.
  const isLoading = isPending && data === undefined;

  return (
    <AuthContext.Provider
      value={{ user, loading: isLoading, isAdmin: user?.role === "ADMIN" }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}

/** Signs out, clears cached data, and returns to the sign-in page. */
export function useSignOut() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  return async () => {
    await queryClient.cancelQueries();
    try {
      await signOutFn();
    } catch {
      /* the cookie is cleared regardless */
    }
    queryClient.clear();
    navigate({ to: "/auth", replace: true });
  };
}
