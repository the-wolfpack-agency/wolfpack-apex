/**
 * @jest-environment jsdom
 */

/**
 * video section renderer tests.
 *
 * Covers the full safety + URL-translation contract documented in
 * components/sites/sections/video.tsx:
 *   - YouTube watch/short URLs → https://www.youtube.com/embed/<id>
 *   - Vimeo URLs → https://player.vimeo.com/video/<id>
 *   - start time appended as ?start=N (YouTube) / #t=Ns (Vimeo)
 *   - autoplay appended as &autoplay=1 (+muted flag to satisfy browser
 *     autoplay policies)
 *   - Any non-allowlisted URL → visible "Invalid video URL" fallback,
 *     zero <iframe> nodes in the DOM.
 *   - javascript: URLs → same fallback (XSS smoke).
 *   - User-supplied <script> in heading/body renders escaped, not
 *     executed.
 *   - Missing videoUrl → fallback, no iframe.
 *
 * NOTE: The sibling render-brief.test.tsx already covers section-
 * dispatcher wiring for the other types. The shared "every section type
 * renders" block there is locked by a parallel stream (templates) — so
 * this file owns video-specific coverage top-to-bottom instead of
 * threading one more case through the dispatcher test.
 */

import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { VideoSection, buildEmbed } from "@/components/sites/sections/video";
import { RenderSection } from "@/components/sites/render-brief";

