/**
 * related-pages — keyword → Instinct route map.
 *
 * These tests pin the contract the /api/assistant route ships to the
 * client: every domain the user's question mentions surfaces as a
 * chip-link, deduped by href, and the "From Microsoft 365 · your
 * calendar" style attribution line stays wired to the right intent.
 */

import {
  detectRelatedPages,
  detectRelatedPagesFromExchange,
  sourceLabelForIntent,
} from "../related-pages";

describe("detectRelatedPages", () => {
  test("returns [] for empty input", () => {
    expect(detectRelatedPages("")).toEqual([]);
    expect(detectRelatedPages("   ")).toEqual([]);
  });

  test("detects calendar + meetings together", () => {
    const hits = detectRelatedPages("Do I have any meetings on my calendar tomorrow?");
    const domains = hits.map((h) => h.domain);
    expect(domains).toContain("calendar");
    expect(domains).toContain("meetings");
  });

  test("detects contacts/people from either phrasing", () => {
    expect(detectRelatedPages("show me my contacts").map((h) => h.domain)).toContain("people");
    expect(detectRelatedPages("who are the people on my team").map((h) => h.domain)).toContain(
      "people",
    );
  });

  test("detects OKRs + goals as the same /goals chip", () => {
    const hits = detectRelatedPages("What is the status of our OKRs and goals?");
    const goalsHits = hits.filter((h) => h.domain === "goals");
    // Dedup by href: at most one /goals chip regardless of how many
    // keywords matched.
    expect(goalsHits.length).toBe(1);
    expect(goalsHits[0].href).toBe("/goals");
  });

  test("detects HR/employees domain", () => {
    const hits = detectRelatedPages("Which employees have benefits enrollment pending?");
    const domains = hits.map((h) => h.domain);
    expect(domains).toContain("hr");
  });

  test("detects financials + features + clients in one query", () => {
    const hits = detectRelatedPages(
      "What revenue did we book from clients who filed feature requests?",
    );
    const domains = hits.map((h) => h.domain);
    expect(domains).toContain("financials");
    expect(domains).toContain("clients");
    expect(domains).toContain("features");
  });

  test("word-boundary: 'emailserver' does NOT trigger emails", () => {
    const hits = detectRelatedPages("emailserver configuration for the team");
    const domains = hits.map((h) => h.domain);
    expect(domains).not.toContain("emails");
  });

  test("returns chips with absolute href + non-empty label", () => {
    const hits = detectRelatedPages("check my calendar today");
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) {
      expect(h.href.startsWith("/")).toBe(true);
      expect(h.label.length).toBeGreaterThan(0);
      expect(h.domain.length).toBeGreaterThan(0);
    }
  });

  test("returns [] when nothing matches the app domains", () => {
    expect(detectRelatedPages("Tell me a joke about ducks")).toEqual([]);
  });
});

describe("detectRelatedPagesFromExchange — hit-count scoring", () => {
  test("settings wins over calendar when the response is about Settings (regression from 2026-04-23 screenshot)", () => {
    // User asked about MS 365. Answer mentions Settings + Integrations
    // repeatedly, calendar only in passing ("calendar events"). The
    // primary link MUST be Settings, not Calendar.
    const q = "how do I connect my account to MS 365?";
    const r =
      "Go to Settings in the sidebar. Under Integrations, you can connect your Microsoft 365 account to get calendar events, email highlights, and meeting prep in your Morning Briefing. Click Connect Microsoft 365 and sign in. You can disconnect at any time from the same Settings page.";
    const ordered = detectRelatedPagesFromExchange(q, r);
    expect(ordered[0]?.domain).toBe("settings");
    // Settings ahead of calendar regardless of where they live in the
    // DOMAIN_MAP source order.
    const settingsIdx = ordered.findIndex((p) => p.domain === "settings");
    const calendarIdx = ordered.findIndex((p) => p.domain === "calendar");
    if (settingsIdx !== -1 && calendarIdx !== -1) {
      expect(settingsIdx).toBeLessThan(calendarIdx);
    }
  });

  test("response hits count 3x more than question hits (so answer's subject wins)", () => {
    // Question names Calendar once; response names Settings many
    // times. Settings should still top the list.
    const q = "calendar question";
    const r = "settings settings settings settings";
    const ordered = detectRelatedPagesFromExchange(q, r);
    expect(ordered[0]?.domain).toBe("settings");
  });

  test("unrelated domains are excluded, only matching domains returned", () => {
    const ordered = detectRelatedPagesFromExchange(
      "Tell me about Calendar",
      "Calendar shows meetings.",
    );
    const domains = ordered.map((p) => p.domain);
    expect(domains).toContain("calendar");
    expect(domains).not.toContain("settings");
  });
});

describe("sourceLabelForIntent", () => {
  test("calendar intents attribute to Microsoft 365", () => {
    expect(sourceLabelForIntent("calendar_availability")).toContain("Microsoft 365");
    expect(sourceLabelForIntent("calendar_schedule")).toContain("Microsoft 365");
  });

  test("mail search attributes to mailbox", () => {
    expect(sourceLabelForIntent("mail_search")).toContain("mailbox");
  });

  test("goals / financials / brain stay inside Instinct", () => {
    expect(sourceLabelForIntent("goals_lookup")).toContain("Instinct");
    expect(sourceLabelForIntent("financials_metric")).toContain("Instinct");
    expect(sourceLabelForIntent("brain_history")).toContain("Brain");
  });

  test("unknown intent falls back to Instinct", () => {
    expect(sourceLabelForIntent("totally-not-a-real-intent")).toBe("From Instinct");
  });
});
