/**
 * @jest-environment jsdom
 */

/**
 * The collecting half, with a fake page and a real DOM.
 *
 * Two properties are load-bearing. The scan must never be able to mutate a
 * client's live site — the read-only floor is installed before navigation, and
 * a test asserts it. And a page that will not load must produce facts that say
 * so rather than an exception, because findings.ts turns "did not load" into
 * "unverifiable" and a thrown error produces no report at all.
 */
import { collectForCompliance, collectPageFacts, normalizeHeaders } from "../collect";
import { runComplianceChecks } from "../findings";
import type { ScanPage } from "../../browser/capture";

type Handler = (arg: unknown) => void;

/** A ScanPage that records what was asked of it. */
function fakePage(over: Partial<{ gotoThrows: string; evaluateThrows: string; headers: Record<string, string>; responses: unknown[] }> = {}) {
  const handlers: Record<string, Handler[]> = {};
  const routed: string[] = [];
  const page: ScanPage = {
    route: (pattern: string) => {
      routed.push(pattern);
    },
    on: ((event: string, handler: Handler) => {
      (handlers[event] ??= []).push(handler);
    }) as ScanPage["on"],
    addInitScript: () => {},
    goto: async () => {
      if (over.gotoThrows) throw new Error(over.gotoThrows);
      // Emit the recorded responses once navigation starts.
      for (const r of over.responses ?? []) for (const h of handlers.response ?? []) h(r);
      // headers() is a METHOD on Playwright's Response. Modelling it as a
      // property is how a fake ends up validating the same bug the code has.
      return { status: () => 200, headers: () => over.headers ?? {} } as never;
    },
    evaluate: (async <R,>(fn: () => R): Promise<R> => {
      if (over.evaluateThrows) throw new Error(over.evaluateThrows);
      return fn();
    }) as ScanPage["evaluate"],
  };
  return { page, routed };
}

const response = (url: string, status = 200, resourceType = "script") => ({
  url: () => url,
  status: () => status,
  request: () => ({ resourceType: () => resourceType }),
});

beforeEach(() => {
  document.documentElement.removeAttribute("lang");
  document.title = "";
  document.body.innerHTML = "";
});

describe("collectPageFacts", () => {
  it("reads links, language and title from the real DOM", () => {
    document.documentElement.setAttribute("lang", "en-GB");
    document.title = "Acme";
    document.body.innerHTML = `<a href="/privacy">Privacy Policy</a><a href="/contact">Contact</a>`;
    const f = collectPageFacts();
    expect(f.htmlLang).toBe("en-GB");
    expect(f.title).toBe("Acme");
    expect(f.links.map((l) => l.text)).toEqual(["Privacy Policy", "Contact"]);
  });

  it("never reports that consent was GIVEN", () => {
    // A read-only scan does not click Accept. Reporting a consent time would
    // silently pass every tracker that fired after it, turning the most serious
    // finding into a pass.
    document.body.innerHTML = `<div role="dialog">We use cookies. Accept all</div>`;
    const f = collectPageFacts();
    expect(f.consentMechanismFound).toBe(true);
    expect(f.consentAtMs).toBeNull();
  });

  it("detects a banner by its text", () => {
    document.body.innerHTML = `<div class="cookie-bar">We use cookies to improve your experience</div>`;
    expect(collectPageFacts().consentMechanismFound).toBe(true);
  });

  it("detects a known consent platform by its global", () => {
    (window as unknown as Record<string, unknown>).OneTrust = {};
    expect(collectPageFacts().consentMechanismFound).toBe(true);
    delete (window as unknown as Record<string, unknown>).OneTrust;
  });

  it("does not call an unrelated dialog a consent banner", () => {
    // A false "banner present" downgrades a critical finding. When unsure it
    // must say nothing.
    document.body.innerHTML = `<div role="dialog">Subscribe to our newsletter</div>`;
    expect(collectPageFacts().consentMechanismFound).toBe(false);
  });

  it("drops links with no usable href and caps how many it reads", () => {
    document.body.innerHTML = `<a href="">empty</a>` + Array.from({ length: 450 }, (_, i) => `<a href="/p${i}">p${i}</a>`).join("");
    const f = collectPageFacts();
    expect(f.links.length).toBeLessThanOrEqual(400);
    expect(f.links.every((l) => l.href !== "")).toBe(true);
  });
});

