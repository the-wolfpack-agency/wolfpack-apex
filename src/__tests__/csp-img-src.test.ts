/**
 * CSP img-src never allows any https host.
 *
 * `img-src https:` makes every page able to load an image from any host, and
 * an image is a request the browser makes with no click. If model output ever
 * reaches an image sink, that is a zero-click exfiltration channel. The list
 * of hosts lives in src/lib/csp-image-hosts.ts; this test reads the header the
 * middleware actually sends.
 */
/** @jest-environment node */
import { NextRequest } from "next/server";
import { middleware, cspFor } from "@/middleware";
import {
  APP_IMG_SOURCES,
  SITE_BUILDER_IMG_HOSTS,
  imgSrcDirective,
  isAllowedSiteImageSrc,
  isSiteBuilderPath,
} from "@/lib/csp-image-hosts";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

async function headerFor(pathname: string): Promise<string> {
  const res = await middleware(new NextRequest(`https://wolfpack-instinct.vercel.app${pathname}`, { headers: { "user-agent": UA } }));
  return res.headers.get("Content-Security-Policy") ?? "";
}

function imgSrc(csp: string): string[] {
  const d = csp.split(";").map((s) => s.trim()).find((s) => s.startsWith("img-src "));
  if (!d) throw new Error(`no img-src in ${csp}`);
  return d.split(/\s+/).slice(1);
}

const PAGES = ["/", "/dashboard", "/assistant", "/support", "/support/tickets/abc", "/login", "/sites", "/sites/p1/edit", "/sites/p1/preview", "/share/tok", "/api/health"];

describe("CSP img-src", () => {
  it.each(PAGES)("%s: no wildcard https source", async (p) => {
    const sources = imgSrc(await headerFor(p));
    expect(sources).not.toContain("https:");
    expect(sources).not.toContain("http:");
    expect(sources).not.toContain("*");
    expect(sources.filter((s) => /^https:\/\/\*$/.test(s) || s === "https://*")).toEqual([]);
  });

  it.each(["/", "/dashboard", "/assistant", "/support", "/login"])("%s: same-origin, data: and blob: only", async (p) => {
    expect(imgSrc(await headerFor(p))).toEqual([...APP_IMG_SOURCES]);
  });

  it.each(["/sites/p1/edit", "/sites/p1/preview", "/share/tok"])("%s: the site-builder hosts, named", async (p) => {
    expect(imgSrc(await headerFor(p))).toEqual([...APP_IMG_SOURCES, ...SITE_BUILDER_IMG_HOSTS]);
  });

  it("every named host is https and specific (no bare TLD wildcard)", () => {
    for (const h of SITE_BUILDER_IMG_HOSTS) {
      expect(h).toMatch(/^https:\/\/(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+$/);
    }
  });

  it("the other directives are unchanged by the per-route img-src", () => {
    const csp = cspFor("/dashboard");
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'self'");
    expect(csp).toContain("report-uri /api/csp-report");
    expect(csp.match(/img-src/g)).toHaveLength(1);
  });

  it("route scoping does not leak to lookalike paths", () => {
    expect(isSiteBuilderPath("/sites")).toBe(true);
    expect(isSiteBuilderPath("/sites/x")).toBe(true);
    expect(isSiteBuilderPath("/sitesettings")).toBe(false);
    expect(isSiteBuilderPath("/share")).toBe(false);
    expect(imgSrcDirective("/sitesettings")).toBe("img-src 'self' data: blob:");
  });
});

describe("isAllowedSiteImageSrc (renderers skip what the CSP would refuse)", () => {
  it.each([
    "/cftr/IMG_4182.jpg",
    "data:image/png;base64,iVBORw0KGgo=",
    "blob:https://wolfpack-instinct.vercel.app/1234",
    "https://raw.githubusercontent.com/org/site/main/public/generated/a.jpg",
    "https://v3.fal.media/files/x.jpg",
    "https://wolfpack-client.vercel.app/hero.jpg",
  ])("allows %s", (src) => {
    expect(isAllowedSiteImageSrc(src)).toBe(true);
  });

  it.each([
    "https://collector.example/p.png?d=U0VDUkVU",
    "http://raw.githubusercontent.com/x.jpg",
    "//evil.example/x.png",
    "javascript:alert(1)",
    "data:text/html,<script>",
    "https://raw.githubusercontent.com.evil.example/x.png",
    "",
    null,
  ])("refuses %s", (src) => {
    expect(isAllowedSiteImageSrc(src as string)).toBe(false);
  });
});
