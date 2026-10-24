/**
 * Protection rollup - counts by action/class, honest empty state, sampleCapped.
 */
import { computeWebProtection, emptyWebProtectionReport, type WebProtectionDeps } from "../rollup";

const deps = (rows: Array<{ class: string; action: string; blocked: boolean }>): WebProtectionDeps => ({
  listInspections: async () => rows as never,
});

it("empty log is an honest all-zero, not capped", async () => {
  const r = await computeWebProtection("w1", deps([]));
  expect(r).toEqual(emptyWebProtectionReport());
});

it("counts by action and counts decoy trips by class", async () => {
  const r = await computeWebProtection("w1", deps([
    { class: "known_agent", action: "welcome", blocked: false },
    { class: "normal", action: "allow", blocked: false },
    { class: "suspicious", action: "report", blocked: false },
    { class: "trapped", action: "report", blocked: false }, // monitor-mode trip: reported, still a decoy trip
    { class: "trapped", action: "block", blocked: true },   // enforce-mode trip
  ]));
  expect(r.inspected).toBe(5);
  expect(r.welcomed).toBe(1);
  expect(r.allowed).toBe(1);
  expect(r.reported).toBe(2); // the suspicious + the monitor-mode trip
  expect(r.blocked).toBe(1);
  expect(r.decoyTrips).toBe(2); // both trapped rows, blocked or not
});

it("flags sampleCapped when the reader returns a full page", async () => {
  const many = Array.from({ length: 1000 }, () => ({ class: "normal", action: "allow", blocked: false }));
  const r = await computeWebProtection("w1", deps(many));
  expect(r.sampleCapped).toBe(true);
});

import { eventToInspection } from "../rollup";

it("maps live site.agent_* events to inspection rows (the repointed source)", () => {
  expect(eventToInspection("site.agent_welcomed", null, false)).toEqual({ class: "known_agent", action: "welcome", blocked: false });
  expect(eventToInspection("site.agent_trap_tripped", null, false)).toEqual({ class: "trapped", action: "report", blocked: false });
  expect(eventToInspection("site.agent_trap_tripped", "report", true)).toEqual({ class: "trapped", action: "block", blocked: true });
  expect(eventToInspection("site.agent_flagged", null, false)).toEqual({ class: "suspicious", action: "report", blocked: false });
  expect(eventToInspection("site.agent_payload_attack", null, true)).toEqual({ class: "suspicious", action: "block", blocked: true });
  expect(eventToInspection("site.page_viewed", null, false)).toEqual({ class: "normal", action: "allow", blocked: false });
});

// Enforcement-era props: a withheld block (props.would_block, watch mode or the
// paid gate) is never counted as a block, and is reported separately.
test("would_block is counted separately and never as a block", async () => {
  const r = await computeWebProtection("w1", {
    listInspections: async () => [
      eventToInspection("site.agent_payload_attack", "block", true),
      eventToInspection("site.agent_payload_attack", "block", false, true),
      eventToInspection("site.agent_flagged", "report", false, true),
      eventToInspection("site.agent_flagged", "report", false),
    ],
  });
  expect(r.blocked).toBe(1);
  expect(r.wouldBlock).toBe(2);
  expect(r.reported).toBe(3);
});

test("eventToInspection marks a withheld block as report + wouldBlock", () => {
  expect(eventToInspection("site.agent_payload_attack", "block", false, true)).toEqual({ class: "suspicious", action: "report", blocked: false, wouldBlock: true });
  // a real block never carries wouldBlock
  expect(eventToInspection("site.agent_payload_attack", "block", true, true)).toEqual({ class: "suspicious", action: "block", blocked: true });
});

test("every agent event type the reader asks for is one the ingest accepts", () => {
  // Drift guard: the reader's list is typed SiteEventType, and every site.agent_*
  // event the ingest accepts (except the rules-reading ones, which are not
  // inspections) is read.
  const { SITE_EVENT_TYPES } = jest.requireActual("@/lib/site-analytics") as typeof import("@/lib/site-analytics");
  const { AGENT_EVENT_TYPES } = jest.requireActual("../rollup") as typeof import("../rollup");
  const read = new Set<string>(AGENT_EVENT_TYPES);
  for (const t of SITE_EVENT_TYPES) {
    if (!t.startsWith("site.agent_") || t === "site.agent_read_robots" || t === "site.agent_read_sitemap") continue;
    expect(read.has(t)).toBe(true);
    expect(eventToInspection(t, null, false).class).not.toBe("normal");
  }
});