describe("normalizeHeaders", () => {
  it("lowercases keys so lookups are predictable", () => {
    expect(normalizeHeaders({ "Content-Security-Policy": "x" })).toEqual({ "content-security-policy": "x" });
  });
  it("survives missing headers", () => {
    expect(normalizeHeaders(undefined)).toEqual({});
  });
});

describe("collectForCompliance", () => {
  it("installs the read-only floor BEFORE navigating", async () => {
    // The safety guarantee: a compliance scan runs against a client's live
    // site, so no mutating request may ever leave the browser.
    const { page, routed } = fakePage();
    await collectForCompliance("https://client.example/", { page, now: () => 0 });
    expect(routed).toContain("**/*");
  });

  it("records every response as an observation", async () => {
    let t = 0;
    const { page } = fakePage({ responses: [response("https://google-analytics.com/g"), response("https://client.example/a.js")] });
    const out = await collectForCompliance("https://client.example/", { page, now: () => (t += 100) });
    expect(out.observations.map((o) => o.url)).toEqual(["https://google-analytics.com/g", "https://client.example/a.js"]);
    expect(out.observations[0].pageUrl).toBe("https://client.example/");
  });

  it("reports a failed navigation as not-loaded rather than throwing", async () => {
    // A throw here produces no report at all. findings.ts turns not-loaded into
    // "unverifiable", which is a truthful report.
    const { page } = fakePage({ gotoThrows: "ERR_NAME_NOT_RESOLVED" });
    const out = await collectForCompliance("https://nope.invalid/", { page });
    expect(out.facts.pageLoaded).toBe(false);
    expect(out.error).toContain("ERR_NAME_NOT_RESOLVED");

    const findings = runComplianceChecks({ pageUrl: "https://nope.invalid/", facts: out.facts, observations: out.observations });
    expect(findings.every((f) => f.verdict === "unverifiable")).toBe(true);
  });

  it("distinguishes a page that loaded but could not be read", async () => {
    const { page } = fakePage({ evaluateThrows: "detached frame", headers: { "X-Frame-Options": "DENY" } });
    const out = await collectForCompliance("https://client.example/", { page });
    expect(out.facts.pageLoaded).toBe(false);
    expect(out.error).toContain("detached frame");
    // Headers were captured before the read failed, so they are kept.
    expect(out.facts.headers["x-frame-options"]).toBe("DENY");
  });

  it("does not lose the whole capture to one unreadable response", async () => {
    const broken = {
      url: () => {
        throw new Error("gone");
      },
    };
    const { page } = fakePage({ responses: [broken, response("https://ok.test/x")] });
    const out = await collectForCompliance("https://client.example/", { page, now: () => 0 });
    expect(out.observations.map((o) => o.url)).toEqual(["https://ok.test/x"]);
  });

  it("feeds findings end to end, from a live DOM to a verdict", async () => {
    // The whole chain: page -> facts + observations -> findings. A tracker
    // firing with no banner present must come out critical.
    document.body.innerHTML = `<a href="/privacy">Privacy Policy</a>`;
    document.title = "Acme";
    document.documentElement.setAttribute("lang", "en");
    const { page } = fakePage({ responses: [response("https://google-analytics.com/g")], headers: { "Content-Security-Policy": "default-src 'self'" } });

    const out = await collectForCompliance("https://client.example/", { page, now: () => 0 });
    const findings = runComplianceChecks({ pageUrl: "https://client.example/", facts: out.facts, observations: out.observations });

    const tracking = findings.find((f) => f.id === "tracking-before-consent")!;
    expect(tracking).toMatchObject({ verdict: "absent", severity: "critical" });
    expect(tracking.detail).toContain("Google Analytics");
    expect(findings.find((f) => f.id === "privacy-policy")!.verdict).toBe("present");
  });
});
