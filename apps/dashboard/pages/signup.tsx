import { useState } from "react";
import { auth } from "void/client";
import { Link, useRouter } from "@void/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useHydrated } from "@/lib/hooks/use-hydrated";
import { hrefWithNext } from "@/lib/safe-next-path";
import type { Props } from "./signup.server";

/**
 * Open-signup page (email + password). Mirrors `login.tsx`; reachable only when
 * `ALLOW_OPEN_SIGNUP` is enabled (the colocated loader bounces to /login
 * otherwise). Authenticated users are redirected to `/` by the loader.
 */
export default function SignupPage({
  githubEnabled,
  verifyEmail,
  next,
}: Props) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // When email verification is required, signup doesn't create a session —
  // show a "check your inbox" panel instead of routing to the dashboard.
  const [awaitingVerification, setAwaitingVerification] = useState(false);
  // Sign-up runs client-side (`auth.signUp`); disable submit until hydrated so
  // a pre-hydration native submit can't GET this page with the password in the
  // query string. (Mirrors login.tsx.)
  const hydrated = useHydrated();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await auth.signUp.email({ name, email, password });
      if (result?.error) {
        setError(result.error.message ?? "Sign-up failed");
        return;
      }
      if (verifyEmail) {
        setAwaitingVerification(true);
        return;
      }
      void router.visit(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-up failed");
    } finally {
      setBusy(false);
    }
  }

  // Better Auth's `/sign-in/social` is POST-only, so it can't be a plain
  // `<a href>` (that GETs the route → 404). The client method POSTs, then
  // follows the returned GitHub authorize URL via a full-page redirect.
  async function handleGithub() {
    setBusy(true);
    setError(null);
    try {
      const result = await auth.signIn.social({
        provider: "github",
        callbackURL: next,
      });
      if (result?.error) {
        setError(result.error.message ?? "GitHub sign-in failed");
        setBusy(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "GitHub sign-in failed");
      setBusy(false);
    }
  }

  if (awaitingVerification) {
    return (
      <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 p-6 text-center">
        <header className="space-y-2">
          <h1 className="text-title font-semibold text-balance">
            Check your inbox
          </h1>
          <p className="text-fg-3 text-sm">
            We sent a verification link to{" "}
            <span className="text-fg-1 font-medium">{email}</span>. Click it to
            finish setting up your account, then sign in.
          </p>
        </header>
        <Link href="/login" className="text-sm underline underline-offset-2">
          Back to sign in
        </Link>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-8 p-6">
      <header className="space-y-2 text-center">
        <h1 className="text-title font-semibold text-balance">
          Create your Wrightful account
        </h1>
        <p className="text-fg-3 text-sm">Get started in a few seconds.</p>
      </header>

      <form
        className="space-y-4"
        onSubmit={(e) => {
          void handleSubmit(e);
        }}
      >
        <div className="space-y-2">
          <Label htmlFor="name">Name</Label>
          <Input
            id="name"
            type="text"
            value={name}
            required
            autoComplete="name"
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            value={email}
            required
            autoComplete="email"
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            type="password"
            value={password}
            required
            minLength={8}
            autoComplete="new-password"
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        {error && (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        )}
        <Button type="submit" disabled={busy || !hydrated} className="w-full">
          {busy ? "Creating account…" : "Create account"}
        </Button>
      </form>

      {githubEnabled && (
        <div className="space-y-2">
          <div className="bg-line-1 h-px" />
          <Button
            type="button"
            disabled={busy || !hydrated}
            onClick={() => {
              void handleGithub();
            }}
            className="bg-fg-1 text-bg-0 hover:bg-fg-1/90 w-full"
          >
            Continue with GitHub
          </Button>
        </div>
      )}

      <p className="text-center text-sm">
        Already have an account?{" "}
        <Link
          href={hrefWithNext("/login", next)}
          className="underline underline-offset-2"
        >
          Sign in
        </Link>
      </p>
    </main>
  );
}
