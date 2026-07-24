/**
 * One home for the "what can we preview this content-type as" question that was
 * otherwise answered by several hand-rolled (and subtly disagreeing) `includes`
 * ladders across the Network and Attachments tabs.
 */

/** A content-type with its parameters stripped: `"text/html; charset=utf-8"` → `"text/html"`. */
export function baseMimeType(contentType: string): string {
  return contentType.split(";")[0]?.trim() ?? "";
}

/** Whether a content-type renders as an image (`<img>`-able). */
export function isImageMime(contentType: string): boolean {
  return baseMimeType(contentType).startsWith("image/");
}

/** Whether a content-type renders as a video (`<video>`-able). */
export function isVideoMime(contentType: string): boolean {
  return baseMimeType(contentType).startsWith("video/");
}

/**
 * Whether a content-type is previewable as text — plain text, JSON, and the
 * common web source types (JS/CSS/HTML/XML). The single definition the Network
 * response-body preview and the Attachments row preview both consume.
 */
export function isTextMime(contentType: string): boolean {
  const mime = baseMimeType(contentType);
  return (
    mime.startsWith("text/") ||
    mime.includes("json") ||
    mime.includes("javascript") ||
    mime.includes("ecmascript") ||
    mime.includes("css") ||
    mime.includes("html") ||
    mime.includes("xml")
  );
}
