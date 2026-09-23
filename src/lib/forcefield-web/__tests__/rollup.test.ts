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
