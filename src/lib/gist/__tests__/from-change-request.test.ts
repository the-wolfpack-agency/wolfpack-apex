/**
 * Reading a client's change history without reading their change history.
 *
 * WHY THIS SOURCE. Mapping 11,997 of our own assistant turns, 93 per cent end
 * "unknown": a single-turn conversation means satisfied or gave up and nothing
 * can tell which. A change request states its outcome, because a person
 * approved it, rejected it, or approved it and reversed it later. Outcome
 * labels are the scarce input for everything the gist wants to do.
 *
 * WE DO NOT KNOW THEIR SCHEMA. Every forms system is configured per
 * organisation, so this detects candidate columns and shows what it detected,
 * rather than guessing silently and producing a confident number from the
 * wrong column.
 */

import {
  detectColumns,
  endingFromStatus,
  readChangeRequests,
} from "@/lib/gist/from-change-request";

describe("finding the columns without being told", () => {
  it("prefers an exact name over a partial one", () => {
    const m = detectColumns(["Number", "Approval Status", "Status", "Submitted"]);
    expect(m.status).toBe("Status");
  });

  it("falls back to a partial match", () => {
    expect(detectColumns(["Number", "Workflow Stage"]).status).toBe("Workflow Stage");
  });

  it("finds the dates and the type", () => {
    const m = detectColumns(["Request Type", "Submitted", "Completed", "State"]);
    expect(m.category).toBe("Request Type");
    expect(m.created).toBe("Submitted");
    expect(m.decided).toBe("Completed");
    expect(m.status).toBe("State");
  });

  /* Says NOT FOUND rather than picking something plausible: a status read from
     the wrong column produces a confident and entirely wrong answer. */
  it("reports nothing rather than guessing when no column fits", () => {
    expect(detectColumns(["Colour", "Height", "Weight"]).status).toBeNull();
  });
});

describe("mapping a status to an ending", () => {
  it.each([
    ["Approved", "accepted"],
    ["Completed", "accepted"],
    ["Rejected", "rejected"],
    ["Denied", "rejected"],
    ["Reversed", "reversed"],
    ["Rolled back", "reversed"],
    ["Cancelled", "abandoned"],
    ["Pending", "pending"],
    ["In Review", "pending"],
  ])("reads %s as %s", (status, ending) => {
    expect(endingFromStatus(status)).toEqual({ ending, recognised: true });
  });

  /* MATCHED WHOLE, NOT PARTIAL. "Approval Pending" contains "approv" and is
     the OPPOSITE of approved; a substring match would invert it. */
  it("does not read Approval Pending as approved", () => {
    expect(endingFromStatus("Approval Pending").ending).not.toBe("accepted");
  });

  /* AN UNRECOGNISED STATUS IS ANNOUNCED, never quietly bucketed. Four of the
     product's own answer sources spent weeks collapsing into "other" and
     nothing said so. */
  it("flags a status it does not know", () => {
    expect(endingFromStatus("Escalated to Legal")).toEqual({
      ending: "unknown",
      recognised: false,
    });
  });
});

describe("reading an export", () => {
  const columns = {
    status: "Status",
    created: "Submitted",
    decided: "Completed",
    category: "Request Type",
  };

  it("reads decisions and reports what it could not map", () => {
    const r = readChangeRequests(
      [
        { Status: "Approved", Submitted: "2026-08-01", Completed: "2026-08-02", "Request Type": "Pricing" },
        { Status: "Reversed", Submitted: "2026-08-01", Completed: "2026-08-09", "Request Type": "Access" },
        { Status: "Escalated to Legal", Submitted: "2026-08-05", Completed: "", "Request Type": "Access" },
      ],
      columns,
    );
    expect(r.gists).toHaveLength(3);
    expect(r.unmapped).toEqual([{ status: "Escalated to Legal", count: 1 }]);
  });

  /* A REJECTION IS THE PROCESS WORKING. A system that learned to approve
     everything in order to score well would be actively dangerous. */
  it("counts a rejection as having gone well", () => {
    const r = readChangeRequests([{ Status: "Rejected" }], { ...columns, created: null, decided: null, category: null });
    expect(r.gists[0].wentWell).toBe(true);
  });

  it("counts a reversal as having gone badly", () => {
    const r = readChangeRequests([{ Status: "Reversed" }], { ...columns, created: null, decided: null, category: null });
    expect(r.gists[0].wentWell).toBe(false);
  });

  /* A made-up duration is indistinguishable from a real one in the output. */
  it("claims no latency when a date is missing or unparseable", () => {
    const r = readChangeRequests(
      [
        { Status: "Approved", Submitted: "2026-08-01", Completed: "", "Request Type": "x" },
        { Status: "Approved", Submitted: "not a date", Completed: "also not", "Request Type": "x" },
      ],
      columns,
    );
    expect(r.gists.every((g) => g.latency === "instant")).toBe(true);
  });

  it("measures a real duration when both ends parse", () => {
    const r = readChangeRequests(
      [{ Status: "Approved", Submitted: "2026-08-01", Completed: "2026-08-09", "Request Type": "x" }],
      columns,
    );
    expect(r.gists[0].latency).toBe("longer");
  });

  it("skips a row with no status rather than inventing one", () => {
    const r = readChangeRequests([{ Status: "", "Request Type": "x" }], columns);
    expect(r.gists).toHaveLength(0);
    expect(r.skipped).toBe(1);
  });

  /* NOTHING THE FORM SAID SURVIVES. */
  it("carries no free text out of the export", () => {
    const r = readChangeRequests(
      [
        {
          Status: "Approved",
          Submitted: "2026-08-01",
          Completed: "2026-08-02",
          "Request Type": "Pricing",
          Description: "Raise Hector Hernandez's commission at Porsche Monmouth",
        },
      ],
      columns,
    );
    const serialised = JSON.stringify(r.gists);
    expect(serialised).not.toContain("Hernandez");
    expect(serialised).not.toContain("Monmouth");
    expect(serialised).not.toContain("commission");
  });
});
