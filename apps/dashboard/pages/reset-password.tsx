import { useState } from "react";
import { auth } from "void/client";
import { Link, useRouter } from "@void/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useHydrated } from "@/lib/hooks/use-hydrated";
import type { Props } from "./reset-password.server";

/**
 * Set a new password from a reset link. The token arrives as a query param
 * (resolved server-side in the loader); a missing/`error` token means an
 * expired or already-used link. Submits client-side via Better Auth
 * `resetPassword`, then sends the user to `/login`.
 */
export default function ResetPasswordPage({ token, tokenError }: Props) {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hydrated = useHydrated();

  const invalidLink = tokenError !== null || token === null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (token === null) return;
    setBusy(true);
    setError(null);
    try {
      const result = await auth.resetPassword({ newPassword: password, token });
      if (result?.error) {
        setError(result.error.message ?? "Couldn’t reset your password");
        return;
      }
      void router.visit("/login");
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Couldn’t reset your password",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-8 p-6">
      <header className="space-y-2 text-center">
        <h1 className="text-title font-semibold">Choose a new password</h1>
      </header>

      {invalidLink ? (
        <div className="space-y-4 text-center">
          <p className="text-destructive text-sm">
            This reset link is invalid or has expired.
          </p>
          <Link href="/forgot-password" className="text-sm underline">
            Request a new link
          </Link>
        </div>
      ) : (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            void handleSubmit(e);
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="password">New password</Label>
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
            {busy ? "Updating…" : "Update password"}
          </Button>
        </form>
      )}
    </main>
  );
}
