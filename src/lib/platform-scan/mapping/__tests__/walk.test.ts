/**
 * The thing that actually walks a system.
 *
 * WHAT WAS MISSING. Every rule for mapping existed and nothing ran them.
 * explore.ts holds the frontier, the follow rules and the budget; click-policy
 * holds what may be clicked; types.ts describes the map. All of it was
 * referenced only by its own tests, so the capability was a set of parts and
 * platform_scan.assessment_started has fired zero times in the product's life.
 *
 * The driver asks the existing rules every question rather than deciding
 * anything itself, which is what keeps the judgement testable without a
 * browser and this file testable without a client system.
 */

import { walkSystem, type SurfaceReader, type ReadSurface } from "@/lib/platform-scan/mapping/walk";
import type { ClickCandidate } from "@/lib/platform-scan/mapping/click-policy";

const BASE = "https://app.example.com";

function surface(over: Partial<ReadSurface> & { url: string }): ReadSurface {
  return {
    status: 200,
    title: "A page",
    headings: [],
    links: [],
    forms: [],
    tables: [],
    controls: [],
    loadMs: 10,
    ...over,
  };
}

/** A reader backed by a fixed map of pages, so a walk is deterministic. */
function readerFor(
  pages: Record<string, Partial<ReadSurface>>,
  clicks: Record<string, string | null> = {},
): SurfaceReader {
  return {
    async read(url) {
      const page = pages[url];
      if (!page) throw new Error(`no such page: ${url}`);
      return surface({ url, ...page });
    },
    async clickTo(control: ClickCandidate) {
      const key = control.text || control.label || "";
      return key in clicks ? clicks[key] : null;
    },
  };
}

describe("walking by links", () => {
  it("reaches every linked surface", async () => {
    const r = await walkSystem(
      `${BASE}/`,
      readerFor({
        [`${BASE}/`]: { links: [`${BASE}/forms`, `${BASE}/reports`] },
        [`${BASE}/forms`]: { title: "Forms" },
        [`${BASE}/reports`]: { title: "Reports" },
      }),
    );
    expect(r.surfaces.map((s) => s.title).sort()).toEqual(["A page", "Forms", "Reports"]);
    expect(r.coverage.stopReason).toBe("frontier-exhausted");
    expect(r.coverage.frontierRemaining).toBe(0);
  });

  it("records the structure rather than the record ids", async () => {
    const r = await walkSystem(
      `${BASE}/`,
      readerFor({
        [`${BASE}/`]: { links: [`${BASE}/account/001`, `${BASE}/account/002`] },
        [`${BASE}/account/001`]: {},
        [`${BASE}/account/002`]: {},
      }),
    );
    /* Two records are ONE surface. A map that counted them separately would
       report two thousand screens for a CRM with two thousand accounts. */
    expect(r.surfaces).toHaveLength(2);
  });

  it("refuses to leave the origin, and says so", async () => {
    const r = await walkSystem(
      `${BASE}/`,
      readerFor({ [`${BASE}/`]: { links: ["https://elsewhere.example.net/x"] } }),
    );
    expect(r.surfaces).toHaveLength(1);
    expect(r.coverage.skipped.some((s) => s.reason === "off-origin")).toBe(true);
  });

  it("refuses a dangerous-looking link", async () => {
    const r = await walkSystem(
      `${BASE}/`,
      readerFor({ [`${BASE}/`]: { links: [`${BASE}/logout`, `${BASE}/users/5/delete`] } }),
    );
    expect(r.surfaces).toHaveLength(1);
    expect(r.coverage.skipped.filter((s) => s.reason === "dangerous")).toHaveLength(2);
  });
});

