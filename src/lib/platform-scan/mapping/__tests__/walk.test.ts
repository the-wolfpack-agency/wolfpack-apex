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
    const pages: Record<string, Partial<ReadSurface>> = {};
    for (let i = 0; i < 20; i += 1) {
      pages[`${BASE}/p${i}`] = { links: [`${BASE}/p${i + 1}`] };
    }
    pages[`${BASE}/p20`] = {};
    const r = await walkSystem(`${BASE}/p0`, readerFor(pages), {
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
