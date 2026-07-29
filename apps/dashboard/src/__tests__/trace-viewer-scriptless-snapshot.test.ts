import { describe, expect, it } from "vite-plus/test";
import {
  prepareScriptlessSnapshot,
  SNAPSHOT_VISIBILITY_GUARD_CSS,
} from "@/trace-viewer/components/scriptless-snapshot";

/**
 * `prepareScriptlessSnapshot` — the script-less arm of the snapshot pane.
 * Same-origin snapshot iframes drop `allow-scripts`, so Playwright's inline
 * bootstrap never runs: it neither disables the visibility guard every snapshot
 * is rendered behind (pane shows a blank white frame) nor suppresses clicks on
 * the captured page's links (which still point at their original live URLs).
 * This covers both fixups, that nothing else in the document is touched, and
 * that a hostile snapshot cannot make either one throw.
 */

const GUARD = `<style>${SNAPSHOT_VISIBILITY_GUARD_CSS}</style>`;

/**
 * A snapshot document in the shape a browser has finished parsing it into.
 *
 * Playwright emits the guard `<style>` and the bootstrap `<script>` BEFORE
 * `<html>`, and the HTML parser relocates them to the front of `<head>` —
 * that relocation is what makes the guard `querySelector("style")`'s first hit
 * (confirmed against Chromium: `head.children` is `[STYLE, SCRIPT, …]`).
 * happy-dom's parser does not model it, dropping such nodes into `<body>`
 * instead, so fixtures here encode the post-parse shape directly and the
 * parser step itself is covered by the browser-level replay assertion in
 * `packages/e2e/tests-dashboard/test-replay.spec.ts`.
 */
function snapshotDoc(head: string, body = "<p>captured</p>"): Document {
  const doc = document.implementation.createHTMLDocument("snapshot");
  doc.head.innerHTML = head;
  doc.body.innerHTML = body;
  return doc;
}

/** Minimal stand-in for a same-origin iframe's WindowProxy. */
function windowFor(doc: Document): Window {
  return { document: doc, Document, EventTarget } as unknown as Window;
}

/** Dispatch a cancelable click the way a real user click would arrive. */
function clickOn(element: Element): boolean {
  const event = new MouseEvent("click", { bubbles: true, cancelable: true });
  element.dispatchEvent(event);
  return event.defaultPrevented;
}

describe("prepareScriptlessSnapshot", () => {
  it("removes the guard stylesheet so the static DOM becomes visible", () => {
    const doc = snapshotDoc(`${GUARD}<style>p { color: red }</style>`);

    prepareScriptlessSnapshot(windowFor(doc));

    const styles = Array.from(doc.querySelectorAll("style"));
    expect(styles).toHaveLength(1);
    expect(styles[0]?.textContent).toBe("p { color: red }");
    expect(doc.body.innerHTML).toBe("<p>captured</p>");
  });

  it("suppresses link navigation the blocked bootstrap would have suppressed", () => {
    const doc = snapshotDoc(GUARD, `<a href="https://example.test/">go</a>`);
    const link = doc.querySelector("a");

    // Without the fixup the revealed link is live: one click replaces the
    // replay with a real page load inside the pane, unrecoverably.
    expect(link && clickOn(link)).toBe(false);

    prepareScriptlessSnapshot(windowFor(doc));

    expect(link && clickOn(link)).toBe(true);
  });

  it("is idempotent across repeated loads of the same document", () => {
    const doc = snapshotDoc(GUARD, `<a href="https://example.test/">go</a>`);

    prepareScriptlessSnapshot(windowFor(doc));
    prepareScriptlessSnapshot(windowFor(doc));

    expect(doc.querySelectorAll("style")).toHaveLength(0);
    const link = doc.querySelector("a");
    expect(link && clickOn(link)).toBe(true);
  });

  it("leaves a document whose first style is not the guard untouched", () => {
    // Belt-and-braces against a future renderer that emits its own CSS first:
    // only Playwright's exact guard is ever removed.
    const doc = snapshotDoc(`<style>p { color: red }</style>${GUARD}`);

    prepareScriptlessSnapshot(windowFor(doc));

    expect(doc.querySelectorAll("style")).toHaveLength(2);
  });

  it("does nothing when the snapshot has no stylesheet at all", () => {
    const doc = snapshotDoc("");

    expect(() => prepareScriptlessSnapshot(windowFor(doc))).not.toThrow();
    expect(doc.body.innerHTML).toBe("<p>captured</p>");
  });

  it("still lifts the guard when the snapshot clobbers the DOM methods it uses", () => {
    // Trace bytes are attacker-craftable and `Document` has
    // [LegacyOverrideBuiltIns], so an `<img name="querySelector">` in the
    // captured page shadows the real method: a naive `doc.querySelector(...)`
    // throws, the guard is never lifted, and that project's replays stay blank.
    const doc = snapshotDoc(GUARD, `<img name="querySelector">`);
    const decoy = doc.querySelector("img");
    // happy-dom does not implement Document's named-property getter, so apply
    // the shadowing by hand — the point is that the fixup routes around
    // whatever the document itself exposes under these names.
    for (const name of ["querySelector", "addEventListener"]) {
      Object.defineProperty(doc, name, { configurable: true, value: decoy });
    }

    expect(() => prepareScriptlessSnapshot(windowFor(doc))).not.toThrow();
    expect(doc.querySelectorAll("style")).toHaveLength(0);
  });

  it("is inert when the frame has navigated cross-origin", () => {
    // A snapshot that navigated itself makes `win.document` throw SecurityError
    // on the next load event. The caller runs inside an iframe `onLoad` whose
    // remaining bookkeeping must not be skipped, so this can never escape.
    const win = {
      get document(): Document {
        throw new Error("SecurityError: cross-origin frame");
      },
    } as unknown as Window;

    expect(() => prepareScriptlessSnapshot(win)).not.toThrow();
  });
});
