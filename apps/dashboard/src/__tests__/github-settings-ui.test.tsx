import type { AnchorHTMLAttributes } from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("@void/react", () => ({
  Link: ({ children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a {...props}>{children}</a>
  ),
}));

const SettingsTeamGeneralPage = (
  await import("../../pages/settings/teams/[teamSlug]/general")
).default;
type Props = Parameters<typeof SettingsTeamGeneralPage>[0];

function makeProps(
  role: "owner" | "member" = "owner",
  settingsUrl:
    | string
    | null = "https://github.com/organizations/acme/settings/installations/42",
): Props {
  return {
    team: { id: "team_1", slug: "acme", name: "Acme", role },
    projectCount: 1,
    retention: {
      artifactDays: null,
      testResultDays: null,
      defaultArtifactDays: 30,
      defaultTestResultDays: 90,
    },
    github: {
      enabled: true,
      installUrl:
        "https://github.com/apps/wrightful/installations/new?state=acme",
      installations: [
        {
          installationId: 42,
          accountLogin: "acme",
          settingsUrl,
          repositorySelection: "selected",
          repositories: [
            { id: 7, fullName: "acme/api", private: true },
            { id: 8, fullName: "acme/web", private: false },
          ],
          repositoryCount: 2,
          repositoriesTruncated: false,
        },
      ],
    },
    generalError: null,
    retentionError: null,
    githubError: null,
    dangerError: null,
  };
}

afterEach(cleanup);

describe("GitHub checks settings", () => {
  it("shows live repositories and owner controls for each installation", () => {
    render(<SettingsTeamGeneralPage {...makeProps()} />);

    expect(screen.getByText("acme/api")).toBeTruthy();
    expect(screen.getByText("acme/web")).toBeTruthy();
    expect(screen.getByText("Private")).toBeTruthy();
    expect(screen.getByText("2 selected repositories")).toBeTruthy();

    const manage = screen.getByRole("link", {
      name: /add or remove repositories/i,
    });
    expect(manage.getAttribute("href")).toBe(
      "https://github.com/organizations/acme/settings/installations/42",
    );

    const disconnect = screen.getByRole("button", {
      name: "Disconnect acme from Wrightful",
    });
    expect(disconnect.closest("form")?.getAttribute("action")).toBe(
      "/settings/teams/acme/general?disconnectGithub",
    );
  });

  it("does not expose the installation's private repository inventory to non-owners", () => {
    render(<SettingsTeamGeneralPage {...makeProps("member")} />);

    expect(screen.getByText("acme")).toBeTruthy();
    expect(screen.getByText("Connected")).toBeTruthy();
    expect(screen.queryByText("acme/api")).toBeNull();
    expect(
      screen.queryByRole("link", { name: /add or remove repositories/i }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: /disconnect/i })).toBeNull();
  });

  it("omits the management link when GitHub installation details are unavailable", () => {
    render(<SettingsTeamGeneralPage {...makeProps("owner", null)} />);

    expect(screen.getByText("acme/api")).toBeTruthy();
    expect(
      screen.queryByRole("link", { name: /add or remove repositories/i }),
    ).toBeNull();
    expect(
      screen.getByRole("button", {
        name: "Disconnect acme from Wrightful",
      }),
    ).toBeTruthy();
  });
});
