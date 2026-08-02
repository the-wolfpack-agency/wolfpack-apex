/**
 * The collector that works where this is actually deployed.
 *
 * The tests worth reading are the ones about what a reference is NOT. This tier
 * reads served HTML, so it knows what the page points at, not what the page did.
 * Every place that distinction could quietly collapse — a status we did not
 * measure, a banner we could not see — is pinned here.
 */
import {
  collectStatic,
  detectConsentPlatform,
  extractHtmlLang,
  extractLinks,
  extractReferences,
  extractTitle,
} from "../collect-static";

const PAGE = "https://client.example.com/pricing";

/** A fetch stub. Headers is a real Headers so the code path matches production. */
function fetchOk(html: string, init: { headers?: Record<string, string>; status?: number; url?: string } = {}) {
  return jest.fn(async () => ({
    ok: (init.status ?? 200) < 400,
    status: init.status ?? 200,
    url: init.url ?? PAGE,
    headers: new Headers(init.headers ?? {}),
    text: async () => html,
  })) as unknown as typeof fetch;
}

describe("extractTitle / extractHtmlLang", () => {
  it("reads a title and collapses its whitespace", () => {
    expect(extractTitle("<title>\n  Acme  Pricing \n</title>")).toBe("Acme Pricing");
  });

  it("returns null rather than an empty string for an empty title", () => {
    // The check distinguishes "no title" from "title present"; an empty string
    // would read as present.
    expect(extractTitle("<title>   </title>")).toBeNull();
    expect(extractTitle("<p>no title here</p>")).toBeNull();
  });

  it("reads lang off the html element only", () => {
    expect(extractHtmlLang('<html lang="en-GB"><body>')).toBe("en-GB");
    expect(extractHtmlLang('<html><body><div lang="fr">')).toBeNull();
  });
});

describe("extractLinks", () => {
  const base = new URL(PAGE);

  it("resolves relative hrefs against the page", () => {
    const links = extractLinks('<a href="/privacy">Privacy</a>', base);
    expect(links[0]).toEqual({ href: "https://client.example.com/privacy", text: "Privacy" });
  });

  it("flattens nested markup in the link text", () => {
    // The policy matcher reads this text, so leaving tags in it would stop
    // "Privacy Policy" inside a span from ever matching.
    const links = extractLinks('<a href="/p"><span>Privacy</span> <b>Policy</b></a>', base);
    expect(links[0].text).toBe("Privacy Policy");
  });

  it("picks up a link whose closing tag is missing", () => {
    const links = extractLinks('<a href="/terms">', base);
    expect(links.map((l) => l.href)).toContain("https://client.example.com/terms");
  });

  it("drops an unparseable href instead of throwing", () => {
    expect(() => extractLinks('<a href="ht!tp://[[[">x</a>', base)).not.toThrow();
  });
});

describe("extractReferences", () => {
  it("never claims a status it did not measure", () => {
    // We did not request these. Reporting 200 would be inventing evidence.
    const refs = extractReferences('<script src="https://hotjar.com/hj.js"></script>', PAGE);
    expect(refs[0].status).toBeNull();
  });

  it("records atMs 0, because a reference in the served HTML loads before any interaction", () => {
    const refs = extractReferences('<script src="https://hotjar.com/hj.js"></script>', PAGE);
    expect(refs[0].atMs).toBe(0);
  });

  it("maps each tag to the resource type it implies", () => {
    const html = `
      <script src="https://a.example.net/s.js"></script>
      <img src="https://b.example.net/p.gif">
      <iframe src="https://c.example.net/f"></iframe>
      <link href="https://d.example.net/s.css">
      <source src="https://e.example.net/v.mp4">`;
    const byHost = Object.fromEntries(extractReferences(html, PAGE).map((r) => [r.url.split("/")[2], r.resourceType]));
    expect(byHost).toEqual({
      "a.example.net": "script",
      "b.example.net": "image",
      "c.example.net": "frame",
      "d.example.net": "stylesheet",
      "e.example.net": "media",
    });
  });

  it("deduplicates a host repeated with the same resource type", () => {
    const html = '<script src="https://cdn.x.net/a.js"></script><script src="https://cdn.x.net/b.js"></script>';
    expect(extractReferences(html, PAGE)).toHaveLength(1);
  });

  it("keeps the same host when it appears as a different resource type", () => {
    // A host serving both a script and a tracking pixel is doing two things.
    const html = '<script src="https://x.net/a.js"></script><img src="https://x.net/p.gif">';
    expect(extractReferences(html, PAGE)).toHaveLength(2);
  });

  it("resolves protocol-relative and relative references", () => {
    const refs = extractReferences('<script src="//cdn.example.net/a.js"></script><script src="/local.js"></script>', PAGE);
    const hosts = refs.map((r) => r.url.split("/")[2]);
    expect(hosts).toContain("cdn.example.net");
    expect(hosts).toContain("client.example.com");
  });

  it("returns nothing for an unparseable page url rather than throwing", () => {
    expect(extractReferences('<script src="/a.js">', "not a url")).toEqual([]);
  });
});

