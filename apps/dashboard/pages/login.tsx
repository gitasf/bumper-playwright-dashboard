import { useState } from "react";
import { ArrowRight, Eye, EyeOff } from "lucide-react";
import { auth } from "void/client";
import { Link, useRouter } from "@void/react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import { Label } from "@/components/ui/label";
import { useHydrated } from "@/lib/hooks/use-hydrated";
import { hrefWithNext } from "@/lib/safe-next-path";
import type { Props } from "./login.server";

/**
 * Login page. Uses `void/client`'s preconfigured Better Auth client for
 * email/password sign-in and (when configured) GitHub OAuth.
 *
 * Single centered card, ported from the Wrightful login design bundle onto the
 * local `ui/` component library and theme tokens (a bordered, shadowed card on a
 * dotted-texture backdrop, holding the form).
 *
 * Anonymous users only — server redirects authenticated users to `/` via
 * the colocated loader.
 */
export default function LoginPage({
  githubEnabled,
  signupAllowed,
  resetEnabled,
  next,
}: Props) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Sign-in runs entirely client-side (`auth.signIn`), so the form is useless
  // until React hydrates. Until then, keep the submit disabled: a pre-hydration
  // native submit would otherwise GET this page with the credentials in the
  // query string (leaking the password into the URL/history) and do nothing
  // useful.
  const hydrated = useHydrated();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await auth.signIn.email({ email, password, rememberMe });
      if (result?.error) {
        setError(result.error.message ?? "Sign-in failed");
        return;
      }
      void router.visit(next);
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

  return (
    <div className="relative flex h-screen items-center justify-center overflow-hidden bg-bg-0 p-10">
      {/* subtle dotted texture behind the card */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage:
            "radial-gradient(oklch(0.975 0.003 260 / 0.04) 1px, transparent 1px)",
          backgroundSize: "22px 22px",
          maskImage:
            "radial-gradient(80% 60% at 50% 42%, oklch(0 0 0) 0%, transparent 75%)",
          WebkitMaskImage:
            "radial-gradient(80% 60% at 50% 42%, oklch(0 0 0) 0%, transparent 75%)",
        }}
      />

      <section className="relative w-full max-w-[380px]">
        <div className="rounded-[12px] border border-line-1 bg-bg-1 p-8 shadow-[var(--shadow-lg)]">
          <form
            className="w-full"
            onSubmit={(e) => {
              void handleSubmit(e);
            }}
          >
            <h2 className="text-center font-semibold text-title tracking-[-0.4px]">
              Sign in to Wrightful
            </h2>
            <p className="mt-1.5 text-center text-body text-fg-3">
              Welcome back. Let's get you to your runs.
            </p>

            {githubEnabled && (
              <>
                <Button
                  type="button"
                  variant="outline"
                  size="lg"
                  disabled={busy || !hydrated}
                  className="mt-6 w-full"
                  onClick={() => {
                    void handleGithub();
                  }}
                >
                  <svg
                    aria-hidden="true"
                    fill="currentColor"
                    height="16"
                    viewBox="0 0 16 16"
                    width="16"
                  >
                    <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z" />
                  </svg>
                  Continue with GitHub
                </Button>

                <div className="my-5 flex items-center gap-3">
                  <div className="h-px flex-1 bg-line-1" />
                  <span className="text-caption text-fg-3">or</span>
                  <div className="h-px flex-1 bg-line-1" />
                </div>
              </>
            )}

            <div className={githubEnabled ? "mb-3.5" : "mt-6 mb-3.5"}>
              <Label htmlFor="email" className="text-caption text-fg-2">
                Work email
              </Label>
              <Input
                id="email"
                type="email"
                name="email"
                value={email}
                required
                autoComplete="email"
                placeholder="you@company.com"
                className="mt-[7px]"
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>

            <div className="mb-3.5">
              <div className="flex items-baseline justify-between">
                <Label htmlFor="password" className="text-caption text-fg-2">
                  Password
                </Label>
                {resetEnabled && (
                  <Link
                    href="/forgot-password"
                    className="text-caption text-fg-3 underline-offset-2 transition-colors hover:text-fg-1 hover:underline"
                  >
                    Forgot password?
                  </Link>
                )}
              </div>
              <InputGroup className="mt-[7px]">
                <InputGroupInput
                  id="password"
                  type={showPassword ? "text" : "password"}
                  name="password"
                  value={password}
                  required
                  autoComplete="current-password"
                  placeholder="••••••••••••"
                  onChange={(e) => setPassword(e.target.value)}
                />
                <InputGroupAddon align="inline-end">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={
                      showPassword ? "Hide password" : "Show password"
                    }
                    onClick={() => setShowPassword((v) => !v)}
                  >
                    {showPassword ? <EyeOff /> : <Eye />}
                  </Button>
                </InputGroupAddon>
              </InputGroup>
            </div>

            <div className="mt-4 mb-[18px] flex items-center gap-2.5">
              <Checkbox
                id="remember"
                // SSR-static name; Base UI only wires the label post-hydration.
                aria-label="Keep me signed in"
                checked={rememberMe}
                onCheckedChange={(checked) => setRememberMe(checked)}
              />
              <Label
                htmlFor="remember"
                className="cursor-pointer font-normal text-body text-fg-2"
              >
                Keep me signed in
              </Label>
            </div>

            {error && (
              <p role="alert" className="mb-3 text-body text-destructive">
                {error}
              </p>
            )}

            <Button
              type="submit"
              size="lg"
              loading={busy}
              disabled={!hydrated}
              className="w-full"
            >
              Sign in
              <ArrowRight />
            </Button>

            {signupAllowed && (
              <div className="mt-[22px] text-center text-body text-fg-3">
                New to Wrightful?{" "}
                <Link
                  href={hrefWithNext("/signup", next)}
                  className="text-fg-1 underline underline-offset-2"
                >
                  Create an account
                </Link>
              </div>
            )}
          </form>
        </div>
      </section>
    </div>
  );
}
