import { describe, expect, it } from "vite-plus/test";
import {
  isApiPath,
  isErrorPage,
  looksLikeStaticAsset,
  mapErrorOutcome,
  NOT_FOUND_PATH,
  OOPS_PATH,
  shouldLogApiFailure,
} from "@/lib/error-outcome";

describe("isApiPath", () => {
  it("matches /api/ prefixed paths", () => {
    expect(isApiPath("/api/runs")).toBe(true);
    expect(isApiPath("/api/t/acme/p/web/runs/r1/summary")).toBe(true);
  });

  it("does not match HTML routes or bare /api", () => {
    expect(isApiPath("/t/acme/p/web")).toBe(false);
    expect(isApiPath("/login")).toBe(false);
    expect(isApiPath("/api")).toBe(false);
    expect(isApiPath("/apidocs")).toBe(false);
  });
});

describe("isErrorPage", () => {
  it("identifies the loop-guarded error pages exactly", () => {
    expect(isErrorPage(OOPS_PATH)).toBe(true);
    expect(isErrorPage(NOT_FOUND_PATH)).toBe(true);
    expect(isErrorPage("/oopsie")).toBe(false);
    expect(isErrorPage("/not-found/extra")).toBe(false);
    expect(isErrorPage("/")).toBe(false);
  });
});

describe("looksLikeStaticAsset", () => {
  it("treats a dotted final segment as a dev/static asset", () => {
    expect(looksLikeStaticAsset("/pages/t/layout.tsx")).toBe(true);
    expect(looksLikeStaticAsset("/assets/app.css")).toBe(true);
    expect(looksLikeStaticAsset("/favicon.ico")).toBe(true);
  });

  it("does not match route paths without a dotted final segment", () => {
    expect(looksLikeStaticAsset("/t/acme/p/web")).toBe(false);
    expect(looksLikeStaticAsset("/t/acme.co/p/web")).toBe(false);
    expect(looksLikeStaticAsset("/")).toBe(false);
  });
});

describe("mapErrorOutcome", () => {
  it("maps 401 to a login redirect", () => {
    expect(mapErrorOutcome(401)).toEqual({ kind: "redirect-login" });
  });

  it("maps 404 to a status-preserving not-found rewrite", () => {
    expect(mapErrorOutcome(404)).toEqual({ kind: "rewrite-404", status: 404 });
  });

  it("maps 5xx to log-and-oops preserving the original status", () => {
    expect(mapErrorOutcome(500)).toEqual({ kind: "log-and-oops", status: 500 });
    expect(mapErrorOutcome(503)).toEqual({ kind: "log-and-oops", status: 503 });
  });

  it("maps an unknown/raw throw (null status) to log-and-oops defaulting to 500", () => {
    expect(mapErrorOutcome(null)).toEqual({
      kind: "log-and-oops",
      status: 500,
    });
  });

  it("passes successful 2xx responses through untouched", () => {
    // A normal page render reaches the post-next() arm as a 200. It must NOT be
    // rewritten to /oops — that would turn every working page into the error
    // page. (This is the regression the dev server surfaced.)
    expect(mapErrorOutcome(200)).toEqual({ kind: "pass" });
    expect(mapErrorOutcome(204)).toEqual({ kind: "pass" });
  });

  it("passes 3xx redirects through untouched", () => {
    // The logged-out `/` → /login redirect is a thrown 302 Response; folding it
    // into log-and-oops breaks the entire auth-redirect flow.
    expect(mapErrorOutcome(302)).toEqual({ kind: "pass" });
    expect(mapErrorOutcome(307)).toEqual({ kind: "pass" });
  });

  it("passes intentional non-401/404 4xx control-flow through untouched", () => {
    // 403/400/409 are deliberate handler responses, not pipeline failures, and
    // must not be logged as errors or rewritten to /oops.
    expect(mapErrorOutcome(403)).toEqual({ kind: "pass" });
    expect(mapErrorOutcome(400)).toEqual({ kind: "pass" });
    expect(mapErrorOutcome(409)).toEqual({ kind: "pass" });
  });
});

describe("shouldLogApiFailure", () => {
  it("logs raw throws (null status) and 5xx", () => {
    expect(shouldLogApiFailure(null)).toBe(true);
    expect(shouldLogApiFailure(500)).toBe(true);
    expect(shouldLogApiFailure(502)).toBe(true);
  });

  it("stays quiet for intentional 4xx control-flow responses", () => {
    expect(shouldLogApiFailure(400)).toBe(false);
    expect(shouldLogApiFailure(401)).toBe(false);
    expect(shouldLogApiFailure(404)).toBe(false);
    expect(shouldLogApiFailure(409)).toBe(false);
  });
});
