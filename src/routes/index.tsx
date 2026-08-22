import { createFileRoute, Link } from "@tanstack/react-router";
import { useAuth } from "@/lib/auth-context";
import { getHomepageContent, HOMEPAGE_FALLBACK } from "@/lib/homepage.functions";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "CodeArena — Information Technology Coding Competition" },
      {
        name: "description",
        content:
          "CodeArena: the Information Technology department's college coding competition. Three rounds — tech quiz, bug hunt, code sprint.",
      },
      { property: "og:title", content: "CodeArena — Information Technology Coding Competition" },
      {
        property: "og:description",
        content: "CodeArena: the Information Technology department's college coding competition. Three rounds — tech quiz, bug hunt, code sprint.",
      },
    ],
  }),
  loader: async () => {
    try {
      return await getHomepageContent();
    } catch {
      return HOMEPAGE_FALLBACK;
    }
  },
  component: Landing,
});

const FEATURES = [
  { title: "TIMED", line: "Server-controlled rounds." },
  { title: "AUTOMATED", line: "Consistent evaluation." },
  { title: "MONITORED", line: "Live participation tracking." },
  { title: "SECURE", line: "Protected test cases and submissions." },
];

const STEPS = [
  { n: "01", title: "REGISTER", line: "Join the competition." },
  { n: "02", title: "COMPETE", line: "Complete every round." },
  { n: "03", title: "RESULTS", line: "Scores are calculated automatically." },
];

function SignInLink({ className }: { className: string }) {
  return (
    <Link to="/auth" className={className}>
      Sign In
    </Link>
  );
}

function RegisterLink({ className }: { className: string }) {
  return (
    <Link to="/auth" search={{ mode: "register" }} className={className}>
      Register
    </Link>
  );
}

const PRIMARY_BTN =
  "inline-flex h-11 items-center justify-center rounded-md bg-brand px-7 text-sm font-medium tracking-wide text-brand-foreground transition-colors hover:bg-brand/90";
const GHOST_BTN =
  "inline-flex h-11 items-center justify-center rounded-md border border-ink-border px-7 text-sm font-medium tracking-wide text-ink-foreground transition-colors hover:border-brand/50 hover:bg-ink-surface";
const LABEL = "font-mono text-[11px] uppercase tracking-[0.28em] text-ink-muted";

