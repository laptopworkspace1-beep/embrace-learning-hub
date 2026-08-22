import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { Eye, EyeOff, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  generateConfigurationSecret,
  getConfiguration,
  saveConfiguration,
  testConfigurationDatabase,
  testConfigurationServiceKey,
} from "@/lib/configuration.functions";

export const Route = createFileRoute("/configuration")({
  component: ConfigurationPage,
  errorComponent: () => (
    <main className="dark flex min-h-screen items-center justify-center bg-background px-4 text-foreground">
      <div className="max-w-md space-y-2 text-center">
        <h1 className="text-2xl font-bold">System Configuration</h1>
        <p className="text-muted-foreground">
          The configuration page could not be displayed. Please reload the page and try again.
        </p>
      </div>
    </main>
  ),

  head: () => ({
    meta: [
      { title: "System Configuration · CodeArena" },
      {
        name: "description",
        content:
          "Server-side system configuration for CodeArena: session secret, administrator credentials and database connection.",
      },
      { property: "og:title", content: "System Configuration · CodeArena" },
      {
        property: "og:description",
        content: "Server-side system configuration for the CodeArena competition platform.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
});

type ConfigKey =
  | "APP_SESSION_SECRET"
  | "ADMIN_EMAIL"
  | "ADMIN_PASSWORD"
  | "DEFAULT_STUDENT_PASSWORD"
  | "OWN_SUPABASE_DB_URL"
  | "OWN_SUPABASE_SERVICE_ROLE_KEY";

const FIELDS: {
  key: ConfigKey;
  hint: string;
  secret: boolean;
  test?: boolean;
  testKey?: boolean;
  generate?: boolean;
}[] = [
  {
    key: "APP_SESSION_SECRET",
    hint: "Signs every session cookie. A server restart is required for full effect.",
    secret: true,
    generate: true,
  },
  { key: "ADMIN_EMAIL", hint: "Sign-in identifier of the administrator account.", secret: false },
  {
    key: "ADMIN_PASSWORD",
    hint: "Stored hashed on the administrator account; used for admin sign-in.",
    secret: true,
  },
  {
    key: "DEFAULT_STUDENT_PASSWORD",
    hint: "Applied to newly created students only. Existing passwords are untouched.",
    secret: true,
  },
  {
    key: "OWN_SUPABASE_DB_URL",
    hint: "PostgreSQL connection string. Tested before it is saved.",
    secret: true,
    test: true,
  },
  {
    key: "OWN_SUPABASE_SERVICE_ROLE_KEY",
    hint: "Server-side database key. Never sent back to the browser.",
    secret: true,
    testKey: true,
  },
];

function ConfigurationPage() {
  const fetchConfig = useServerFn(getConfiguration);
  const query = useQuery({
    queryKey: ["configuration"],
    queryFn: () => fetchConfig({ data: undefined }),
    retry: false,
  });

  return (
    <main className="dark min-h-screen bg-background px-4 py-14 text-foreground">
      <div className="mx-auto w-full max-w-3xl space-y-8">
        <header className="space-y-2">
          <p className="text-sm font-semibold uppercase tracking-[0.3em] text-primary">CodeArena</p>
          <h1 className="text-4xl font-bold tracking-tight">System Configuration</h1>
          <p className="text-muted-foreground">Information Technology</p>
        </header>

        {query.data && (
          <StatusPanel status={query.data} />
        )}

        {query.isPending ? (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading configuration…
          </div>
        ) : query.isError ? (
          <p className="text-destructive">
            Configuration could not be loaded. Please reload the page and try again.
          </p>

        ) : (
          <div className="space-y-4">
            {FIELDS.map((field) => (
              <ConfigCard
                key={field.key}
                field={field}
                configured={query.data.configured[field.key]}
                currentEmail={field.key === "ADMIN_EMAIL" ? query.data.adminEmail : undefined}
              />
            ))}
          </div>
        )}
      </div>
    </main>
  );
}

type Status = Awaited<ReturnType<typeof getConfiguration>>;

function Dot({ ok }: { ok: boolean }) {
  return (
    <span
      className={`inline-block h-2.5 w-2.5 rounded-full ${ok ? "bg-primary" : "bg-destructive"}`}
      aria-hidden
    />
  );
}

function StatusPanel({ status }: { status: Status }) {
  const rows: { label: string; ok: boolean; text: string }[] = [
    {
      label: "Application",
      ok: status.applicationConfigured,
      text: status.applicationConfigured ? "Configured" : "Initial configuration required",
    },
    {
      label: "Database",
      ok: status.database.connected,
      text: !status.database.configured
        ? "Not configured"
        : status.database.connected
          ? "Connected"
          : (status.database.reason ?? "Connection failed"),
    },
    {
      label: "Service role key",
      ok: status.configured.OWN_SUPABASE_SERVICE_ROLE_KEY,
      text: status.configured.OWN_SUPABASE_SERVICE_ROLE_KEY ? "Configured" : "Not configured",
    },
    {
      label: "Session secret",
      ok: status.configured.APP_SESSION_SECRET,
      text: status.configured.APP_SESSION_SECRET ? "Configured" : "Not configured",
    },
    {
      label: "Admin account",
      ok: status.configured.ADMIN_EMAIL && status.configured.ADMIN_PASSWORD,
      text:
        status.configured.ADMIN_EMAIL && status.configured.ADMIN_PASSWORD
          ? "Configured"
          : "Not configured",
    },
    {
      label: "Student password",
      ok: status.configured.DEFAULT_STUDENT_PASSWORD,
      text: status.configured.DEFAULT_STUDENT_PASSWORD ? "Configured" : "Not configured",
    },
  ];

  return (
    <Card className="border-white/10 bg-white/5 backdrop-blur-xl">
      <CardHeader className="pb-3">
        <CardTitle className="flex flex-wrap items-center justify-between gap-2 text-base">
          <span>System status</span>
          <Badge variant={status.mode === "NORMAL" ? "secondary" : "destructive"}>
            {status.mode === "NORMAL" ? "CONFIGURED" : "INITIAL CONFIGURATION REQUIRED"}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-2 sm:grid-cols-2">
        {rows.map((row) => (
          <div key={row.label} className="flex items-center gap-2 text-sm">
            <Dot ok={row.ok} />
            <span className="text-muted-foreground">{row.label}:</span>
            <span>{row.text}</span>
          </div>
        ))}
        {!status.durableStore && status.mode === "BOOTSTRAP" && (
          <p className="sm:col-span-2 text-xs text-destructive">
            Persistent bootstrap storage is unavailable. Configuration has not been saved.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function ConfigCard({
  field,
  configured,
  currentEmail,
}: {
  field: (typeof FIELDS)[number];
  configured: boolean;
  currentEmail?: string | undefined;
}) {
  const queryClient = useQueryClient();
  const save = useServerFn(saveConfiguration);
  const testDb = useServerFn(testConfigurationDatabase);
  const testKey = useServerFn(testConfigurationServiceKey);
  const generate = useServerFn(generateConfigurationSecret);

  const [value, setValue] = useState(field.key === "ADMIN_EMAIL" ? (currentEmail ?? "") : "");
  const [visible, setVisible] = useState(false);
  const [testState, setTestState] = useState<null | { ok: boolean; reason?: string | undefined }>(
    null,
  );

  const saveMutation = useMutation({
    mutationFn: () => save({ data: { key: field.key, value } }),
    onSuccess: (result) => {
      toast.success(
        result.restartRequired
          ? "Configuration saved. Server restart required for this change to take effect."
          : "✓ Configuration updated",
      );
      if (field.secret) setValue("");
      setVisible(false);
      queryClient.invalidateQueries({ queryKey: ["configuration"] });
    },
    onError: (error: Error) => toast.error(`✗ Configuration update failed — ${error.message}`),
  });

  const generateMutation = useMutation({
    mutationFn: () => generate({ data: undefined }),
    onSuccess: () => {
      toast.success("Secure secret generated. Server restart required to rotate live sessions.");
      queryClient.invalidateQueries({ queryKey: ["configuration"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const testMutation = useMutation({
    mutationFn: () =>
      field.testKey ? testKey({ data: { value } }) : testDb({ data: { value } }),
    onSuccess: (result) => setTestState(result),
    // Never surface a raw backend/database error on this page.
    onError: () =>
      setTestState({
        ok: false,
        reason: field.testKey
          ? "Unable to verify the service key. Please check the value and try again."
          : "Unable to connect to the database. Please check the database URL and try again.",
      }),
  });

  // A database URL is only saveable once its connection test has succeeded.
  const requiresPassingTest = field.key === "OWN_SUPABASE_DB_URL";
  const canSave =
    Boolean(value.trim()) &&
    !saveMutation.isPending &&
    !testMutation.isPending &&
    (!requiresPassingTest || testState?.ok === true);


  return (
    <Card className="border-white/10 bg-white/5 backdrop-blur-xl">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center justify-between gap-3 font-mono text-base">
          <span>{field.key}</span>
          {configured ? (
            <Badge variant="secondary">Configured ✓</Badge>
          ) : (
            <Badge variant="destructive">Not set</Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Input
            className="min-w-[16rem] flex-1 bg-background/40"
            type={field.secret && !visible ? "password" : "text"}
            autoComplete="off"
            spellCheck={false}
            placeholder={field.secret ? "•••••••••••••••••••••" : "admin@it"}
            value={value}
            onChange={(event) => {
              setValue(event.target.value);
              setTestState(null);
            }}
          />
          {field.secret && (
            <Button
              type="button"
              variant="outline"
              aria-pressed={visible}
              aria-label={`${visible ? "Hide" : "Show"} ${field.key}`}
              onClick={() => setVisible((previous) => !previous)}
            >
              {visible ? (
                <>
                  <EyeOff className="mr-1 h-4 w-4" /> Hide
                </>
              ) : (
                <>
                  <Eye className="mr-1 h-4 w-4" /> Show
                </>
              )}
            </Button>
          )}
          {field.generate && (
            <Button
              type="button"
              variant="outline"
              disabled={generateMutation.isPending}
              onClick={() => generateMutation.mutate()}
            >
              {generateMutation.isPending ? "Generating…" : "Generate Secure Secret"}
            </Button>
          )}
          {(field.test || field.testKey) && (
            <Button
              type="button"
              variant="outline"
              disabled={!value.trim() || testMutation.isPending}
              onClick={() => testMutation.mutate()}
            >
              {testMutation.isPending
                ? field.testKey
                  ? "Testing…"
                  : "Testing connection…"
                : field.testKey
                  ? "Test"
                  : "Test Connection"}
            </Button>
          )}
          <Button type="button" disabled={!canSave} onClick={() => saveMutation.mutate()}>
            {saveMutation.isPending ? "Saving…" : "Save"}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">{field.hint}</p>
        {configured && !value && (
          <p className="text-xs text-muted-foreground">
            A value is already configured and is never sent back to the browser. Enter a new value
            above to replace it.
          </p>
        )}
        {requiresPassingTest && value.trim() && testState?.ok !== true && (
          <p className="text-xs text-muted-foreground">
            Run Test Connection successfully before saving this database URL.
          </p>
        )}
        {testState && (
          <p className={testState.ok ? "text-sm text-primary" : "text-sm text-destructive"}>
            {testState.ok
              ? field.testKey
                ? `✓ ${testState.reason ?? "Service role key accepted"}`
                : "✓ Database connection successful"
              : `✗ ${testState.reason ?? (field.testKey ? "Unable to verify the service key." : "Unable to connect to the database. Please check the database URL and try again.")}`}
          </p>
        )}

      </CardContent>
    </Card>
  );
}