describe("clicking, which is what sees inside an app", () => {
  /* A dashboard keeps its structure behind tabs and client-side routing, so a
     link-only walk maps the shell and reports it as the system. */
  it("follows a safe control that changes the URL", async () => {
    const r = await walkSystem(
      `${BASE}/`,
      readerFor(
        {
          [`${BASE}/`]: { controls: [{ tag: "button", text: "Details", role: "tab" }] },
          [`${BASE}/details`]: { title: "Details" },
        },
        { Details: `${BASE}/details` },
      ),
    );
    expect(r.surfaces.map((s) => s.title)).toContain("Details");
  });

  /* A tab that does not change the URL is not a failure: the surface was
     already counted. */
  it("is untroubled by a control that changes nothing", async () => {
    const r = await walkSystem(
      `${BASE}/`,
      readerFor({ [`${BASE}/`]: { controls: [{ tag: "button", text: "Expand", ariaExpanded: false }] } }),
    );
    expect(r.surfaces).toHaveLength(1);
    expect(r.coverage.stopReason).toBe("frontier-exhausted");
  });

  /* THE ONE THAT MATTERS. A refused control must never be clicked, and the
     refusal must appear in the coverage, because a map that silently skips
     half a page overstates what it covered. */
  it("never clicks a mutating control, and reports declining it", async () => {
    const clicked: string[] = [];
    const reader: SurfaceReader = {
      async read(url) {
        return surface({
          url,
          controls: [
            { tag: "button", text: "Delete form" },
            { tag: "button", text: "Log out" },
            { tag: "button", text: "" },
          ],
        });
      },
      async clickTo(c) {
        clicked.push(c.text);
        return null;
      },
    };
    const r = await walkSystem(`${BASE}/`, reader);
    expect(clicked).toEqual([]);
    expect(r.coverage.skipped.length).toBeGreaterThanOrEqual(3);
    expect(r.coverage.skipped.some((s) => /end the session/i.test(s.reason))).toBe(true);
  });
});

describe("stopping honestly", () => {
  it("stops at the surface budget and says the map is incomplete", async () => {
    /* Nested under one segment, because the walk confines itself to the entry
       URL's first path segment: a flat /p0 -> /p1 chain would now be refused
       as another tenant, which is the confinement working and not the budget. */
    /* NESTED RATHER THAN SIBLINGS, and that is not incidental. A flat
       /app/p0 ... /app/p19 is twenty instances of one shape, which the sampler
       now correctly stops opening after two, so the frontier would empty and
       the budget would never be what stopped it. Nesting gives every page a
       shape of its own, which is what this test is actually about. */
    const pages: Record<string, Partial<ReadSurface>> = {};
    let path = "/app";
    for (let i = 0; i < 8; i += 1) {
      const next = `${path}/p${i}`;
      pages[`${BASE}${path}`] = { links: [`${BASE}${next}`] };
      path = next;
    }
    pages[`${BASE}${path}`] = {};
    const r = await walkSystem(`${BASE}/app`, readerFor(pages), {
      budget: { maxSurfaces: 5, maxDepth: 10, maxDurationMs: 60_000 },
    });
    expect(r.coverage.stopReason).toBe("page-budget");
    /* NON-ZERO IS THE POINT. Every claim drawn from this map inherits it. */
    expect(r.coverage.frontierRemaining).toBeGreaterThan(0);
  });

  it("stops on the clock", async () => {
    let t = 0;
    const r = await walkSystem(
      `${BASE}/`,
      readerFor({ [`${BASE}/`]: { links: [`${BASE}/a`] }, [`${BASE}/a`]: {} }),
      { budget: { maxSurfaces: 99, maxDepth: 9, maxDurationMs: 5 }, now: () => (t += 10) },
    );
    expect(r.coverage.stopReason).toBe("time-budget");
  });

  /* A page that will not load is a finding, not a reason to abandon the walk:
     a broken screen inside somebody's system is what an assessment is for. */
  it("keeps going when a page fails, and records it", async () => {
    const r = await walkSystem(
      `${BASE}/`,
      readerFor({
        [`${BASE}/`]: { links: [`${BASE}/broken`, `${BASE}/fine`] },
        [`${BASE}/fine`]: { title: "Fine" },
      }),
    );
    expect(r.surfaces.map((s) => s.title)).toContain("Fine");
    expect(r.coverage.skipped.some((s) => /unreadable/.test(s.reason))).toBe(true);
  });

  it("reports an unusable entry url rather than throwing", async () => {
    const r = await walkSystem("not a url", readerFor({}));
    expect(r.surfaces).toHaveLength(0);
    expect(r.coverage.stopReason).toBe("error");
  });

  /* One link from forty rows is one decision. Forty identical lines would
     bury the refusals that matter. */
  it("records a repeated refusal once", async () => {
    const r = await walkSystem(
      `${BASE}/`,
      readerFor({
        [`${BASE}/`]: {
          links: Array.from({ length: 20 }, () => "https://elsewhere.example.net/same"),
        },
      }),
    );
    expect(r.coverage.skipped.filter((s) => s.reason === "off-origin")).toHaveLength(1);
  });
});