describe("buildEmbed — pure URL translation", () => {
  it("parses a canonical YouTube watch URL", () => {
    const out = buildEmbed("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(out?.provider).toBe("youtube");
    expect(out?.src).toMatch(/^https:\/\/www\.youtube\.com\/embed\/dQw4w9WgXcQ/);
  });

  it("parses a youtu.be short URL", () => {
    const out = buildEmbed("https://youtu.be/dQw4w9WgXcQ");
    expect(out?.provider).toBe("youtube");
    expect(out?.src).toMatch(/^https:\/\/www\.youtube\.com\/embed\/dQw4w9WgXcQ/);
  });

  it("parses a Vimeo numeric URL", () => {
    const out = buildEmbed("https://vimeo.com/76979871");
    expect(out?.provider).toBe("vimeo");
    expect(out?.src).toMatch(/^https:\/\/player\.vimeo\.com\/video\/76979871/);
  });

  it("rejects arbitrary hosts", () => {
    expect(buildEmbed("https://evil.com/steal")).toBeNull();
    expect(buildEmbed("https://fake-youtube.com/watch?v=abc")).toBeNull();
  });

  it("rejects non-https protocols", () => {
    expect(buildEmbed("http://youtube.com/watch?v=abc")).toBeNull();
    expect(buildEmbed("javascript:alert(1)")).toBeNull();
  });

  it("rejects malformed URLs", () => {
    expect(buildEmbed("not a url")).toBeNull();
    expect(buildEmbed("")).toBeNull();
    expect(buildEmbed(undefined)).toBeNull();
  });

  it("rejects YouTube URLs missing a video id", () => {
    expect(buildEmbed("https://www.youtube.com/watch")).toBeNull();
    expect(buildEmbed("https://youtu.be/")).toBeNull();
  });

  it("rejects Vimeo URLs with a non-numeric id", () => {
    expect(buildEmbed("https://vimeo.com/not-a-number")).toBeNull();
  });
});

describe("buildEmbed — query/fragment options", () => {
  it("appends ?start=N for YouTube when startSeconds set", () => {
    const out = buildEmbed("https://www.youtube.com/watch?v=abc123", { startSeconds: 30 });
    expect(out?.src).toContain("start=30");
  });

  it("appends #t=Ns for Vimeo when startSeconds set", () => {
    const out = buildEmbed("https://vimeo.com/123", { startSeconds: 30 });
    expect(out?.src).toContain("#t=30s");
  });

  it("appends autoplay=1 on YouTube autoplay=true", () => {
    const out = buildEmbed("https://www.youtube.com/watch?v=abc123", { autoplay: true });
    expect(out?.src).toMatch(/[?&]autoplay=1/);
    // Browsers block audible autoplay; mute is mandatory for it to work.
    expect(out?.src).toMatch(/[?&]mute=1/);
  });

  it("appends autoplay=1 on Vimeo autoplay=true", () => {
    const out = buildEmbed("https://vimeo.com/123", { autoplay: true });
    expect(out?.src).toMatch(/[?&]autoplay=1/);
    expect(out?.src).toMatch(/[?&]muted=1/);
  });

  it("floors fractional startSeconds and rejects negatives silently", () => {
    expect(buildEmbed("https://vimeo.com/123", { startSeconds: 30.9 })?.src).toContain("#t=30s");
    // Negative values are dropped (validateBrief rejects at the schema
    // layer; renderer still degrades gracefully).
    expect(buildEmbed("https://vimeo.com/123", { startSeconds: -5 })?.src).not.toContain("#t=");
  });
});

describe("VideoSection — rendered output", () => {
  it("renders a YouTube iframe with the embed URL", () => {
    const { container } = render(
      <VideoSection
        section={{
          type: "video",
          heading: "Watch this",
          videoUrl: "https://www.youtube.com/watch?v=abc123",
        }}
      />,
    );
    expect(screen.getByTestId("video-section")).toHaveAttribute("data-video-provider", "youtube");
    const iframe = container.querySelector("iframe") as HTMLIFrameElement;
    expect(iframe).not.toBeNull();
    expect(iframe.getAttribute("src")).toMatch(/^https:\/\/www\.youtube\.com\/embed\/abc123/);
    expect(iframe.getAttribute("loading")).toBe("lazy");
    expect(iframe.getAttribute("allow")).toContain("fullscreen");
  });

  it("renders a youtu.be short URL into the canonical embed form", () => {
    const { container } = render(
      <VideoSection section={{ type: "video", videoUrl: "https://youtu.be/abc123" }} />,
    );
    const iframe = container.querySelector("iframe") as HTMLIFrameElement;
    expect(iframe.getAttribute("src")).toMatch(/^https:\/\/www\.youtube\.com\/embed\/abc123/);
  });

  it("renders a Vimeo URL into the player.vimeo.com embed", () => {
    const { container } = render(
      <VideoSection section={{ type: "video", videoUrl: "https://vimeo.com/76979871" }} />,
    );
    const iframe = container.querySelector("iframe") as HTMLIFrameElement;
    expect(iframe.getAttribute("src")).toMatch(/^https:\/\/player\.vimeo\.com\/video\/76979871/);
  });

  it("appends start=30 on YouTube when startSeconds=30", () => {
    const { container } = render(
      <VideoSection
        section={{
          type: "video",
          videoUrl: "https://www.youtube.com/watch?v=abc123",
          startSeconds: 30,
        }}
      />,
    );
    const src = container.querySelector("iframe")!.getAttribute("src")!;
    expect(src).toContain("start=30");
  });

  it("appends #t=30s on Vimeo when startSeconds=30", () => {
    const { container } = render(
      <VideoSection
        section={{ type: "video", videoUrl: "https://vimeo.com/123", startSeconds: 30 }}
      />,
    );
    const src = container.querySelector("iframe")!.getAttribute("src")!;
    expect(src).toContain("#t=30s");
  });

  it("appends autoplay=1 when autoplay=true", () => {
    const { container } = render(
      <VideoSection
        section={{
          type: "video",
          videoUrl: "https://www.youtube.com/watch?v=abc123",
          autoplay: true,
        }}
      />,
    );
    const src = container.querySelector("iframe")!.getAttribute("src")!;
    expect(src).toMatch(/[?&]autoplay=1/);
  });
});

describe("VideoSection — fallback safety", () => {
  it("shows invalid fallback and does NOT render an iframe for evil.com", () => {
    const { container } = render(
      <VideoSection
        section={{ type: "video", heading: "Oops", videoUrl: "https://evil.com/steal" }}
      />,
    );
    expect(screen.getByTestId("video-invalid")).toBeInTheDocument();
    expect(container.querySelector("iframe")).toBeNull();
  });

  it("shows invalid fallback for a javascript: URL (XSS smoke)", () => {
    const { container } = render(
      // Casting via unknown — TS would normally reject javascript: in a
      // string union, but users paste anything. We must not iframe it.
      <VideoSection
        section={{ type: "video", videoUrl: "javascript:alert(1)" as unknown as string }}
      />,
    );
    expect(screen.getByTestId("video-invalid")).toBeInTheDocument();
    expect(container.querySelector("iframe")).toBeNull();
  });

  it("shows fallback when videoUrl is missing", () => {
    const { container } = render(<VideoSection section={{ type: "video" }} />);
    expect(screen.getByTestId("video-invalid")).toBeInTheDocument();
    expect(container.querySelector("iframe")).toBeNull();
  });

  it("escapes <script> in heading/body (no executable script element)", () => {
    const { container } = render(
      <VideoSection
        section={{
          type: "video",
          heading: "<script>alert('x')</script>",
          body: "<script>alert('y')</script>",
          videoUrl: "https://www.youtube.com/watch?v=abc123",
        }}
      />,
    );
    const section = screen.getByTestId("video-section");
    expect(section.querySelector("script")).toBeNull();
    // Text content is preserved — React rendered it as a text node, not
    // parsed HTML. innerHTML contains the entity-escaped form.
    expect(section).toHaveTextContent("<script>alert('x')</script>");
    expect(section).toHaveTextContent("<script>alert('y')</script>");
    expect(section.innerHTML).toContain("&lt;script&gt;");
    // Narrow the assertion to the heading + caption nodes — the iframe's
    // `title` attribute is a safe HTML-attribute context and contains
    // the literal heading as expected (not an execution sink).
    const heading = section.querySelector("h2")!;
    const caption = section.querySelector("p")!;
    expect(heading.innerHTML).not.toMatch(/<script>/i);
    expect(caption.innerHTML).not.toMatch(/<script>/i);
  });
});

describe("RenderSection dispatcher — video routing", () => {
  it("routes type=video to VideoSection", () => {
    render(
      <RenderSection
        index={0}
        section={{
          type: "video",
          videoUrl: "https://www.youtube.com/watch?v=abc123",
        }}
      />,
    );
    expect(screen.getByTestId("video-section")).toHaveAttribute(
      "data-section-type",
      "video",
    );
  });
});
