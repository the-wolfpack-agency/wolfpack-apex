/**
 * image-compress: shrink an attached image in the browser BEFORE it is
 * read into the chat payload.
 *
 * Why this exists: the assistant composer caps an attachment at
 * MAX_ATTACH_BYTES (see InstinctChat). A real screenshot is routinely
 * 1 to 3 MB, so every screenshot was rejected with "exceeds the limit"
 * and the user could not submit it. We cannot simply raise the cap:
 * the file is inlined as base64 into the POST /api/assistant body, and
 * base64 is about 33% larger than the bytes, so a multi-MB image would
 * blow past the serverless request-body limit and 413 at the edge.
 *
 * The fix is to downscale + re-encode the image client-side to fit
 * under the cap, which both lets the screenshot through AND keeps the
 * request body small. Text, PDF, code, and vector/icon files are never
 * touched.
 *
 * Everything here degrades safely: if the runtime has no canvas (SSR,
 * jsdom in tests, a locked-down browser), compressImageFile returns the
 * ORIGINAL file unchanged and the caller's size check still applies, so
 * behavior is never worse than before this module existed.
 */

/** Longest edge (px) we scale an attached image down to. 1600 keeps a
 *  screenshot readable while cutting most of the bytes. */
export const IMAGE_ATTACH_MAX_DIMENSION = 1600;

/** JPEG quality steps tried in order until the result fits the cap. */
const QUALITY_STEPS = [0.85, 0.7, 0.55, 0.4];

/**
 * Images we will rasterize + re-encode. We deliberately EXCLUDE:
 *   - svg: vector; rasterizing loses scalability and our markup-safe
 *     handling, and an inline <svg> can carry script.
 *   - ico: tiny multi-resolution icons; never the oversize culprit and
 *     canvas mangles the frames.
 */
export function isCompressibleImage(type: string | undefined | null): boolean {
  if (!type) return false;
  if (!type.startsWith("image/")) return false;
  if (type === "image/svg+xml") return false;
  if (type === "image/x-icon" || type === "image/vnd.microsoft.icon") {
    return false;
  }
  return true;
}

/** Pure decision helper (unit-testable without a DOM): should we attempt
 *  to compress this file before attaching it? */
export function needsImageCompression(
  file: { type?: string | null; size: number },
  maxBytes: number,
): boolean {
  return isCompressibleImage(file.type) && file.size > maxBytes;
}

/** Human-readable byte size for user-facing messages. No decimals under
 *  1 MB so "512 KB" reads cleanly; one decimal above. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(1)} MB`;
}

/** Swap any extension for .jpg so the attachment chip + server see the
 *  re-encoded type honestly. Keeps the base name. */
export function toJpegName(name: string): string {
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  return `${base}.jpg`;
}

/** Scale (w, h) so the longest edge is at most maxDimension, never
 *  upscaling. Returned values are rounded to whole pixels. */
export function scaledDimensions(
  w: number,
  h: number,
  maxDimension: number,
): { width: number; height: number } {
  const longest = Math.max(w, h);
  if (longest <= maxDimension || longest === 0) {
    return { width: Math.round(w), height: Math.round(h) };
  }
  const ratio = maxDimension / longest;
  return { width: Math.round(w * ratio), height: Math.round(h * ratio) };
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality: number,
): Promise<Blob | null> {
  return new Promise((resolve) => {
    try {
      canvas.toBlob((b) => resolve(b), type, quality);
    } catch {
      resolve(null);
    }
  });
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image decode failed"));
    img.src = url;
  });
}

export interface CompressOptions {
  /** Target ceiling in bytes. We stop at the first quality step at or
   *  under this; if none fit we return the smallest we produced. */
  maxBytes: number;
  /** Longest-edge cap. Defaults to IMAGE_ATTACH_MAX_DIMENSION. */
  maxDimension?: number;
}

/**
 * Downscale + re-encode an image File to fit under opts.maxBytes.
 *
 * Returns a NEW File (image/jpeg, .jpg name) on success. Returns the
 * ORIGINAL file untouched when:
 *   - the type is not a compressible image,
 *   - there is no canvas in this runtime (SSR / jsdom / no 2d context),
 *   - decoding or encoding fails for any reason.
 *
 * Never throws. The caller always re-checks the returned file's size,
 * so a best-effort-but-still-too-big result is handled by the caller's
 * existing limit path rather than silently attaching an oversize file.
 */
export async function compressImageFile(
  file: File,
  opts: CompressOptions,
): Promise<File> {
  if (!isCompressibleImage(file.type)) return file;
  const maxDimension = opts.maxDimension ?? IMAGE_ATTACH_MAX_DIMENSION;

  // Guard the whole DOM path up front so non-browser runtimes (and the
  // jsdom test env, which has no real canvas) bail BEFORE we touch an
  // <img> whose onload would never fire, which avoids a hung promise.
  if (typeof document === "undefined" || typeof URL === "undefined") {
    return file;
  }
  let canvas: HTMLCanvasElement;
  try {
    canvas = document.createElement("canvas");
  } catch {
    return file;
  }
  if (typeof canvas.toBlob !== "function") return file;
  const ctx = canvas.getContext("2d");
  if (!ctx) return file;

  let objectUrl: string | null = null;
  try {
    objectUrl = URL.createObjectURL(file);
    const img = await loadImage(objectUrl);
    const { width, height } = scaledDimensions(
      img.naturalWidth || img.width,
      img.naturalHeight || img.height,
      maxDimension,
    );
    if (width === 0 || height === 0) return file;
    canvas.width = width;
    canvas.height = height;
    ctx.drawImage(img, 0, 0, width, height);

    let smallest: Blob | null = null;
    for (const q of QUALITY_STEPS) {
      const blob = await canvasToBlob(canvas, "image/jpeg", q);
      if (!blob) continue;
      if (!smallest || blob.size < smallest.size) smallest = blob;
      if (blob.size <= opts.maxBytes) {
        return new File([blob], toJpegName(file.name), { type: "image/jpeg" });
      }
    }
    // Nothing hit the ceiling. Hand back the smallest re-encode only if
    // it actually beats the original; otherwise keep the original so the
    // caller's limit check reports the true source size.
    if (smallest && smallest.size < file.size) {
      return new File([smallest], toJpegName(file.name), {
        type: "image/jpeg",
      });
    }
    return file;
  } catch {
    return file;
  } finally {
    if (objectUrl && typeof URL.revokeObjectURL === "function") {
      URL.revokeObjectURL(objectUrl);
    }
  }
}
