"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { Props } from "./consent.server";

/**
 * OAuth consent screen for MCP clients (and any future OAuth client of the
 * Better Auth provider). Reached mid-authorization: the pending grant code is
 * in the signed `oidc_consent_prompt` cookie, so approving is a same-origin
 * POST to Better Auth's consent endpoint — the response carries the client's
 * `redirect_uri` (with the authorization code appended on approve, or an
 * `access_denied` error on deny) and we send the browser there either way, so
 * the MCP client waiting on its localhost callback always gets an answer.
 */
export default function OAuthConsentPage({
  clientName,
  scopes,
  userEmail,
}: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function decide(accept: boolean) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/oauth2/consent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accept }),
      });
      const body = (await res.json().catch(() => null)) as {
        redirectURI?: string;
        error_description?: string;
      } | null;
      if (!res.ok || !body?.redirectURI) {
        setError(
          body?.error_description ??
            "This authorization request has expired. Retry the connection from your MCP client.",
        );
        setBusy(false);
        return;
      }
      window.location.href = body.redirectURI;
    } catch {
      setError("Something went wrong — retry from your MCP client.");
      setBusy(false);
    }
  }

  const displayName = clientName ?? "An application";

  return (
    <div className="relative flex h-screen items-center justify-center overflow-hidden bg-bg-0 p-10">
      <section className="relative w-full max-w-[420px]">
        <div className="rounded-[12px] border border-line-1 bg-bg-1 p-8 shadow-[var(--shadow-lg)]">
          <h1 className="text-heading font-semibold text-fg-1">
            Authorize {displayName}
          </h1>
          <p className="mt-2 text-sm text-fg-3">
            <span className="font-medium text-fg-1">{displayName}</span> wants
            to access your Wrightful account
            {userEmail ? (
              <>
                {" "}
                (<span className="font-medium text-fg-1">{userEmail}</span>)
              </>
            ) : null}
            . It will be able to read test runs, results, and artifacts from
            every project you can access.
          </p>

          {scopes.length > 0 ? (
            <ul className="mt-4 space-y-1 rounded-md border border-line-1 bg-bg-0 p-3 text-xs text-fg-3">
              {scopes.map((scope) => (
                <li key={scope} className="font-mono">
                  {scope}
                </li>
              ))}
            </ul>
          ) : null}

          {error ? (
            <p className="mt-4 text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}

          <div className="mt-6 flex gap-3">
            <Button
              className="flex-1"
              disabled={busy}
              onClick={() => {
                void decide(true);
              }}
            >
              Approve
            </Button>
            <Button
              className="flex-1"
              variant="outline"
              disabled={busy}
              onClick={() => {
                void decide(false);
              }}
            >
              Deny
            </Button>
          </div>
          <p className="mt-4 text-xs text-fg-4">
            Only approve if you initiated this connection from a tool you trust.
          </p>
        </div>
      </section>
    </div>
  );
}
