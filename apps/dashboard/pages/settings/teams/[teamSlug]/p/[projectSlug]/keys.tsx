import { useMutation } from "@tanstack/react-query";
import { format } from "date-fns";
import { ArrowLeft, Download, KeyRound, Plus } from "lucide-react";
import { useState } from "react";
import { Link, useRouter } from "@void/react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { RevealOnceDialog } from "@/components/settings/reveal-once-dialog";
import {
  SettingsCard,
  SettingsField,
  SettingsGroupGap,
  SettingsHeader,
  SettingsPage,
} from "@/components/settings/settings-primitives";
import { cn } from "@/lib/cn";
import { formatRelativeTime } from "@/lib/time-format";
import type { Props } from "./keys.server";

interface MintKeyResponse {
  key: {
    id: string;
    label: string;
    keyPrefix: string;
    createdAt: number;
    lastUsedAt: number | null;
    revokedAt: number | null;
  };
  token: string;
}

/**
 * Settings → Project. Project identity (rename / slug), API keys, and the
 * Danger zone (delete project). Minting a key runs client-side via tanstack
 * query against `/api/teams/:teamSlug/p/:projectSlug/keys`; the plaintext
 * token comes back in the response and is held in local state for the modal.
 */
export default function SettingsProjectKeysPage({
  project,
  keys,
  codeowners,
  generalError,
  dangerError,
  codeownersError,
}: Props) {
  const router = useRouter();
  const here = `/settings/teams/${project.teamSlug}/p/${project.slug}/keys`;
  // One-click CSV of this project's run history. Plain <a download>, not <Link>:
  // the server returns a text/csv attachment, so the SPA router must NOT
  // intercept it. No filters here — settings has no filter-bar context, so this
  // exports the project's runs at the export route's defaults.
  const exportHref = `/api/t/${project.teamSlug}/p/${project.slug}/export/runs`;

  const [label, setLabel] = useState("");
  const [revealedToken, setRevealedToken] = useState<string | null>(null);

  const mintKey = useMutation<MintKeyResponse, Error, { label: string }>({
    mutationFn: async ({ label: lbl }) => {
      const res = await fetch(
        `/api/teams/${project.teamSlug}/p/${project.slug}/keys`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ label: lbl }),
        },
      );
      if (!res.ok) {
        const body: unknown = await res.json().catch(() => null);
        const message =
          typeof body === "object" &&
          body !== null &&
          "error" in body &&
          typeof body.error === "string"
            ? body.error
            : "Could not mint key.";
        throw new Error(message);
      }
      return (await res.json()) as MintKeyResponse;
    },
    onSuccess: (data) => {
      setRevealedToken(data.token);
      void router.refresh();
    },
  });

  return (
    <SettingsPage>
      <Link
        className="mb-2 inline-flex items-center gap-1.5 font-mono text-[11.5px] text-fg-3 transition-colors hover:text-fg-1"
        href={`/settings/teams/${project.teamSlug}/projects`}
      >
        <ArrowLeft className="size-3" />
        Projects
      </Link>
      <SettingsHeader
        subtitle="Manage this project's identity, API keys, query API, code owners, and deletion."
        title={`${project.name} · Settings`}
      />

      <RevealOnceDialog
        description="This is the only time you'll see the full token. Copy it into your CI secret manager before closing this dialog."
        onClose={() => setRevealedToken(null)}
        open={Boolean(revealedToken)}
        title="Save this key now"
      >
        <pre className="overflow-x-auto rounded-md border border-line-1 bg-bg-0 p-2.5 font-mono text-[13px] text-fg-1">
          {revealedToken}
        </pre>
      </RevealOnceDialog>

      <SettingsCard title="Project identity">
        <form action={`${here}?updateGeneral`} className="m-0" method="post">
          {generalError && (
            <Alert className="mb-3" variant="error">
              <AlertDescription>{generalError}</AlertDescription>
            </Alert>
          )}
          <SettingsField label="Project name">
            <Input
              defaultValue={project.name}
              maxLength={60}
              name="name"
              nativeInput
              required
            />
          </SettingsField>
          <SettingsField
            hint={
              <>
                The URL is{" "}
                <code className="font-mono">
                  /t/{project.teamSlug}/p/{project.slug}
                </code>{" "}
                — changing this will break existing links.
              </>
            }
            label="URL slug"
          >
            <Input
              className="font-mono"
              defaultValue={project.slug}
              maxLength={40}
              name="slug"
              nativeInput
              pattern="[a-z0-9][a-z0-9-]*[a-z0-9]|[a-z0-9]"
              required
            />
          </SettingsField>
          <div className="mt-2">
            <Button size="sm" type="submit">
              Save changes
            </Button>
          </div>
        </form>
      </SettingsCard>

      <SettingsCard
        subtitle="Tokens are shown once at creation. After that only the prefix is visible — store the full token in your CI secret manager."
        title={`Keys · ${keys.length}`}
      >
        <form
          className="m-0 mb-4 flex flex-col gap-2 sm:flex-row sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            const trimmed = label.trim();
            if (!trimmed) return;
            mintKey.mutate({ label: trimmed });
          }}
        >
          <div className="flex-1">
            <Input
              aria-label="Key label"
              maxLength={60}
              name="label"
              nativeInput
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. GitHub Actions · main"
              required
              value={label}
            />
          </div>
          <Button
            disabled={mintKey.isPending}
            loading={mintKey.isPending}
            type="submit"
          >
            <Plus className="size-4" />
            Mint key
          </Button>
        </form>
        {mintKey.error && (
          <Alert className="mb-3" variant="error">
            <AlertDescription>{mintKey.error.message}</AlertDescription>
          </Alert>
        )}
        {keys.length === 0 ? (
          <div className="py-6 text-center text-[length:var(--text-fs-13)] text-fg-3">
            No keys yet.
          </div>
        ) : (
          <div className="-mx-[18px]">
            {keys.map((k, i) => {
              const revoked = Boolean(k.revokedAt);
              return (
                <div
                  className={cn(
                    "flex items-center gap-3.5 px-[18px] py-3",
                    i !== keys.length - 1 && "border-b border-line-1",
                  )}
                  key={k.id}
                >
                  <div className="flex size-7 shrink-0 items-center justify-center rounded-md bg-bg-3 text-fg-2">
                    <KeyRound className="size-3.5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="font-medium text-[length:var(--text-fs-14)]">
                      {k.label}
                    </div>
                    <div className="mt-0.5 font-mono text-[11.5px] text-fg-3">
                      {k.keyPrefix}
                      <span className="opacity-40">················</span>
                    </div>
                  </div>
                  <div className="w-32 text-right font-mono text-[11.5px] text-fg-3">
                    {k.lastUsedAt
                      ? `used ${formatRelativeTime(k.lastUsedAt)}`
                      : "never used"}
                  </div>
                  <div className="w-24 text-right font-mono text-[11.5px] text-fg-3 tabular-nums">
                    {format(new Date(k.createdAt * 1000), "yyyy-MM-dd")}
                  </div>
                  <span
                    className={cn(
                      "inline-flex w-[72px] items-center justify-center gap-1.5 rounded-sm px-1.5 py-0.5 font-mono text-[10.5px] uppercase tracking-wider",
                      revoked
                        ? "bg-fail-soft text-fail"
                        : "bg-pass-soft text-pass",
                    )}
                  >
                    <span
                      className={cn(
                        "inline-block size-1.5 rounded-full",
                        revoked ? "bg-fail" : "bg-pass",
                      )}
                    />
                    {revoked ? "revoked" : "active"}
                  </span>
                  {!revoked && (
                    <form
                      action={`${here}?revokeKey`}
                      className="m-0"
                      method="post"
                    >
                      <input name="keyId" type="hidden" value={k.id} />
                      <Button size="xs" type="submit" variant="ghost">
                        Revoke
                      </Button>
                    </form>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </SettingsCard>

      <SettingsCard
        subtitle="Read your runs and test results programmatically with a project API key. Same Bearer token as the reporter, in the Authorization header."
        title="Query & export API"
      >
        <div className="flex flex-col gap-3 text-[length:var(--text-fs-13)] text-fg-2 leading-relaxed">
          <div className="flex flex-wrap items-center gap-3">
            <Button
              render={
                <a download href={exportHref}>
                  <Download className="size-4" />
                  Export CSV
                </a>
              }
              size="sm"
              variant="outline"
            />
            <span className="text-fg-3">
              Download this project&apos;s run history as a CSV.
            </span>
          </div>
          <p>
            Authenticate with{" "}
            <code className="rounded-sm bg-bg-3 px-1 py-0.5 font-mono text-[11px] text-fg-1">
              Authorization: Bearer &lt;key&gt;
            </code>
            . Endpoints are scoped to this project — a key never sees another
            project&apos;s data.
          </p>
          <ul className="flex flex-col gap-1 font-mono text-[11.5px] text-fg-3">
            <li>GET /api/v1/runs</li>
            <li>GET /api/v1/runs/:runId</li>
            <li>GET /api/v1/runs/:runId/tests</li>
          </ul>
          <p>
            Lists are cursor-paged: pass{" "}
            <code className="rounded-sm bg-bg-3 px-1 py-0.5 font-mono text-[11px] text-fg-1">
              ?cursor=
            </code>{" "}
            from the previous response&apos;s{" "}
            <code className="rounded-sm bg-bg-3 px-1 py-0.5 font-mono text-[11px] text-fg-1">
              nextCursor
            </code>
            . Add{" "}
            <code className="rounded-sm bg-bg-3 px-1 py-0.5 font-mono text-[11px] text-fg-1">
              ?format=csv
            </code>{" "}
            to download a CSV — the same data the Export CSV button above
            produces. See the full{" "}
            <a
              className="text-fg-1 underline underline-offset-2 hover:text-accent"
              href="https://github.com/joefairburn/wrightful/blob/main/docs/api/query-export.md"
              rel="noreferrer"
              target="_blank"
            >
              API reference
            </a>{" "}
            for filters and CSV columns.
          </p>
        </div>
      </SettingsCard>

      <SettingsCard
        subtitle="Owners are derived by matching each test's file path against this CODEOWNERS file. The reporter sends your repo's CODEOWNERS automatically on each run — paste it here to set or override it (e.g. if your repo has none). Manual owner assignments on the flaky page take precedence."
        title="CODEOWNERS"
      >
        <form action={`${here}?updateCodeowners`} className="m-0" method="post">
          {codeownersError && (
            <Alert className="mb-3" variant="error">
              <AlertDescription>{codeownersError}</AlertDescription>
            </Alert>
          )}
          <SettingsField
            hint={
              codeowners.updatedAt
                ? `Last updated ${formatRelativeTime(codeowners.updatedAt)}. Leave blank and save to clear.`
                : "No CODEOWNERS file set yet. Leave blank and save to clear."
            }
            label="CODEOWNERS file"
          >
            <Textarea
              className="font-mono"
              defaultValue={codeowners.file}
              name="codeowners"
              placeholder={
                "# Example\n/tests/checkout/  @team/payments\n*.spec.ts         @team/qa"
              }
              rows={10}
            />
          </SettingsField>
          <div className="mt-2">
            <Button size="sm" type="submit">
              Save CODEOWNERS
            </Button>
          </div>
        </form>
      </SettingsCard>

      <SettingsGroupGap />

      <SettingsCard title="Danger zone" tone="danger">
        <div className="flex flex-col gap-3">
          <p className="text-[length:var(--text-fs-13)] text-fg-3 leading-relaxed">
            Permanently delete this project, its API keys, and all run history.
            This cannot be undone.
          </p>
          <details className="group">
            <summary className="inline-flex h-[30px] cursor-pointer list-none items-center justify-center self-start rounded-[5px] border border-fail/30 bg-fail-soft px-[11px] text-[13px] font-medium text-fail transition-colors hover:bg-fail/20 [&::-webkit-details-marker]:hidden">
              Delete project
            </summary>
            <form
              action={`${here}?deleteProject`}
              className="mt-4 flex flex-col gap-3 border-fail/20 border-t pt-4"
              method="post"
            >
              {dangerError && (
                <Alert variant="error">
                  <AlertDescription>{dangerError}</AlertDescription>
                </Alert>
              )}
              <p className="text-[length:var(--text-fs-13)] text-fg-3 leading-relaxed">
                Type{" "}
                <code className="rounded-sm bg-bg-3 px-1 py-0.5 font-mono text-[11px] text-fg-1">
                  {project.slug}
                </code>{" "}
                below to confirm.
              </p>
              <Input
                autoComplete="off"
                className="font-mono"
                name="confirm"
                nativeInput
                placeholder={project.slug}
                required
              />
              <Button
                className="self-start"
                size="sm"
                type="submit"
                variant="destructive"
              >
                Permanently delete
              </Button>
            </form>
          </details>
        </div>
      </SettingsCard>
    </SettingsPage>
  );
}
