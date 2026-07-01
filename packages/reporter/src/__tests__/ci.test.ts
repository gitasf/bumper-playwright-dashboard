import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

// Stub the git commit read so tests don't depend on the repo's git state.
vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(() => "stubbed commit message\n"),
}));

// Re-import after the mock so the module picks it up.
const { detectCI, generateIdempotencyKey } = await import("../ci.js");

// Env vars that any of the branches care about. Cleared before each test
// and restored after so the detection logic sees a deterministic state.
const CI_KEYS = [
  "CI",
  "GITHUB_ACTIONS",
  "GITLAB_CI",
  "CIRCLECI",
  "GITHUB_RUN_ID",
  "GITHUB_JOB",
  "GITHUB_REF",
  "GITHUB_REF_NAME",
  "GITHUB_HEAD_REF",
  "GITHUB_SHA",
  "GITHUB_REPOSITORY",
  "GITHUB_ACTOR",
  "GITHUB_TRIGGERING_ACTOR",
  "GITHUB_EVENT_PATH",
  "CI_PIPELINE_ID",
  "CI_JOB_NAME",
  "CI_MERGE_REQUEST_SOURCE_BRANCH_NAME",
  "CI_COMMIT_BRANCH",
  "CI_COMMIT_SHA",
  "CI_COMMIT_MESSAGE",
  "CI_MERGE_REQUEST_IID",
  "CI_PROJECT_PATH",
  "GITLAB_USER_LOGIN",
  "CIRCLE_WORKFLOW_ID",
  "CIRCLE_JOB",
  "CIRCLE_BRANCH",
  "CIRCLE_SHA1",
  "CIRCLE_PR_NUMBER",
  "CIRCLE_PULL_REQUEST",
  "CIRCLE_PROJECT_USERNAME",
  "CIRCLE_PROJECT_REPONAME",
  "CIRCLE_USERNAME",
  "WRIGHTFUL_IDEMPOTENCY_KEY",
];

