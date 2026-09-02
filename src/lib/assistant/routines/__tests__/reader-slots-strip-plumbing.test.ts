/** @jest-environment node */
/**
 * A model step never narrates machine plumbing.
 *
 * THE DEFECT THIS PINS. A routine gathers a tool's structured output into a
 * slot and, for a model step, stringifies the whole object into the prompt.
 * The model is told to "name the meeting, the message, the number" and it
 * faithfully reads back whatever it was handed. In a client-facing morning
 * brief that included a raw "Meeting ID: AAMkAG..." and a 'cache status: miss',
 * printed into prose a person reads.
 *
 * The fix strips plumbing from the slot before a MODEL step sees it, and leaves
 * a TOOL step's slot untouched, because the next tool needs the id the last one
 * returned. These tests hold both halves, plus the precision boundary: it must
 * remove meetingId without removing words that merely end in the letters "id".
 */

import { interpolate, stripPlumbing } from "../slots";

/** A meeting slot shaped like what the prebrief tool actually returns. */
const meetingSlot = {
  meeting: {
    id: "AAMkAGVmZjEwMTM3LWRl...opaque...=",
    meetingId: "AAMkAGVmZjEwMTM3LWRl...opaque...=",
    title: "Q3 planning with Dana",
    startsAt: "2026-09-03T15:00:00Z",
    attendees: ["dana@example.com"],
    cacheStatus: "miss",
    prebrief: { cache: "miss", to_entity_id: "9f2c...", goalTitle: "Ship Phase 1" },
  },
};

describe("a model step's view of a slot", () => {
  it("strips the opaque meeting id a person must never see", () => {
    const out = interpolate("brief: {{meeting}}", meetingSlot, { forReader: true });
    expect(out).not.toContain("AAMkAG");
    expect(out).not.toMatch(/meetingId|"id"/);
  });

  it("strips the cache status that leaked as 'cache status: miss'", () => {
    const out = interpolate("brief: {{meeting}}", meetingSlot, { forReader: true });
    expect(out.toLowerCase()).not.toContain("cachestatus");
    expect(out.toLowerCase()).not.toContain('"cache"');
  });

  it("keeps everything a person actually reads", () => {
    const out = interpolate("brief: {{meeting}}", meetingSlot, { forReader: true });
    expect(out).toContain("Q3 planning with Dana");
    expect(out).toContain("dana@example.com");
    expect(out).toContain("Ship Phase 1");
  });

  it("strips a foreign key nested deep in the object", () => {
    /* A bare whole-object reference returns the value with its type intact, so
       it comes back as an object; stringify to inspect what a model would be
       handed if this fed a text prompt. */
    const out = interpolate("{{meeting}}", meetingSlot, { forReader: true });
    const asText = JSON.stringify(out);
    expect(asText).not.toContain("to_entity_id");
    expect(asText).not.toContain("9f2c");
  });
});

describe("a tool step keeps full fidelity", () => {
  /* THE OTHER HALF. Strip a tool step's slot and the next tool loses the id it
     needs to act on the last one's result. Full fidelity is correct there. */
  it("leaves the id in place when the slot feeds a tool", () => {
    const out = interpolate({ target: "{{meeting}}" }, meetingSlot) as { target: unknown };
    expect(JSON.stringify(out.target)).toContain("meetingId");
    expect(JSON.stringify(out.target)).toContain("AAMkAG");
  });

  /* An explicit field reference is intent: if a routine asks for {{x.id}} by
     name, it gets it, reader-facing or not. */
  it("honours an explicit id field reference even for a reader", () => {
    const out = interpolate("ref {{m.id}}", { m: { id: "TICKET-42", title: "x" } }, { forReader: true });
    expect(out).toBe("ref TICKET-42");
  });
});

describe("the id match is precise, not greedy", () => {
  const sample = {
    paid: true,
    valid: "yes",
    android: "n/a",
    pyramid: 3,
    overpaid: false,
    userId: "u_123",
    order_id: "o_9",
    id: "top-level",
  };

  it("removes real identifiers", () => {
    const kept = stripPlumbing(sample) as Record<string, unknown>;
    expect(kept).not.toHaveProperty("userId");
    expect(kept).not.toHaveProperty("order_id");
    expect(kept).not.toHaveProperty("id");
  });

  it("keeps ordinary words that merely end in the letters 'id'", () => {
    const kept = stripPlumbing(sample) as Record<string, unknown>;
    expect(kept).toMatchObject({ paid: true, valid: "yes", android: "n/a", pyramid: 3, overpaid: false });
  });
});
