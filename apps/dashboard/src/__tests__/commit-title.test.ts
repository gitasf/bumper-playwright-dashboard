import { describe, expect, it } from "vitest";
import { commitTitle } from "@/lib/text";

// GitHub's "Update branch" button pushes this onto the PR head, so the reporter
// captured it as the run's commit message. `packages/reporter/src/ci.ts` now
// prefers the PR title at capture time; rows written before that keep the
// generated string, so the dashboard has to render it readably.
const GENERATED_MERGE =
  "Merge cc43127cdd579151635f1dd287882da6b28cd24d into 848b9f3ed98160960c5a7010b5c09326776c493f";

describe("commitTitle", () => {
  it("abbreviates the object names in a generated merge message", () => {
    expect(commitTitle(GENERATED_MERGE)).toEqual({
      text: "Merge cc43127 into 848b9f3",
      generated: true,
    });
  });

  it("tolerates surrounding whitespace on a generated merge message", () => {
    expect(commitTitle(`\n  ${GENERATED_MERGE}  \n`)?.generated).toBe(true);
  });

  it("keeps an authored subject verbatim", () => {
    expect(commitTitle("fix: redirect after status change")).toEqual({
      text: "fix: redirect after status change",
      generated: false,
    });
  });

  it("reduces a multi-line message to its subject", () => {
    expect(commitTitle("feat: add login form\n\nWith a body.")).toEqual({
      text: "feat: add login form",
      generated: false,
    });
  });

  // The `$` anchor carries this: a body means someone wrote something, so the
  // message is theirs and keeps headline billing.
  it("treats a merge with a hand-written body as authored", () => {
    expect(
      commitTitle(`${GENERATED_MERGE}\n\nTook both sides of styles.css.`),
    ).toEqual({
      text: GENERATED_MERGE,
      generated: false,
    });
  });

  it("treats a merge that names branches as authored", () => {
    expect(commitTitle("Merge branch 'main' into fix/status-redirect")).toEqual(
      {
        text: "Merge branch 'main' into fix/status-redirect",
        generated: false,
      },
    );
  });

  it("treats a squash-merge subject as authored", () => {
    expect(
      commitTitle("Merge pull request #5082 from gitasf/release-sup")
        ?.generated,
    ).toBe(false);
  });

  it("returns null for a missing or blank message", () => {
    expect(commitTitle(null)).toBeNull();
    expect(commitTitle("")).toBeNull();
    expect(commitTitle("   \n  ")).toBeNull();
  });
});
