"use client";

/**
 * Realm-safe DOM access for snapshot documents.
 *
 * A DOM snapshot is reconstructed from attacker-craftable trace bytes (any
 * project ingest-key holder can upload an arbitrary trace), and `Document` has
 * `[LegacyOverrideBuiltIns]`: a named element in the captured page shadows the
 * real interface member. Playwright's serializer strips `<script>` and `on*`
 * attributes but leaves `name` alone, so `<img name="querySelectorAll">`
 * survives into the rendered snapshot and the obvious `doc.querySelectorAll(…)`
 * throws. Measured in Chromium: `querySelector`, `querySelectorAll`,
 * `addEventListener` and `documentElement` all clobber this way (the last
 * silently yields an attacker-chosen element instead of throwing).
 *
 * The frame's own `Window` interface objects — `win.Document`,
 * `win.EventTarget` — do not, because a global's own properties win over its
 * named-property object. So resolve the methods through those prototypes once
 * and call them on the document. Everything the parent frame does to a snapshot
 * goes through here, so the reasoning lives in one place.
 */

type SnapshotRealm = Window & {
  readonly Document: typeof Document;
  readonly EventTarget: typeof EventTarget;
};

/** Realm-safe handle on one snapshot frame's document. */
export type SnapshotDom = {
  readonly document: Document;
  query<E extends Element = Element>(selectors: string): E | null;
  /** All matches, as a snapshot array (safe to mutate the DOM while iterating). */
  queryAll<E extends Element = Element>(selectors: string): E[];
  /** The document element, reached via `:root` rather than the clobberable getter. */
  documentElement(): Element | null;
  listen(
    target: EventTarget,
    type: string,
    listener: EventListener,
    capture?: boolean,
  ): void;
};

/**
 * Open a realm-safe handle on `win`'s document, or `null` when the frame is
 * unreachable: cross-origin (a snapshot that navigated itself makes
 * `win.document` throw `SecurityError` on the next `load`) or torn down
 * mid-access. One guarded entry point, so callers stop guarding each access.
 */
export function snapshotDom(win: Window): SnapshotDom | null {
  try {
    const realm = win as SnapshotRealm;
    const document = realm.document;
    const docProto = realm.Document.prototype;
    const eventTargetProto = realm.EventTarget.prototype;
    return {
      document,
      query: <E extends Element>(selectors: string) =>
        docProto.querySelector.call(document, selectors) as E | null,
      queryAll: <E extends Element>(selectors: string) =>
        Array.from(docProto.querySelectorAll.call(document, selectors)) as E[],
      documentElement: () => docProto.querySelector.call(document, ":root"),
      listen: (target, type, listener, capture = false) => {
        eventTargetProto.addEventListener.call(target, type, listener, capture);
      },
    };
  } catch {
    return null;
  }
}
