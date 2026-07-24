import { describe, expect, it } from "vite-plus/test";
import type {
  VisualDiffFrame,
  VisualDiffGroup,
} from "@/components/artifact-actions";
import { availableModes } from "@/components/visual-diff-dialog";

const frame = (name: string): VisualDiffFrame => ({
  href: `/artifacts/${name}.png`,
  name,
});

const group = (
  parts: Partial<Pick<VisualDiffGroup, "expected" | "actual" | "diff">>,
): VisualDiffGroup => ({
  snapshotName: "hero",
  expected: parts.expected ?? null,
  actual: parts.actual ?? null,
  diff: parts.diff ?? null,
});

describe("availableModes", () => {
  it("offers every single-image mode only for the frames that exist", () => {
    expect(availableModes(group({ expected: frame("e") }))).toEqual([
      "expected",
    ]);
    expect(availableModes(group({ diff: frame("d") }))).toEqual(["diff"]);
  });

  it("offers the comparison modes only when BOTH expected and actual exist", () => {
    // Only one side → no slider / side-by-side.
    expect(availableModes(group({ expected: frame("e") }))).not.toContain(
      "slider",
    );
    expect(availableModes(group({ actual: frame("a") }))).not.toContain(
      "side-by-side",
    );
    // Both sides → both comparison modes light up.
    const both = availableModes(
      group({ expected: frame("e"), actual: frame("a") }),
    );
    expect(both).toContain("slider");
    expect(both).toContain("side-by-side");
  });

  it("returns the full ordered mode list for a complete triple", () => {
    const modes = availableModes(
      group({ expected: frame("e"), actual: frame("a"), diff: frame("d") }),
    );
    expect(modes).toEqual([
      "diff",
      "expected",
      "actual",
      "slider",
      "side-by-side",
    ]);
  });

  it("returns no modes for an empty group", () => {
    expect(availableModes(group({}))).toEqual([]);
  });
});
