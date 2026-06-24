import { useEffect, useState } from "react";
import { auth } from "void/client";
import { Link, useRouter } from "@void/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { Props } from "./login.server";

/**
 * Login page. Uses `void/client`'s preconfigured Better Auth client for
 * email/password sign-in and (when configured) GitHub OAuth.
 *
 * Anonymous users only — server redirects authenticated users to `/` via
 * the colocated loader.
 */
export default function LoginPage({
  githubEnabled,
  signupAllowed,
  resetEnabled,
}: Props) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Sign-in runs entirely client-side (`auth.signIn`), so the form is useless
  // until React hydrates. Until then, keep the submit disabled: a pre-hydration
  // native submit would otherwise GET this page with the credentials in the
  // query string (leaking the password into the URL/history) and do nothing
  // useful. `useEffect` only runs after hydration.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await auth.signIn.email({ email, password });
      if (result?.error) {
        setError(result.error.message ?? "Sign-in failed");
        return;
      }
      void router.visit("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed");
    } finally {
      setBusy(false);
    }
  }

  // Better Auth's `/sign-in/social` is a POST endpoint, so it can't be a plain
  // `<a href>` (that GETs the route → 404). The client method POSTs, then
  // follows the returned GitHub authorize URL via a full-page redirect.
  async function handleGithub() {
    setBusy(true);
    setError(null);
    try {
      const result = await auth.signIn.social({
        provider: "github",
        callbackURL: "/",
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

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-8 p-6">
      <header className="space-y-2 text-center">
        <h1 className="text-2xl font-semibold">Sign in to Wrightful</h1>
        <p className="text-muted-foreground text-sm">
          Welcome back. Continue to the dashboard.
        </p>
      </header>

      <form
        className="space-y-4"
        onSubmit={(e) => {
          void handleSubmit(e);
        }}
      >
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
          <div className="flex items-center justify-between">
            <Label htmlFor="password">Password</Label>
            {resetEnabled && (
              <Link
                href="/forgot-password"
                className="text-muted-foreground text-xs underline"
              >
                Forgot password?
              </Link>
            )}
          </div>
          <Input
            id="password"
            type="password"
            value={password}
            required
            autoComplete="current-password"
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        {error && (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        )}
        <Button type="submit" disabled={busy || !hydrated} className="w-full">
          {busy ? "Signing in…" : "Continue"}
        </Button>
      </form>

      {githubEnabled && (
        <div className="space-y-2">
          <div className="bg-border h-px" />
          <Button
            type="button"
            disabled={busy || !hydrated}
            onClick={() => {
              void handleGithub();
            }}
            className="bg-foreground text-background hover:bg-foreground/90 w-full"
          >
            Continue with GitHub
          </Button>
        </div>
      )}

      {signupAllowed && (
        <p className="text-center text-sm">
          No account yet?{" "}
          <Link href="/signup" className="underline">
            Create one
          </Link>
        </p>
      )}
    </main>
  );
}
