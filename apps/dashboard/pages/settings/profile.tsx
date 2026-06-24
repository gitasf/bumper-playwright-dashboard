import { useState } from "react";
import { Github, LogOut } from "lucide-react";
import { useRouter } from "@void/react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  SettingsCard,
  SettingsField,
  SettingsHeader,
  SettingsPage,
} from "@/components/settings/settings-primitives";
import { authClient } from "@/lib/auth-client";
import { formatRelativeTime } from "@/lib/time-format";
import type { Props } from "./profile.server";

/**
 * Settings → Profile. Editable identity, connected accounts, password,
 * session management. Each card is its own client-side form against the
 * Better Auth client (`auth` from `void/client`, re-exported as
 * `authClient`).
 */
export default function SettingsProfilePage({
  user,
  hasPassword,
  githubAccount,
  githubEnabled,
}: Props) {
  return (
    <SettingsPage>
      <SettingsHeader
        subtitle="Your personal account — used across every team you join on Wrightful."
        title="Profile"
      />

      <IdentityCard email={user.email} name={user.name} />

      {githubEnabled && <ConnectedAccountsCard githubAccount={githubAccount} />}

      {hasPassword && <PasswordCard />}

      <SessionCard />
    </SettingsPage>
  );
}

function IdentityCard({ name, email }: { name: string; email: string }) {
  const router = useRouter();
  const [draftName, setDraftName] = useState(name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const isDirty = draftName.trim() !== name && draftName.trim() !== "";

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!isDirty) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const result = await authClient.updateUser({ name: draftName.trim() });
      if (result?.error) {
        setError(result.error.message ?? "Could not save changes.");
        return;
      }
      setSaved(true);
      void router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save changes.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <SettingsCard title="Identity">
      <form
        className="m-0"
        onSubmit={(e) => {
          void handleSubmit(e);
        }}
      >
        {error && (
          <Alert className="mb-3" variant="error">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {saved && !error && (
          <Alert className="mb-3" variant="success">
            <AlertDescription>Saved.</AlertDescription>
          </Alert>
        )}
        <SettingsField htmlFor="profile-name" label="Display name">
          <Input
            autoComplete="name"
            id="profile-name"
            maxLength={120}
            nativeInput
            onChange={(e) => {
              setDraftName(e.target.value);
              setSaved(false);
            }}
            required
            value={draftName}
          />
        </SettingsField>
        <SettingsField htmlFor="profile-email" label="Email">
          <Input
            className="font-mono"
            disabled
            id="profile-email"
            nativeInput
            value={email}
          />
        </SettingsField>
        <div className="mt-2">
          <Button disabled={!isDirty || busy} loading={busy} type="submit">
            Save changes
          </Button>
        </div>
      </form>
    </SettingsCard>
  );
}

function ConnectedAccountsCard({
  githubAccount,
}: {
  githubAccount: Props["githubAccount"];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDisconnect() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await authClient.unlinkAccount({ providerId: "github" });
      if (result?.error) {
        setError(result.error.message ?? "Could not disconnect.");
        return;
      }
      void router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not disconnect.");
    } finally {
      setBusy(false);
    }
  }

  // Linking a GitHub account to the signed-in user. Better Auth's
  // `/link-social` is POST-only (like `/sign-in/social`), so it can't be a
  // plain `<a href>` — that GETs the route → 404. The client method POSTs,
  // then follows the returned GitHub authorize URL via a full-page redirect.
  async function handleConnect() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await authClient.linkSocial({
        provider: "github",
        callbackURL: "/settings/profile",
      });
      if (result?.error) {
        setError(result.error.message ?? "Could not connect.");
        setBusy(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not connect.");
      setBusy(false);
    }
  }

  return (
    <SettingsCard title="Connected accounts">
      {error && (
        <Alert className="mb-3" variant="error">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <div className="flex items-center gap-3 rounded-md border border-line-1 bg-bg-2 px-3 py-2.5">
        <Github className="size-5 shrink-0 text-fg-2" />
        <div className="min-w-0 flex-1">
          <div className="font-medium text-[length:var(--text-fs-13)]">
            GitHub
          </div>
          {githubAccount ? (
            <div className="font-mono text-[11.5px] text-fg-3">
              {githubAccount.login ? `@${githubAccount.login}` : "connected"}
              {githubAccount.connectedAt
                ? ` · connected ${formatRelativeTime(githubAccount.connectedAt)}`
                : ""}
            </div>
          ) : (
            <div className="text-[11.5px] text-fg-3">Not connected.</div>
          )}
        </div>
        {githubAccount ? (
          <Button
            disabled={busy}
            loading={busy}
            onClick={() => {
              void handleDisconnect();
            }}
            size="sm"
            variant="ghost"
          >
            Disconnect
          </Button>
        ) : (
          <Button
            disabled={busy}
            loading={busy}
            onClick={() => {
              void handleConnect();
            }}
            size="sm"
            variant="outline"
          >
            Connect
          </Button>
        )}
      </div>
    </SettingsCard>
  );
}

function PasswordCard() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    if (next.length < 12) {
      setError("New password must be at least 12 characters.");
      return;
    }
    if (next !== confirm) {
      setError("New passwords don't match.");
      return;
    }
    setBusy(true);
    try {
      const result = await authClient.changePassword({
        currentPassword: current,
        newPassword: next,
      });
      if (result?.error) {
        setError(result.error.message ?? "Could not update password.");
        return;
      }
      setCurrent("");
      setNext("");
      setConfirm("");
      setSaved(true);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not update password.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <SettingsCard
      subtitle="At least 12 characters. We recommend a generated passphrase from your password manager."
      title="Password"
    >
      <form
        className="m-0"
        onSubmit={(e) => {
          void handleSubmit(e);
        }}
      >
        {error && (
          <Alert className="mb-3" variant="error">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {saved && !error && (
          <Alert className="mb-3" variant="success">
            <AlertDescription>Password updated.</AlertDescription>
          </Alert>
        )}
        <SettingsField htmlFor="pwd-current" label="Current password">
          <Input
            autoComplete="current-password"
            id="pwd-current"
            nativeInput
            onChange={(e) => setCurrent(e.target.value)}
            required
            type="password"
            value={current}
          />
        </SettingsField>
        <SettingsField htmlFor="pwd-new" label="New password">
          <Input
            autoComplete="new-password"
            id="pwd-new"
            minLength={12}
            nativeInput
            onChange={(e) => setNext(e.target.value)}
            required
            type="password"
            value={next}
          />
        </SettingsField>
        <SettingsField htmlFor="pwd-confirm" label="Confirm new password">
          <Input
            autoComplete="new-password"
            id="pwd-confirm"
            minLength={12}
            nativeInput
            onChange={(e) => setConfirm(e.target.value)}
            required
            type="password"
            value={confirm}
          />
        </SettingsField>
        <div className="mt-2">
          <Button disabled={busy} loading={busy} type="submit">
            Update password
          </Button>
        </div>
      </form>
    </SettingsCard>
  );
}

function SessionCard() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSignOut() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await authClient.signOut();
      void router.visit("/login");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not sign out.");
      setBusy(false);
    }
  }

  return (
    <SettingsCard
      subtitle="Sign out of this browser. You'll need to sign back in to use Wrightful."
      title="Session"
    >
      {error && (
        <Alert className="mb-3" variant="error">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <button
        className="inline-flex h-[30px] cursor-pointer items-center justify-center gap-1.5 self-start rounded-[5px] border border-fail/30 bg-fail-soft px-[11px] text-[13px] font-medium text-fail transition-colors hover:bg-fail/20 disabled:opacity-50"
        disabled={busy}
        onClick={() => {
          void handleSignOut();
        }}
        type="button"
      >
        <LogOut className="size-3.5" />
        Sign out
      </button>
    </SettingsCard>
  );
}
