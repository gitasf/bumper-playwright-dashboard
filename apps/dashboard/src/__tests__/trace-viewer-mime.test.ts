import { describe, expect, it } from "vite-plus/test";
import {
  baseMimeType,
  isImageMime,
  isTextMime,
  isVideoMime,
} from "@/trace-viewer/mime";

/**
 * Characterization tests for the trace-viewer's content-type classifiers —
 * the single home mime.ts consolidates for the Network and Attachments tabs.
 * Pinned directly against the current implementation; sibling to
 * trace-viewer-network-columns.test.ts. Styled after trace-viewer-format.test.ts.
 */

describe("baseMimeType", () => {
  it("strips a trailing parameter", () => {
    expect(baseMimeType("text/html; charset=utf-8")).toBe("text/html");
  });

  it("trims surrounding whitespace", () => {
    expect(baseMimeType("  text/plain  ")).toBe("text/plain");
  });

  it("returns the input unchanged when there is no parameter", () => {
    expect(baseMimeType("application/json")).toBe("application/json");
  });

  it("does not lowercase the mime type — casing passes through verbatim", () => {
    expect(baseMimeType("APPLICATION/JSON; charset=UTF-8")).toBe(
      "APPLICATION/JSON",
    );
  });

  it("returns an empty string for an empty input", () => {
    expect(baseMimeType("")).toBe("");
  });
});

describe("isImageMime", () => {
  it("is true for an image/* mime type", () => {
    expect(isImageMime("image/png")).toBe(true);
  });

  it("strips parameters before matching", () => {
    expect(isImageMime("image/svg+xml; charset=utf-8")).toBe(true);
  });

  it("is false for a non-image mime type", () => {
    expect(isImageMime("text/plain")).toBe(false);
  });

  it("is case-sensitive: an uppercase IMAGE/ prefix does not match", () => {
    expect(isImageMime("IMAGE/PNG")).toBe(false);
  });
});

describe("isVideoMime", () => {
  it("is true for a video/* mime type", () => {
    expect(isVideoMime("video/mp4")).toBe(true);
  });

  it("strips parameters before matching", () => {
    expect(isVideoMime("video/webm; codecs=vp9")).toBe(true);
  });

  it("is false for a non-video mime type", () => {
    expect(isVideoMime("audio/mpeg")).toBe(false);
  });

  it("is case-sensitive: an uppercase VIDEO/ prefix does not match", () => {
    expect(isVideoMime("VIDEO/MP4")).toBe(false);
  });
});

describe("isTextMime", () => {
  it("is true for any text/* mime type", () => {
    expect(isTextMime("text/plain")).toBe(true);
    expect(isTextMime("text/css")).toBe(true);
  });

  it("is true for json mime types", () => {
    expect(isTextMime("application/json")).toBe(true);
    expect(isTextMime("application/ld+json")).toBe(true);
  });

  it("is true for javascript/ecmascript mime types", () => {
    expect(isTextMime("application/javascript")).toBe(true);
    expect(isTextMime("application/ecmascript")).toBe(true);
    expect(isTextMime("text/javascript")).toBe(true);
  });

  it("is true for css mime types beyond text/css (substring match)", () => {
    expect(isTextMime("application/vnd.custom-css")).toBe(true);
  });

  it("is true for html mime types", () => {
    expect(isTextMime("application/xhtml+html")).toBe(true);
  });

  it("is true for xml mime types, including svg+xml", () => {
    expect(isTextMime("application/xml")).toBe(true);
    // image/svg+xml is simultaneously image-ish (isImageMime) and text-ish
    // here — both predicates are independent `includes`/`startsWith` checks
    // with no mutual exclusivity.
    expect(isTextMime("image/svg+xml")).toBe(true);
  });

  it("strips parameters before matching", () => {
    expect(isTextMime("text/html; charset=utf-8")).toBe(true);
  });

  it("is false for a binary mime type matching none of the substrings", () => {
    expect(isTextMime("application/octet-stream")).toBe(false);
    expect(isTextMime("font/woff2")).toBe(false);
    expect(isTextMime("image/png")).toBe(false);
  });

  it("is case-sensitive: an uppercase TEXT/HTML does not match text/ or html", () => {
    expect(isTextMime("TEXT/HTML")).toBe(false);
  });
});