/**
 * A MULTI-TENANT HOST IS THE VENDOR'S DOMAIN, NOT THE CUSTOMER'S.
 *
 * Mapping a real tenant on 2026-08-30, the walk left the customer's org and
 * spent 17 of 40 surfaces inside the vendor's own documentation, because
 * cognitoforms.com serves /porscheacademyus and /support from one host.
 *
 * The cost was not only wasted surfaces. The frontier finished at 301 because
 * a docs site is effectively unbounded, the form count filled with the
 * vendor's newsletter and support-chat widgets, and the refusal list filled
 * with their controls rather than the client's. A map of somebody else's
 * marketing site is worse than a small map.
 */
describe("staying inside the tenant", () => {
  const TENANT = `${BASE}/acme`;

  it("does not follow the vendor's own pages on the same host", async () => {
    const r = await walkSystem(
      `${TENANT}/home`,
      readerFor({
        [`${TENANT}/home`]: { links: [`${TENANT}/forms`, `${BASE}/support/how-to-guides`] },
        [`${TENANT}/forms`]: { title: "Forms" },
        [`${BASE}/support/how-to-guides`]: { title: "Vendor docs" },
      }),
    );
    expect(r.surfaces.map((s) => s.title)).not.toContain("Vendor docs");
    expect(r.coverage.skipped.some((s) => s.reason === "outside-tenant")).toBe(true);
  });

  /* THE DANGEROUS DIRECTION. A bare startsWith would walk ANOTHER customer's
     org whose name happens to begin with this one's. */
  it("does not wander into a tenant whose name shares a prefix", async () => {
    const r = await walkSystem(
      `${TENANT}/home`,
      readerFor({
        [`${TENANT}/home`]: { links: [`${BASE}/acmecorp/home`] },
        [`${BASE}/acmecorp/home`]: { title: "Someone else" },
      }),
    );
    expect(r.surfaces.map((s) => s.title)).not.toContain("Someone else");
  });

  /* A single-tenant system has no org segment, and the origin already is the
     boundary. Confining to the first path segment there would map one folder. */
  it("does not confine when the entry url has no path", async () => {
    const r = await walkSystem(
      `${BASE}/`,
      readerFor({
        [`${BASE}/`]: { links: [`${BASE}/anything`] },
        [`${BASE}/anything`]: { title: "Reached" },
      }),
    );
    expect(r.surfaces.map((s) => s.title)).toContain("Reached");
  });
});

/**
 * A record id needs a DIGIT.
 *
 * Matching any 15-18 character alphanumeric run also matches ordinary words:
 * "porscheacademyus" is 16 characters, so every surface in a real map read
 * /:id/home and the org disappeared from its own map.
 */
describe("collapsing records without collapsing names", () => {
  it("keeps a word-like path segment readable", async () => {
    const r = await walkSystem(
      `${BASE}/porscheacademyus/home`,
      readerFor({ [`${BASE}/porscheacademyus/home`]: {} }),
    );
    expect(r.surfaces[0].signature).toBe("/porscheacademyus/home");
  });

  it("still collapses a real record id", async () => {
    const r = await walkSystem(
      `${BASE}/acct/001x00000ABCDEfg/view`,
      readerFor({ [`${BASE}/acct/001x00000ABCDEfg/view`]: {} }),
    );
    expect(r.surfaces[0].signature).toBe("/acct/:id/view");
  });

  /* A deep link into a single-tenant system would otherwise map one folder.
     Passing null walks the whole origin. */
  it("walks the whole origin when confinement is switched off", async () => {
    const r = await walkSystem(
      `${BASE}/dashboard`,
      readerFor({
        [`${BASE}/dashboard`]: { links: [`${BASE}/reports`] },
        [`${BASE}/reports`]: { title: "Reports" },
      }),
      { confineTo: null },
    );
    expect(r.surfaces.map((s) => s.title)).toContain("Reports");
  });
});

