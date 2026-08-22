import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { z } from "zod";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth-context";
import { registerStudentAccount, signIn } from "@/lib/app-auth.functions";
import { registrationSchema, signInSchema } from "@/lib/schemas";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Terminal } from "lucide-react";

const searchSchema = z.object({
  mode: z.enum(["login", "register"]).optional(),
  redirect: z.string().optional(),
});

export const Route = createFileRoute("/auth")({
  validateSearch: searchSchema,
  head: () => ({
    meta: [
      { title: "Sign in — Coding Challenge 2026" },
      {
        name: "description",
        content:
          "Sign in with your batch number or register with your name and 6-digit batch number for Coding Challenge 2026.",
      },
      { property: "og:title", content: "Sign in — Coding Challenge 2026" },
      { property: "og:description", content: "Access your Coding Challenge 2026 dashboard." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: AuthPage,
});

function safePath(value: string | undefined): string | null {
  if (!value) return null;
  return value.startsWith("/") && !value.startsWith("//") ? value : null;
}

function AuthPage() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const { user, loading } = useAuth();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const explicitDest = safePath(search.redirect);

  useEffect(() => {
    if (loading || !user) return;
    navigate({
      to: explicitDest ?? (user.role === "ADMIN" ? "/admin" : "/dashboard"),
      replace: true,
    });
  }, [loading, user, explicitDest, navigate]);

  const [login, setLogin] = useState({ identifier: "", password: "" });
  const [signup, setSignup] = useState({ fullName: "", batchNumber: "" });

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    const parsed = signInSchema.safeParse(login);
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? "Check your details");
      return;
    }
    setBusy(true);
    try {
      const result = await signIn({ data: parsed.data });
      // Drop the cached "signed out" identity synchronously so the guarded route
      // re-reads the fresh session; awaiting a refetch here can stall the form.
      queryClient.removeQueries({ queryKey: ["current-user"] });
      toast.success(`Welcome back, ${result.fullName}`);
      navigate({
        to: explicitDest ?? (result.role === "ADMIN" ? "/admin" : "/dashboard"),
        replace: true,
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not sign you in");
    } finally {
      setBusy(false);
    }
  }

  async function handleSignup(e: React.FormEvent) {
    e.preventDefault();
    const parsed = registrationSchema.safeParse(signup);
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? "Check your details");
      return;
    }
    setBusy(true);
    try {
      const result = await registerStudentAccount({ data: parsed.data });
      queryClient.removeQueries({ queryKey: ["current-user"] });
      toast.success(`Welcome, ${result.fullName}`);
      navigate({ to: "/dashboard", replace: true });

    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not complete registration");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="hero-glow flex min-h-screen flex-col items-center justify-center px-4 py-12">
      <Link to="/" className="mb-8 flex items-center gap-2">
        <span className="grid size-8 place-items-center rounded-md bg-primary text-primary-foreground">
          <Terminal className="size-4" />
        </span>
        <span className="font-display text-base font-bold">Coding Challenge 2026</span>
      </Link>

      <div className="surface w-full max-w-md rounded-xl border border-border/70 p-6">
        <Tabs defaultValue={search.mode === "register" ? "register" : "login"}>
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="login">Sign in</TabsTrigger>
            <TabsTrigger value="register">Register</TabsTrigger>
          </TabsList>

          <TabsContent value="login" className="mt-6">
            <form className="space-y-4" onSubmit={handleLogin}>
              <div className="space-y-2">
                <Label htmlFor="login-id">Username / Email / Batch Number</Label>
                <Input
                  id="login-id"
                  autoComplete="username"
                  maxLength={255}
                  placeholder="Enter username, email, or batch number"

                  value={login.identifier}
                  onChange={(e) => setLogin({ ...login, identifier: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="login-password">Password</Label>
                <Input
                  id="login-password"
                  type="password"
                  autoComplete="current-password"
                  maxLength={128}
                  placeholder="Enter password"

                  value={login.password}
                  onChange={(e) => setLogin({ ...login, password: e.target.value })}
                />
              </div>
              <Button type="submit" className="w-full" disabled={busy}>
                {busy ? "Signing in…" : "Sign In"}
              </Button>
              <p className="text-xs text-muted-foreground">
                One sign-in for everyone — your account decides where you land.
              </p>
            </form>
          </TabsContent>

          <TabsContent value="register" className="mt-6">
            <form className="space-y-4" onSubmit={handleSignup}>
              <div className="space-y-2">
                <Label htmlFor="su-name">Full Name</Label>
                <Input
                  id="su-name"
                  maxLength={120}
                  placeholder="Enter your full name"
                  value={signup.fullName}
                  onChange={(e) => setSignup({ ...signup, fullName: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="su-batch">Batch Number</Label>
                <Input
                  id="su-batch"
                  inputMode="numeric"
                  maxLength={6}
                  placeholder="284001"
                  className="font-mono"
                  value={signup.batchNumber}
                  onChange={(e) =>
                    setSignup({
                      ...signup,
                      batchNumber: e.target.value.replace(/\D/g, "").slice(0, 6),
                    })
                  }
                />
                <p className="text-xs text-muted-foreground">Exactly 6 digits.</p>
              </div>
              <Button type="submit" className="w-full" disabled={busy}>
                {busy ? "Registering…" : "Register"}
              </Button>
            </form>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
