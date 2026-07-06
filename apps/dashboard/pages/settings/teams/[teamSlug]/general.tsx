import { Link } from "@/components/ui/link";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  SettingsCard,
  SettingsField,
  SettingsGroupGap,
  SettingsHeader,
  SettingsPage,
} from "@/components/settings/settings-primitives";
import type { Props } from "./general.server";

/**
 * Settings → Team → General. Identity (name + slug) and Danger zone
 * (delete team). Members + Projects are sibling routes.
 */
export default function SettingsTeamGeneralPage({
  team,
  projectCount,
  retention,
  github,
  generalError,
  retentionError,
  githubError,
  dangerError,
}: Props) {
  const isOwner = team.role === "owner";
  const here = `/settings/teams/${team.slug}/general`;

  return (
    <SettingsPage>
      <SettingsHeader
        title={`${team.name} · General`}
        subtitle="Settings that apply to every project in this team."
      />

      <SettingsCard title="Identity">
        <form action={`${here}?updateGeneral`} className="m-0" method="post">
          {generalError && (
            <Alert className="mb-3" variant="error">
              <AlertDescription>{generalError}</AlertDescription>
            </Alert>
          )}
          <SettingsField label="Team name">
            <Input
              defaultValue={team.name}
              disabled={!isOwner}
              maxLength={60}
              name="name"
              nativeInput
              required
            />
          </SettingsField>
          <SettingsField
            hint={
              <>
                The URL is <code className="font-mono">/t/{team.slug}</code> —
                changing this will break existing links.
              </>
            }
            label="URL slug"
          >
            <Input
              className="font-mono"
              defaultValue={team.slug}
              disabled={!isOwner}
              maxLength={40}
              name="slug"
              nativeInput
              pattern="[a-z0-9][a-z0-9-]*[a-z0-9]|[a-z0-9]"
              required
            />
          </SettingsField>
          {isOwner && (
            <div className="mt-2 flex items-center gap-3">
              <Button size="sm" type="submit">
                Save changes
              </Button>
              <Link
                className="font-mono text-[11px] text-fg-3 uppercase tracking-wider transition-colors hover:text-fg-1"
                href={here}
              >
                Discard
              </Link>
            </div>
          )}
        </form>
      </SettingsCard>

      <SettingsGroupGap />
      <SettingsCard title="Data retention">
        <form action={`${here}?updateRetention`} className="m-0" method="post">
          {retentionError && (
            <Alert className="mb-3" variant="error">
              <AlertDescription>{retentionError}</AlertDescription>
            </Alert>
          )}
          <p className="mb-4 text-[length:var(--text-fs-13)] text-fg-3 leading-relaxed">
            How long to keep data before it's automatically deleted. Leave a
            field blank to use the default. Artifacts (traces, videos,
            screenshots) are usually kept for a shorter window than run history.
          </p>
          <SettingsField
            hint={`Days to keep artifact files. Default ${retention.defaultArtifactDays}.`}
            label="Artifact storage"
          >
            <Input
              defaultValue={retention.artifactDays ?? ""}
              disabled={!isOwner}
              max={3650}
              min={1}
              name="artifactDays"
              nativeInput
              placeholder={String(retention.defaultArtifactDays)}
              type="number"
            />
          </SettingsField>
          <SettingsField
            hint={`Days to keep test-result history. Must be ≥ the artifact window. Default ${retention.defaultTestResultDays}.`}
            label="Test results"
          >
            <Input
              defaultValue={retention.testResultDays ?? ""}
              disabled={!isOwner}
              max={3650}
              min={1}
              name="testResultDays"
              nativeInput
              placeholder={String(retention.defaultTestResultDays)}
              type="number"
            />
          </SettingsField>
          {isOwner && (
            <div className="mt-2">
              <Button size="sm" type="submit">
                Save retention
              </Button>
            </div>
          )}
        </form>
      </SettingsCard>

      {github.enabled && (
        <>
          <SettingsGroupGap />
          <SettingsCard title="GitHub checks">
            {githubError && (
              <Alert className="mb-3" variant="error">
                <AlertDescription>{githubError}</AlertDescription>
              </Alert>
            )}
            <p className="mb-4 text-[length:var(--text-fs-13)] text-fg-3 leading-relaxed">
              Connect a GitHub organization to post a check run on each commit —
              pass/fail/flaky with a link to the run report — so test results
              gate pull-request merges.
            </p>
            {github.installations.length > 0 ? (
              <ul className="mb-4 flex flex-col gap-1">
                {github.installations.map((login) => (
                  <li
                    className="flex items-center gap-2 text-[length:var(--text-fs-13)] text-fg-1"
                    key={login}
                  >
                    <span className="size-1.5 rounded-full bg-passed" />
                    <code className="font-mono">{login}</code>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mb-4 text-[length:var(--text-fs-13)] text-fg-3">
                No GitHub organizations connected yet.
              </p>
            )}
            {isOwner &&
              (github.installUrl ? (
                <Button
                  render={<a href={github.installUrl} rel="noreferrer" />}
                  size="sm"
                >
                  {github.installations.length > 0
                    ? "Connect another organization"
                    : "Connect a GitHub organization"}
                </Button>
              ) : (
                <p className="text-[length:var(--text-fs-13)] text-fg-3 leading-relaxed">
                  Set <code className="font-mono">GITHUB_APP_SLUG</code> to
                  enable one-click install, or install the GitHub App manually
                  and point its setup URL at{" "}
                  <code className="font-mono">/api/github/setup</code>.
                </p>
              ))}
          </SettingsCard>
        </>
      )}

      {isOwner && (
        <>
          <SettingsGroupGap />
          <SettingsCard title="Danger zone" tone="danger">
            <div className="flex flex-col gap-3">
              <p className="text-[length:var(--text-fs-13)] text-fg-3 leading-relaxed">
                Permanently deletes{" "}
                <span className="font-medium text-fg-1">{team.name}</span> and
                all <span className="font-mono">{projectCount}</span>{" "}
                {projectCount === 1 ? "project" : "projects"}, runs, and
                artifacts. There is no recovery.
              </p>
              <details className="group">
                <summary className="inline-flex h-[30px] cursor-pointer list-none items-center justify-center self-start rounded-[5px] border border-fail/30 bg-fail-soft px-[11px] text-[13px] font-medium text-fail transition-colors hover:bg-fail/20 [&::-webkit-details-marker]:hidden">
                  Delete team
                </summary>
                <form
                  action={`${here}?deleteTeam`}
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
                      {team.slug}
                    </code>{" "}
                    below to confirm.
                  </p>
                  <Input
                    autoComplete="off"
                    className="font-mono"
                    name="confirm"
                    nativeInput
                    placeholder={team.slug}
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
        </>
      )}
    </SettingsPage>
  );
}