/**
 * The repetition problem, end to end.
 *
 * Mapping a real tenant, the walk spent its whole budget on thirteen forms
 * that each had the same three sub-screens, and stopped with thirty-four
 * places still queued having learned nothing after the third form.
 */
describe("a system that repeats itself", () => {
  const FORMS = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf"];

  const repetitiveSystem = (): Record<string, Partial<ReadSurface>> => {
    const pages: Record<string, Partial<ReadSurface>> = {
      [`${BASE}/org/home`]: { links: FORMS.map((f) => `${BASE}/org/${f}/all-entries`) },
    };
    for (const f of FORMS) {
      pages[`${BASE}/org/${f}/all-entries`] = {
        links: ["build", "publish", "entries"].map((s) => `${BASE}/org/${f}/${s}`),
      };
      for (const s of ["build", "publish", "entries"]) pages[`${BASE}/org/${f}/${s}`] = {};
    }
    return pages;
  };

  it("opens far fewer surfaces than it finds", async () => {
    const r = await walkSystem(`${BASE}/org/home`, readerFor(repetitiveSystem()), {
      budget: { maxSurfaces: 200, maxDepth: 10, maxDurationMs: 60_000 },
    });
    /* 1 home + 7 landings + 21 sub-screens = 29 if it opened everything. */
    expect(r.surfaces.length).toBeLessThan(20);
    expect(r.coverage.stopReason).toBe("frontier-exhausted");
  });

  /* THE COST THAT WOULD MAKE IT A BAD TRADE. Cheaper is only better if the
     map still covers both dimensions: every business object, and every kind
     of screen the system has. */
  it("still opens every form, which is the inventory", async () => {
    const r = await walkSystem(`${BASE}/org/home`, readerFor(repetitiveSystem()), {
      budget: { maxSurfaces: 200, maxDepth: 10, maxDurationMs: 60_000 },
    });
    const opened = new Set(r.surfaces.map((s) => new URL(s.url).pathname.split("/")[2]));
    for (const f of FORMS) expect(opened.has(f)).toBe(true);
  });

  it("still sees every kind of screen", async () => {
    const r = await walkSystem(`${BASE}/org/home`, readerFor(repetitiveSystem()), {
      budget: { maxSurfaces: 200, maxDepth: 10, maxDurationMs: 60_000 },
    });
    const kinds = new Set(r.surfaces.map((s) => new URL(s.url).pathname.split("/")[3]));
    for (const k of ["build", "publish", "entries"]) expect(kinds.has(k)).toBe(true);
  });

  /* SAMPLED IS NOT THE SAME AS FOUND, and a map that blurred them would be
     the confident kind of wrong this product keeps having to design against. */
  it("reports every instance it declined to open", async () => {
    const r = await walkSystem(`${BASE}/org/home`, readerFor(repetitiveSystem()), {
      budget: { maxSurfaces: 200, maxDepth: 10, maxDurationMs: 60_000 },
    });
    /* What the walk actually settles into: the first two forms are explored in
       full, the rest get their landing screen and one more, and all seven are
       known. So the publish screens are the ones sampled rather than the build
       screens, which is why this asserts the property and not a chosen shape. */
    const publish = r.coverage.patterns.find((p) => p.shape === "/org/*/publish");
    expect(publish?.instances).toHaveLength(FORMS.length);
    expect(publish!.visited).toBeLessThan(FORMS.length);

    /* The inventory is complete even where the visiting is not: every form is
       named in some pattern, whether or not every screen was opened. */
    const named = new Set(
      r.coverage.patterns.flatMap((p) => p.instances.map((i) => i.split("/")[2])),
    );
    for (const f of FORMS) expect(named.has(f)).toBe(true);

    expect(r.coverage.skipped.some((s) => s.reason === "shape-already-sampled")).toBe(true);
  });

  it("opens everything when told to sample without limit", async () => {
    const r = await walkSystem(`${BASE}/org/home`, readerFor(repetitiveSystem()), {
      budget: { maxSurfaces: 200, maxDepth: 10, maxDurationMs: 60_000 },
      samplesPerShape: Infinity,
    });
    expect(r.surfaces).toHaveLength(1 + FORMS.length * 4);
  });
});
