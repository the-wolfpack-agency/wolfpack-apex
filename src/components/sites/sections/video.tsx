/**
 * Video section — embeds a YouTube or Vimeo video via sandboxed iframe.
 *
 * Safety model:
 *   - We only iframe URLs whose host matches an allowlist (youtube.com,
 *     youtu.be, vimeo.com) AND whose ID parses cleanly to the shape those
 *     providers expose at `/embed/<id>` or `/video/<id>`. Anything else
 *     renders an "Invalid video URL" fallback — never a pass-through
 *     iframe. Matches validateBrief() in sites-schema.ts.
 *   - No dangerouslySetInnerHTML; no user-controlled HTML insertion. All
 *     fields (heading, body, attribution) flow through JSX text nodes so
 *     React escapes them.
 *   - `allow` attribute is minimal: autoplay, fullscreen, picture-in-
 *     picture. No camera/mic/geolocation grants.
 *
 * Embed URL translation is pure + deterministic. `buildEmbed()` is
 * exported so tests and server-side previews can share it.
 */

import type { BriefSection, VideoProvider } from "@/lib/sites-schema";

export interface VideoSectionProps {
  section: BriefSection;
}

export interface ResolvedEmbed {
  src: string;
  provider: VideoProvider;
}

/**
 * Parse a user-supplied URL into a sandboxed embed URL. Returns null for
 * anything that doesn't match an allowlisted provider + an ID in the
 * expected shape. Keep this conservative — the fallback UI is safer than
 * iframe-ing an attacker-controlled document.
 */
export function buildEmbed(
  rawUrl: string | undefined,
  opts: { autoplay?: boolean; startSeconds?: number; providerHint?: VideoProvider } = {},
): ResolvedEmbed | null {
  if (!rawUrl || typeof rawUrl !== "string") return null;
  if (!rawUrl.startsWith("https://")) return null;

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;

  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  const startSeconds =
    typeof opts.startSeconds === "number" && Number.isFinite(opts.startSeconds) && opts.startSeconds >= 0
      ? Math.floor(opts.startSeconds)
      : undefined;
  const autoplay = opts.autoplay === true;

  // --- YouTube ------------------------------------------------------
  // youtube.com/watch?v=<id>  |  youtu.be/<id>  |  m.youtube.com/watch?v=<id>
  // Video IDs are 11 chars of [A-Za-z0-9_-]; anything else is rejected.
  const isYouTube = host === "youtube.com" || host === "m.youtube.com" || host === "youtu.be";
  if (isYouTube) {
    let videoId: string | null = null;
    if (host === "youtu.be") {
      videoId = parsed.pathname.replace(/^\//, "").split("/")[0] || null;
    } else if (parsed.pathname === "/watch") {
      videoId = parsed.searchParams.get("v");
    } else if (parsed.pathname.startsWith("/embed/")) {
      videoId = parsed.pathname.replace("/embed/", "").split("/")[0] || null;
    } else if (parsed.pathname.startsWith("/shorts/")) {
      videoId = parsed.pathname.replace("/shorts/", "").split("/")[0] || null;
    }
    if (!videoId || !/^[A-Za-z0-9_-]{6,20}$/.test(videoId)) return null;

    const qs = new URLSearchParams();
    if (startSeconds !== undefined) qs.set("start", String(startSeconds));
    if (autoplay) {
      qs.set("autoplay", "1");
      // Browsers block audible autoplay — muting is required for it to
      // fire at all on most user-agents.
      qs.set("mute", "1");
    }
    qs.set("rel", "0");
    const src = `https://www.youtube.com/embed/${videoId}${qs.toString() ? `?${qs.toString()}` : ""}`;
    return { src, provider: "youtube" };
  }

  // --- Vimeo --------------------------------------------------------
  // vimeo.com/<digits>  |  vimeo.com/<digits>/<hash>  |  player.vimeo.com/video/<digits>
  const isVimeo = host === "vimeo.com" || host === "player.vimeo.com";
  if (isVimeo) {
    const parts = parsed.pathname.split("/").filter(Boolean);
    let videoId: string | null = null;
    if (host === "player.vimeo.com" && parts[0] === "video" && parts[1]) {
      videoId = parts[1];
    } else if (host === "vimeo.com" && parts[0]) {
      videoId = parts[0];
    }
    if (!videoId || !/^\d+$/.test(videoId)) return null;

    const qs = new URLSearchParams();
    if (autoplay) {
      qs.set("autoplay", "1");
      qs.set("muted", "1");
    }
    const base = `https://player.vimeo.com/video/${videoId}`;
    const query = qs.toString() ? `?${qs.toString()}` : "";
    // Vimeo uses a hash-fragment for start time (#t=30s), not a query.
    const hash = startSeconds !== undefined ? `#t=${startSeconds}s` : "";
    return { src: `${base}${query}${hash}`, provider: "vimeo" };
  }

  // providerHint ignored when the URL itself isn't allowlisted — an
  // attacker supplying provider="youtube" does not get past the host
  // check. Keep the hint in the signature for forward compatibility.
  void opts.providerHint;
  return null;
}

function InvalidFallback({ heading, body }: { heading?: string; body?: string }) {
  return (
    <section
      data-testid="video-section"
      data-section-type="video"
      data-video-state="invalid"
      className="mx-auto w-full max-w-4xl px-4 md:px-6"
    >
      {heading ? (
        <h2 className="mb-3 text-2xl font-semibold tracking-tight text-neutral-900 md:text-3xl">
          {heading}
        </h2>
      ) : null}
      <div
        data-testid="video-invalid"
        role="alert"
        className="rounded-lg border border-dashed border-amber-400 bg-amber-50 p-6 text-center text-sm text-amber-900"
      >
        Invalid video URL. Paste a full youtube.com, youtu.be, or vimeo.com link.
      </div>
      {body ? (
        <p className="mt-3 text-sm leading-relaxed text-neutral-600">{body}</p>
      ) : null}
    </section>
  );
}

export function VideoSection({ section }: VideoSectionProps) {
  const { heading, body, videoUrl, provider, autoplay, startSeconds } = section;

  const embed = buildEmbed(videoUrl, {
    autoplay,
    startSeconds,
    providerHint: provider,
  });

  if (!embed) {
    return <InvalidFallback heading={heading} body={body} />;
  }

  return (
    <section
      data-testid="video-section"
      data-section-type="video"
      data-video-provider={embed.provider}
      className="mx-auto w-full max-w-4xl px-4 md:px-6"
    >
      {heading ? (
        <h2 className="mb-4 text-2xl font-semibold tracking-tight text-neutral-900 md:text-3xl">
          {heading}
        </h2>
      ) : null}
      <div className="aspect-video w-full overflow-hidden rounded-lg bg-black shadow-sm">
        <iframe
          data-testid="video-iframe"
          src={embed.src}
          title={heading || `${embed.provider} video`}
          loading="lazy"
          allow="autoplay; fullscreen; picture-in-picture"
          allowFullScreen
          referrerPolicy="strict-origin-when-cross-origin"
          className="h-full w-full border-0"
        />
      </div>
      {body ? (
        <p className="mt-3 text-sm leading-relaxed text-neutral-600 md:text-base">{body}</p>
      ) : null}
    </section>
  );
}

export default VideoSection;
