import { useState } from "react";
import { auth } from "void/client";
import { Link } from "@void/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useHydrated } from "@/lib/hooks/use-hydrated";

/**
 * Request a password-reset link. Runs client-side via `void/client`'s Better
 * Auth `requestPasswordReset`, which triggers the server `sendResetPassword`
 * hook (the reset link lands on `/reset-password` with a one-time token).
 *
 * On submit we always show the same generic confirmation regardless of whether
 * the address exists — not leaking account existence is why the response
 * doesn't branch on `result.error`.
 */
export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  // Mirror login/signup: the request runs client-side, so keep submit disabled
  // until hydration to avoid a pre-hydration native GET leaking the email.
  const hydrated = useHydrated();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await auth.requestPasswordReset({ email, redirectTo: "/reset-password" });
    } finally {
      // Show the same confirmation whether or not the account exists.
      setBusy(false);
      setSent(true);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-8 p-6">
      <header className="space-y-2 text-center">
        <h1 className="text-title font-semibold">Reset your password</h1>
        <p className="text-fg-3 text-sm">
          Enter your email and we’ll send you a reset link.
        </p>
      </header>

      {sent ? (
        <div className="space-y-4 text-center">
          <p className="text-sm">
            If an account exists for{" "}
            <span className="font-medium">{email}</span>, a password-reset link
            is on its way. Check your inbox.
          </p>
          <Link href="/login" className="text-sm underline">
            Back to sign in
          </Link>
        </div>
      ) : (
        <>
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
            <Button
              type="submit"
              disabled={busy || !hydrated}
              className="w-full"
            >
              {busy ? "Sending…" : "Send reset link"}
            </Button>
          </form>

          <p className="text-center text-sm">
            <Link href="/login" className="underline">
              Back to sign in
            </Link>
          </p>
        </>
      )}
    </main>
  );
}