function Landing() {
  const { user } = useAuth();
  const loaded = Route.useLoaderData?.() as typeof HOMEPAGE_FALLBACK | undefined;
  const content = loaded ?? HOMEPAGE_FALLBACK;
  const words = content.mainHeading.trim().split(/\s+/);
  const headTail = words.length > 1 ? words.pop()! : "";
  const headLead = words.join(" ");
  const ROUNDS = [
    { n: "01", title: content.round1Name, line: content.round1Description },
    { n: "02", title: content.round2Name, line: content.round2Description },
    { n: "03", title: content.round3Name, line: content.round3Description },
  ];
  const STATS = content.stats.length ? content.stats : HOMEPAGE_FALLBACK.stats;

  return (
    <div className="min-h-screen bg-ink font-body text-ink-foreground">
      <header className="sticky top-0 z-40 border-b border-ink-border/70 bg-ink/80 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center px-6">
          <div className="flex items-baseline gap-3">
            <span className="font-display text-base font-semibold tracking-tight">{content.siteName}</span>
            <span className="hidden font-mono text-[10px] uppercase tracking-[0.24em] text-ink-muted sm:inline">
              {content.departmentName}
            </span>
          </div>
          <div className="ml-auto flex items-center gap-2">
            {user ? (
              <Link
                to="/dashboard"
                className="inline-flex h-9 items-center rounded-md bg-brand px-4 text-sm font-medium text-brand-foreground"
              >
                Dashboard
              </Link>
            ) : (
              <>
                <SignInLink className="inline-flex h-9 items-center rounded-md px-4 text-sm text-ink-muted transition-colors hover:text-ink-foreground" />
                <RegisterLink className="inline-flex h-9 items-center rounded-md border border-ink-border px-4 text-sm font-medium transition-colors hover:border-brand/50" />
              </>
            )}
          </div>
        </div>
      </header>

      <main>
        {/* Hero */}
        <section className="border-b border-ink-border/60">
          <div className="rise-in mx-auto max-w-6xl px-6 py-24 sm:py-32">
            <div className="mb-10 h-px w-24 bg-brand" />
            <h1 className="font-display text-[clamp(2.6rem,11vw,8.5rem)] font-extrabold leading-[0.88] tracking-[-0.045em]">
              {headLead}
              {headTail ? (
                <>
                  <br />
                  <span className="text-brand">{headTail}</span>
                </>
              ) : null}
            </h1>
            <div className="mt-12 flex flex-col gap-2 border-l border-ink-border pl-6">
              <p className="font-display text-2xl font-semibold tracking-tight sm:text-3xl">
                {content.siteName}
              </p>
              <p className="text-base text-ink-muted sm:text-lg">{content.subtitle}</p>
              <p className={LABEL}>{content.heroText}</p>
            </div>
            <div className="mt-12 flex flex-wrap gap-3">
              <SignInLink className={PRIMARY_BTN} />
              <RegisterLink className={GHOST_BTN} />
            </div>
          </div>
        </section>

        {/* Rounds */}
        <section className="border-b border-ink-border/60">
          <div className="mx-auto max-w-6xl px-6 py-20">
            <h2 className="font-display text-xl font-semibold tracking-tight sm:text-2xl">
              THREE ROUNDS. ONE CHALLENGE.
            </h2>
            <div className="mt-10 grid gap-4 md:grid-cols-3">
              {ROUNDS.map((r) => (
                <div
                  key={r.n}
                  className="glass-panel rounded-xl border border-ink-border/80 p-7"
                >
                  <p className="font-mono text-sm text-brand">{r.n}</p>
                  <h3 className="mt-6 font-display text-lg font-semibold tracking-tight">
                    {r.title}
                  </h3>
                  <p className="mt-2 text-sm text-ink-muted">{r.line}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Features */}
        <section className="border-b border-ink-border/60">
          <div className="mx-auto max-w-6xl px-6 py-20">
            <h2 className="font-display text-xl font-semibold tracking-tight sm:text-2xl">
              BUILT FOR COMPETITION
            </h2>
            <div className="mt-10 grid gap-px overflow-hidden rounded-xl border border-ink-border/80 bg-ink-border/60 sm:grid-cols-2 lg:grid-cols-4">
              {FEATURES.map((f) => (
                <div key={f.title} className="bg-ink-surface/70 p-7">
                  <p className={LABEL}>{f.title}</p>
                  <p className="mt-3 text-sm text-ink-foreground/80">{f.line}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Stats */}
        <section className="border-b border-ink-border/60">
          <div className="mx-auto grid max-w-6xl grid-cols-2 gap-8 px-6 py-16 sm:grid-cols-4">
            {STATS.map((s) => (
              <div key={s.label}>
                <p className="font-display text-3xl font-bold tracking-tight sm:text-4xl">
                  {s.value}
                </p>
                <p className={`mt-2 ${LABEL}`}>{s.label}</p>
              </div>
            ))}
          </div>
        </section>

        {/* How it works */}
        <section className="border-b border-ink-border/60">
          <div className="mx-auto max-w-6xl px-6 py-20">
            <h2 className="font-display text-xl font-semibold tracking-tight sm:text-2xl">
              HOW IT WORKS
            </h2>
            <ol className="mt-10 divide-y divide-ink-border/70 border-y border-ink-border/70">
              {STEPS.map((s) => (
                <li key={s.n} className="flex flex-wrap items-baseline gap-x-8 gap-y-1 py-6">
                  <span className="font-mono text-sm text-brand">{s.n}</span>
                  <span className="font-display text-base font-semibold tracking-tight">
                    {s.title}
                  </span>
                  <span className="text-sm text-ink-muted">{s.line}</span>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* Statement */}
        <section className="border-b border-ink-border/60">
          <div className="mx-auto max-w-6xl px-6 py-20">
            <h2 className="font-display text-2xl font-semibold tracking-tight sm:text-3xl">
              ONE PLATFORM. COMPLETE CONTROL.
            </h2>
            <p className="mt-4 max-w-2xl text-sm text-ink-muted">
              {content.description}
            </p>
          </div>
        </section>

        {/* CTA */}
        <section className="border-b border-ink-border/60">
          <div className="mx-auto max-w-6xl px-6 py-24 text-center">
            <h2 className="font-display text-[clamp(2rem,6vw,4rem)] font-extrabold tracking-[-0.04em]">
              READY TO COMPETE?
            </h2>
            <p className="mt-4 text-sm text-ink-muted">Enter {content.siteName}.</p>
            <div className="mt-10 flex flex-wrap justify-center gap-3">
              <SignInLink className={PRIMARY_BTN} />
              <RegisterLink className={GHOST_BTN} />
            </div>
          </div>
        </section>
      </main>

      <footer className="mx-auto flex max-w-6xl flex-wrap items-end justify-between gap-6 px-6 py-12">
        <div>
          <p className="font-display text-sm font-semibold tracking-tight">{content.siteName}</p>
          <p className={`mt-1 ${LABEL}`}>{content.departmentName}</p>
        </div>
        <p className="text-xs text-ink-muted">{content.footerText}</p>
        <p className="text-xs text-ink-muted">© 2026 CodeArena</p>
      </footer>
    </div>
  );
}