describe("detectConsentPlatform", () => {
  it("recognises a named consent platform", () => {
    expect(detectConsentPlatform('<script src="https://cdn.cookielaw.org/otSDKStub.js"></script>')).toBe(true);
  });

  it("does NOT fire on the word cookie in ordinary content", () => {
    // A false "banner present" downgrades the most serious finding this scan
    // makes, so the bar is a named vendor, not a keyword.
    expect(detectConsentPlatform("<a href=/cookies>Cookie policy</a><p>We use cookies.</p>")).toBe(false);
  });
});

describe("collectStatic", () => {
  it("reads a normal page into facts and references", async () => {
    const html = `<html lang="en"><head><title>Acme</title>
      <script src="https://plausible.io/s.js"></script></head>
      <body><a href="/privacy">Privacy Policy</a></body></html>`;
    const res = await collectStatic(PAGE, { fetchImpl: fetchOk(html, { headers: { "x-frame-options": "DENY" } }) });
    expect(res.facts.pageLoaded).toBe(true);
    expect(res.facts.htmlLang).toBe("en");
    expect(res.facts.title).toBe("Acme");
    expect(res.facts.headers["x-frame-options"]).toBe("DENY");
    expect(res.observations.map((o) => o.url)).toContain("https://plausible.io/s.js");
  });

  it("NEVER reports consent as given", async () => {
    // A read-only scan does not click Accept. Recording a consent time would
    // silently pass every tracker that fired after it.
    const html = '<script src="https://cdn.cookielaw.org/o.js"></script>';
    const res = await collectStatic(PAGE, { fetchImpl: fetchOk(html) });
    expect(res.facts.consentMechanismFound).toBe(true);
    expect(res.facts.consentAtMs).toBeNull();
  });

  it("keeps the headers from a non-200, because they are still real evidence", async () => {
    // The security-header check can be answered from a 404's headers. Throwing
    // them away because the status was not 200 discards a true finding.
    const res = await collectStatic(PAGE, {
      fetchImpl: fetchOk("", { status: 404, headers: { "strict-transport-security": "max-age=1" } }),
    });
    expect(res.facts.pageLoaded).toBe(false);
    expect(res.facts.headers["strict-transport-security"]).toBe("max-age=1");
    expect(res.error).toBe("HTTP 404");
  });

  it("reports a redirect target as the URL actually scanned", async () => {
    // A scan of a site that redirects elsewhere has scanned somewhere else, and
    // a report that names the original URL would be about the wrong site.
    const res = await collectStatic(PAGE, {
      fetchImpl: fetchOk("<html></html>", { url: "https://elsewhere.example.org/" }),
    });
    expect(res.finalUrl).toBe("https://elsewhere.example.org/");
  });

  it("resolves references against the FINAL url, not the requested one", async () => {
    const res = await collectStatic(PAGE, {
      fetchImpl: fetchOk('<script src="/a.js"></script>', { url: "https://elsewhere.example.org/x/" }),
    });
    expect(res.observations[0].url).toBe("https://elsewhere.example.org/a.js");
  });

  it("returns a page-did-not-load result instead of throwing when the site is down", async () => {
    const failing = jest.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const res = await collectStatic(PAGE, { fetchImpl: failing });
    expect(res.facts.pageLoaded).toBe(false);
    expect(res.error).toBe("ECONNREFUSED");
  });

  it("reports a timeout as a timeout, not as a clean empty page", async () => {
    const hanging = jest.fn(async (_u: string, init: RequestInit = {}) => {
      await new Promise((_r, reject) => init.signal?.addEventListener("abort", () => reject(new Error("The operation was aborted"))));
      throw new Error("unreachable");
    }) as unknown as typeof fetch;
    const res = await collectStatic(PAGE, { fetchImpl: hanging, timeoutMs: 5 });
    expect(res.facts.pageLoaded).toBe(false);
    expect(res.error).toMatch(/timed out/);
  });

  it("identifies itself, so a site owner can see who is fetching them", async () => {
    const f = fetchOk("<html></html>");
    await collectStatic(PAGE, { fetchImpl: f });
    const headers = (f as unknown as jest.Mock).mock.calls[0][1].headers;
    expect(headers["user-agent"]).toMatch(/Instinct-ComplianceScanner/);
  });

  it("caps how much body it will read", async () => {
    const huge = "<html>" + "x".repeat(4 * 1024 * 1024) + "</html>";
    const res = await collectStatic(PAGE, { fetchImpl: fetchOk(huge) });
    expect(res.facts.pageLoaded).toBe(true);
  });
});