describe("detectCI", () => {
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    originalEnv = {};
    for (const k of CI_KEYS) {
      originalEnv[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(originalEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("returns null when no CI env vars are set", () => {
    expect(detectCI()).toBeNull();
  });

  it("detects GitHub Actions with full env", () => {
    process.env.GITHUB_ACTIONS = "true";
    process.env.GITHUB_RUN_ID = "42";
    process.env.GITHUB_JOB = "e2e";
    process.env.GITHUB_HEAD_REF = "feat/x";
    process.env.GITHUB_SHA = "abc123";
    process.env.GITHUB_REPOSITORY = "acme/app";
    process.env.GITHUB_TRIGGERING_ACTOR = "octocat";
    process.env.GITHUB_REF = "refs/pull/77/merge";

    expect(detectCI()).toEqual({
      ciProvider: "github-actions",
      ciBuildId: "42",
      ciJobName: "e2e",
      branch: "feat/x",
      commitSha: "abc123",
      commitMessage: "stubbed commit message",
      prNumber: 77,
      repo: "acme/app",
      actor: "octocat",
    });
  });

  it("falls back to GITHUB_REF_NAME when GITHUB_HEAD_REF is unset (push event)", () => {
    process.env.GITHUB_ACTIONS = "true";
    process.env.GITHUB_REF_NAME = "main";
    const info = detectCI();
    expect(info?.branch).toBe("main");
    expect(info?.prNumber).toBeNull();
  });

  it("parses GITHUB_REF pull-request refs into prNumber", () => {
    process.env.GITHUB_ACTIONS = "true";
    process.env.GITHUB_REF = "refs/pull/123/merge";
    expect(detectCI()?.prNumber).toBe(123);
  });

  it("returns nulls (not undefineds) for missing GitHub Actions fields", () => {
    process.env.GITHUB_ACTIONS = "true";
    const info = detectCI();
    expect(info).toEqual({
      ciProvider: "github-actions",
      ciBuildId: null,
      ciJobName: null,
      branch: null,
      commitSha: null,
      commitMessage: "stubbed commit message",
      prNumber: null,
      repo: null,
      actor: null,
    });
  });

  describe("GITHUB_EVENT_PATH fallback for prNumber", () => {
    let eventDir: string;

    beforeEach(() => {
      eventDir = mkdtempSync(join(tmpdir(), "wrightful-event-"));
    });

    afterEach(() => {
      rmSync(eventDir, { recursive: true, force: true });
    });

    it("reads pull_request.number from the event payload when GITHUB_REF doesn't match (pull_request_target)", () => {
      const eventPath = join(eventDir, "event.json");
      writeFileSync(
        eventPath,
        JSON.stringify({ pull_request: { number: 88 } }),
      );
      process.env.GITHUB_ACTIONS = "true";
      process.env.GITHUB_REF = "refs/heads/main";
      process.env.GITHUB_EVENT_PATH = eventPath;

      expect(detectCI()?.prNumber).toBe(88);
    });

    it("prefers the GITHUB_REF pull ref over the event payload", () => {
      const eventPath = join(eventDir, "event.json");
      writeFileSync(
        eventPath,
        JSON.stringify({ pull_request: { number: 88 } }),
      );
      process.env.GITHUB_ACTIONS = "true";
      process.env.GITHUB_REF = "refs/pull/12/merge";
      process.env.GITHUB_EVENT_PATH = eventPath;

      expect(detectCI()?.prNumber).toBe(12);
    });

    it("prefers the PR head sha over the merge-commit GITHUB_SHA (pull_request event)", () => {
      const eventPath = join(eventDir, "event.json");
      writeFileSync(
        eventPath,
        JSON.stringify({
          pull_request: {
            number: 7,
            head: { sha: "abc123def4567890abc123def4567890abc12345" },
          },
        }),
      );
      process.env.GITHUB_ACTIONS = "true";
      // GITHUB_SHA is the ephemeral merge commit on pull_request events.
      process.env.GITHUB_SHA = "0000000000000000000000000000000000000000";
      process.env.GITHUB_REF = "refs/pull/7/merge";
      process.env.GITHUB_EVENT_PATH = eventPath;

      const info = detectCI();
      expect(info?.commitSha).toBe("abc123def4567890abc123def4567890abc12345");
      expect(info?.prNumber).toBe(7);
    });

    it("ignores a non-hex head sha (argument-injection guard) and falls back to GITHUB_SHA", () => {
      const eventPath = join(eventDir, "event.json");
      writeFileSync(
        eventPath,
        JSON.stringify({
          // A crafted head.sha from a hostile fork PR. Must never reach `git log`.
          pull_request: { number: 7, head: { sha: "--output=/tmp/pwn" } },
        }),
      );
      process.env.GITHUB_ACTIONS = "true";
      process.env.GITHUB_SHA = "0000000000000000000000000000000000000000";
      process.env.GITHUB_EVENT_PATH = eventPath;

      const info = detectCI();
      expect(info?.commitSha).toBe("0000000000000000000000000000000000000000");
    });

    it("uses the PR title as the commit message when the head commit isn't readable", () => {
      const eventPath = join(eventDir, "event.json");
      writeFileSync(
        eventPath,
        // No head sha → can't read the head commit's real message, so the
        // human-readable PR title stands in (ahead of the merge-commit message).
        JSON.stringify({
          pull_request: { number: 7, title: "Add login form" },
        }),
      );
      process.env.GITHUB_ACTIONS = "true";
      process.env.GITHUB_SHA = "mergesha456";
      process.env.GITHUB_EVENT_PATH = eventPath;

      const info = detectCI();
      expect(info?.commitMessage).toBe("Add login form");
      expect(info?.prNumber).toBe(7);
    });

    it("prefers the real head commit message over the PR title when both are available", () => {
      const eventPath = join(eventDir, "event.json");
      writeFileSync(
        eventPath,
        JSON.stringify({
          pull_request: {
            number: 7,
            title: "Add login form",
            head: { sha: "abc123def4567890abc123def4567890abc12345" },
          },
        }),
      );
      process.env.GITHUB_ACTIONS = "true";
      process.env.GITHUB_EVENT_PATH = eventPath;

      // execFileSync is stubbed to return a real message for the head sha, so it
      // wins over the PR title.
      expect(detectCI()?.commitMessage).toBe("stubbed commit message");
    });

    it("uses the PR title (not a whitespace-only title) as the message fallback", () => {
      const eventPath = join(eventDir, "event.json");
      writeFileSync(
        eventPath,
        JSON.stringify({ pull_request: { number: 7, title: "   " } }),
      );
      process.env.GITHUB_ACTIONS = "true";
      process.env.GITHUB_EVENT_PATH = eventPath;

      // Whitespace-only title is normalized to null, so it falls through to git.
      expect(detectCI()?.commitMessage).toBe("stubbed commit message");
    });

    it("rejects a negative or non-integer PR number from the payload", () => {
      const eventPath = join(eventDir, "event.json");
      writeFileSync(
        eventPath,
        JSON.stringify({ pull_request: { number: -1, title: "x" } }),
      );
      process.env.GITHUB_ACTIONS = "true";
      process.env.GITHUB_EVENT_PATH = eventPath;
      expect(detectCI()?.prNumber).toBeNull();

      writeFileSync(
        eventPath,
        JSON.stringify({ pull_request: { number: 1.5, title: "x" } }),
      );
      expect(detectCI()?.prNumber).toBeNull();
    });

    it("clamps an oversized head sha / branch / repo to the dashboard caps", () => {
      const eventPath = join(eventDir, "event.json");
      writeFileSync(eventPath, JSON.stringify({ pull_request: { number: 7 } }));
      process.env.GITHUB_ACTIONS = "true";
      process.env.GITHUB_EVENT_PATH = eventPath;
      // No head sha in payload, so commitSha comes from GITHUB_SHA — make it huge.
      process.env.GITHUB_SHA = "a".repeat(5000);
      process.env.GITHUB_HEAD_REF = "b".repeat(5000);
      process.env.GITHUB_REPOSITORY = "c".repeat(5000);

      const info = detectCI();
      expect(info?.commitSha?.length).toBe(256); // MAX.SHORT
      expect(info?.branch?.length).toBe(1024); // MAX.NAME
      expect(info?.repo?.length).toBe(1024); // MAX.NAME
    });

    it("falls back to GITHUB_SHA when the event payload has no head sha", () => {
      const eventPath = join(eventDir, "event.json");
      writeFileSync(eventPath, JSON.stringify({ pull_request: { number: 7 } }));
      process.env.GITHUB_ACTIONS = "true";
      process.env.GITHUB_SHA = "mergesha456";
      process.env.GITHUB_EVENT_PATH = eventPath;

      expect(detectCI()?.commitSha).toBe("mergesha456");
    });

    it("uses GITHUB_SHA on push events (no event payload pull_request)", () => {
      const eventPath = join(eventDir, "event.json");
      writeFileSync(eventPath, JSON.stringify({ ref: "refs/heads/main" }));
      process.env.GITHUB_ACTIONS = "true";
      process.env.GITHUB_SHA = "pushsha789";
      process.env.GITHUB_EVENT_PATH = eventPath;

      expect(detectCI()?.commitSha).toBe("pushsha789");
    });

    it("returns null when the event payload has no pull_request (push event)", () => {
      const eventPath = join(eventDir, "event.json");
      writeFileSync(eventPath, JSON.stringify({ ref: "refs/heads/main" }));
      process.env.GITHUB_ACTIONS = "true";
      process.env.GITHUB_EVENT_PATH = eventPath;

      expect(detectCI()?.prNumber).toBeNull();
    });

    it("skips an oversized event file before parsing it (size guard)", () => {
      const eventPath = join(eventDir, "event.json");
      // Valid, parseable JSON padded past the 25 MiB cap. Without the guard the
      // head sha would be picked up; with it the file is skipped, so commitSha
      // falls back to GITHUB_SHA.
      const big = JSON.stringify({
        pull_request: {
          number: 7,
          title: "x",
          head: { sha: "a".repeat(40) },
        },
        padding: "z".repeat(25 * 1024 * 1024),
      });
      writeFileSync(eventPath, big);
      process.env.GITHUB_ACTIONS = "true";
      process.env.GITHUB_SHA = "0000000000000000000000000000000000000000";
      process.env.GITHUB_EVENT_PATH = eventPath;

      const info = detectCI();
      expect(info?.commitSha).toBe("0000000000000000000000000000000000000000");
      expect(info?.prNumber).toBeNull();
    });

    it("returns null (no throw) for a malformed or missing event file", () => {
      const eventPath = join(eventDir, "event.json");
      writeFileSync(eventPath, "not json{");
      process.env.GITHUB_ACTIONS = "true";
      process.env.GITHUB_EVENT_PATH = eventPath;
      expect(detectCI()?.prNumber).toBeNull();

      process.env.GITHUB_EVENT_PATH = join(eventDir, "does-not-exist.json");
      expect(detectCI()?.prNumber).toBeNull();
    });
  });

  it("detects GitLab CI with merge-request branch", () => {
    process.env.GITLAB_CI = "true";
    process.env.CI_PIPELINE_ID = "p1";
    process.env.CI_MERGE_REQUEST_SOURCE_BRANCH_NAME = "feat/mr";
    process.env.CI_COMMIT_BRANCH = "should-be-ignored";
    process.env.CI_COMMIT_SHA = "deadbeef";
    process.env.CI_COMMIT_MESSAGE = "inline message";
    process.env.CI_MERGE_REQUEST_IID = "9";
    process.env.CI_PROJECT_PATH = "acme/app";
    process.env.GITLAB_USER_LOGIN = "alice";

    expect(detectCI()).toEqual({
      ciProvider: "gitlab-ci",
      ciBuildId: "p1",
      ciJobName: null,
      branch: "feat/mr",
      commitSha: "deadbeef",
      commitMessage: "inline message",
      prNumber: 9,
      repo: "acme/app",
      actor: "alice",
    });
  });

  it("reads the GitLab job name from CI_JOB_NAME", () => {
    process.env.GITLAB_CI = "true";
    process.env.CI_JOB_NAME = "playwright 1/4";
    expect(detectCI()?.ciJobName).toBe("playwright 1/4");
  });

  it("returns null prNumber for a non-numeric CI_MERGE_REQUEST_IID (no NaN on the wire)", () => {
    process.env.GITLAB_CI = "true";
    process.env.CI_MERGE_REQUEST_IID = "abc";
    expect(detectCI()?.prNumber).toBeNull();
  });

  it("detects GitLab CI on a plain branch pipeline (no MR)", () => {
    process.env.GITLAB_CI = "true";
    process.env.CI_COMMIT_BRANCH = "main";
    const info = detectCI();
    expect(info?.branch).toBe("main");
    expect(info?.prNumber).toBeNull();
  });

  it("detects CircleCI with CIRCLE_PR_NUMBER", () => {
    process.env.CIRCLECI = "true";
    process.env.CIRCLE_WORKFLOW_ID = "wf1";
    process.env.CIRCLE_BRANCH = "feat/x";
    process.env.CIRCLE_SHA1 = "cafe";
    process.env.CIRCLE_PR_NUMBER = "5";
    process.env.CIRCLE_PROJECT_USERNAME = "acme";
    process.env.CIRCLE_PROJECT_REPONAME = "app";
    process.env.CIRCLE_USERNAME = "bob";

    expect(detectCI()).toMatchObject({
      ciProvider: "circleci",
      ciBuildId: "wf1",
      prNumber: 5,
      repo: "acme/app",
    });
  });

  it("ignores a negative CIRCLE_PR_NUMBER and falls back to the PR URL", () => {
    process.env.CIRCLECI = "true";
    process.env.CIRCLE_PR_NUMBER = "-5";
    process.env.CIRCLE_PULL_REQUEST = "https://github.com/acme/app/pull/42";
    expect(detectCI()?.prNumber).toBe(42);
  });

  it("parses CircleCI pull-request URL when CIRCLE_PR_NUMBER is absent", () => {
    process.env.CIRCLECI = "true";
    process.env.CIRCLE_PULL_REQUEST = "https://github.com/acme/app/pull/42";
    expect(detectCI()?.prNumber).toBe(42);
  });

  it("returns generic 'unknown' provider when only CI=true is set", () => {
    process.env.CI = "true";
    expect(detectCI()).toEqual({
      ciProvider: "unknown",
      ciBuildId: null,
      ciJobName: null,
      branch: null,
      commitSha: null,
      commitMessage: "stubbed commit message",
      prNumber: null,
      repo: null,
      actor: null,
    });
  });

  it("prefers GitHub Actions when both GITHUB_ACTIONS and CI are set", () => {
    process.env.CI = "true";
    process.env.GITHUB_ACTIONS = "true";
    expect(detectCI()?.ciProvider).toBe("github-actions");
  });
});

describe("generateIdempotencyKey", () => {
  let originalExplicitKey: string | undefined;

  beforeEach(() => {
    originalExplicitKey = process.env.WRIGHTFUL_IDEMPOTENCY_KEY;
    delete process.env.WRIGHTFUL_IDEMPOTENCY_KEY;
  });

  afterEach(() => {
    if (originalExplicitKey === undefined) {
      delete process.env.WRIGHTFUL_IDEMPOTENCY_KEY;
    } else {
      process.env.WRIGHTFUL_IDEMPOTENCY_KEY = originalExplicitKey;
    }
  });

  it("passes the ciBuildId through when provided", () => {
    expect(generateIdempotencyKey("build_42")).toBe("build_42");
  });

  it("appends the job name so distinct matrix/parallel jobs don't merge into one run", () => {
    expect(generateIdempotencyKey("42", { jobName: "e2e" })).toBe("42-e2e");
  });

  it("carries no discriminator beyond build id + job name (shards of one suite must share the key)", () => {
    // Playwright --shard is deliberately not part of the key: the dashboard
    // merges shards sharing one idempotencyKey into a single run by design.
    expect(generateIdempotencyKey("42", { jobName: "e2e" })).toBe("42-e2e");
    expect(generateIdempotencyKey("42")).toBe("42");
  });

  it("is deterministic for the same build/job (re-runs recover the run)", () => {
    const make = () => generateIdempotencyKey("42", { jobName: "e2e" });
    expect(make()).toBe(make());
  });

  it("uses an explicit WRIGHTFUL_IDEMPOTENCY_KEY verbatim, ignoring discriminators", () => {
    // Synthetic monitors pass the exact execution id — it must never be
    // decorated with discriminator suffixes.
    process.env.WRIGHTFUL_IDEMPOTENCY_KEY = "01EXEC0000000000000000000";
    expect(generateIdempotencyKey("42", { jobName: "e2e" })).toBe(
      "01EXEC0000000000000000000",
    );
  });

  it("caps the derived key at the dashboard's 1024-char schema limit", () => {
    const key = generateIdempotencyKey("b".repeat(2000), { jobName: "j" });
    expect(key.length).toBeLessThanOrEqual(1024);
  });

  it("falls back to a v4 UUID when ciBuildId is null", () => {
    const key = generateIdempotencyKey(null);
    expect(key).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it("falls back to a UUID when ciBuildId is undefined", () => {
    const key = generateIdempotencyKey(undefined);
    expect(key).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it("falls back to a UUID when ciBuildId is empty string", () => {
    const key = generateIdempotencyKey("");
    expect(key).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });
});
