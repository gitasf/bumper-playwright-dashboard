"use client";

import type React from "react";
import { useMemo, useState } from "react";
import { formatBytes, formatPreviewText } from "../format";
import { isImageMime, isTextMime } from "../mime";
import { sha1Path } from "../model";
import { useBridgeText } from "../use-bridge-fetch";
import { useObjectUrl } from "../use-object-url";
import type { TraceBridge } from "../use-trace-model";

/**
 * Above this body size we don't fetch-and-render as text — a large binary body
 * mustn't be pulled through `.text()`. (The rendered length is separately
 * capped in `formatPreviewText`.)
 */
const TEXT_PREVIEW_MAX_BYTES = 200_000;

const NOTE = "text-caption text-fg-4";

/** The styled `<pre>` a rendered text preview always renders through — one
 * canonical wrap/scroll treatment for the Network response-body panel and the
 * Attachments row preview instead of two independently drifting className
 * strings. */
const PREVIEW_PRE_CLASSES =
  "max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-caption";

export function PreviewPre({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  return <pre className={PREVIEW_PRE_CLASSES}>{children}</pre>;
}

/**
 * The "sha1 → fetched, pretty-printed text" pipeline: bridge-fetch a trace
 * resource by hash and run it through {@link formatPreviewText}. Shared by
 * `BridgeBodyPreview`'s text arm and the Attachments row's expanded preview
 * (whose base64-inline case decodes locally instead — there's nothing to
 * fetch). Pass `sha1: null` to skip fetching (e.g. while a row is collapsed).
 */
export function useSha1PreviewText(
  bridge: TraceBridge,
  sha1: string | null,
  mimeType: string,
): { text: string | undefined; error: Error | undefined } {
  const { text, error } = useBridgeText(
    bridge,
    sha1 ? sha1Path(bridge.traceUrl, sha1) : null,
  );
  const formatted = useMemo(
    () => (text !== undefined ? formatPreviewText(text, mimeType) : undefined),
    [text, mimeType],
  );
  return { text: formatted, error };
}

/**
 * A sha1-backed response/attachment body preview, resolved through the bridge:
 * images render via an object URL, small text-like bodies are fetched and
 * pretty-printed, everything else shows a size note. One implementation for the
 * "sha1 → rendered bytes" seam the Network and Attachments tabs both need.
 */
export function BridgeBodyPreview({
  sha1,
  mimeType,
  size,
  bridge,
}: {
  /** The body's trace resource hash — the caller only renders this when present. */
  sha1: string;
  mimeType: string;
  size: number;
  bridge: TraceBridge;
}): React.ReactElement {
  const path = sha1Path(bridge.traceUrl, sha1);
  const image = isImageMime(mimeType);
  // Mime-based only — whether a body even *could* render as text. Whether we
  // actually fetch it also depends on its size: a small binary body must not
  // be pulled through `.text()`.
  const canPreviewText =
    !image && isTextMime(mimeType) && size <= TEXT_PREVIEW_MAX_BYTES;

  const { url: imageUrl, error: imageError } = useObjectUrl(
    bridge,
    image ? path : null,
  );
  const { text, error } = useSha1PreviewText(
    bridge,
    canPreviewText ? sha1 : null,
    mimeType,
  );
  const [failedImageUrl, setFailedImageUrl] = useState<string | null>(null);

  if (image) {
    if (imageError || (imageUrl !== null && failedImageUrl === imageUrl)) {
      return <div className={NOTE}>Failed to load preview.</div>;
    }
    return imageUrl ? (
      <img
        src={imageUrl}
        alt="Response body preview"
        className="max-h-48 rounded border border-line-1 object-contain"
        onError={() => setFailedImageUrl(imageUrl)}
      />
    ) : (
      <div className={NOTE}>Loading preview…</div>
    );
  }

  if (!canPreviewText) {
    return (
      <div className={NOTE}>Preview not available · {formatBytes(size)}</div>
    );
  }
  if (error) return <div className={NOTE}>Failed to load preview.</div>;
  if (text === undefined) return <div className={NOTE}>Loading preview…</div>;

  return <PreviewPre>{text}</PreviewPre>;
}
