/**
 * Tests for inbox-poller — the pure helpers (filter + source-type
 * detection). Full Graph round-trip is exercised via the API route
 * test which mocks the listMailDelta call.
 */

import { messageMatchesAutomation, detectSourceType } from "@/lib/automations/inbox-poller";
import type { AutomationDefinition } from "@/lib/automations/types";

const automation: AutomationDefinition = {
  id: "porsche-classes",
  name: "test",
  owner_label: "x",
  description: "x",
  active_window_days: { min: 0, max: 30 },
  inbox_filters: {
    sender_match: ["porsche-academy-notification@porsche.de"],
    subject_match: ["Scheduled Report Notification"],
  },
  parsers: { porsche_xlsx: jest.fn() as never },
};

describe("messageMatchesAutomation", () => {
  it("matches when sender + subject substrings both hit", () => {
    const m = {
      id: "1",
      from: { emailAddress: { address: "porsche-academy-notification@porsche.de" } },
      subject: "Scheduled Report Notification: Daily",
    };
    expect(messageMatchesAutomation(m, automation)).toBe(true);
  });

  it("rejects when sender substring miss", () => {
    const m = {
      id: "1",
      from: { emailAddress: { address: "spam@elsewhere.com" } },
      subject: "Scheduled Report Notification",
    };
    expect(messageMatchesAutomation(m, automation)).toBe(false);
  });

  it("rejects when subject substring miss", () => {
    const m = {
      id: "1",
      from: { emailAddress: { address: "porsche-academy-notification@porsche.de" } },
      subject: "Holiday party invite",
    };
    expect(messageMatchesAutomation(m, automation)).toBe(false);
  });

  it("matches case-insensitively", () => {
    const m = {
      id: "1",
      from: { emailAddress: { address: "PORSCHE-ACADEMY-NOTIFICATION@PORSCHE.DE" } },
      subject: "scheduled report notification",
    };
    expect(messageMatchesAutomation(m, automation)).toBe(true);
  });

  it("matches when filters are empty (everything passes)", () => {
    const a = { ...automation, inbox_filters: {} };
    expect(messageMatchesAutomation({ id: "1", subject: "anything" }, a)).toBe(true);
  });
});

describe("detectSourceType", () => {
  it("returns porsche_xlsx for .xlsx + spreadsheet mime", () => {
    expect(
      detectSourceType(
        "report.xlsx",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        automation,
      ),
    ).toBe("porsche_xlsx");
  });

  it("returns porsche_xlsx for .csv + text/csv", () => {
    expect(detectSourceType("report.csv", "text/csv", automation)).toBe("porsche_xlsx");
  });

  it("returns null when filename is unrecognized", () => {
    expect(detectSourceType("README.md", "text/markdown", automation)).toBeNull();
  });

  it("returns null when porsche_xlsx parser is not registered", () => {
    const a: AutomationDefinition = { ...automation, parsers: {} };
    expect(detectSourceType("report.xlsx", "spreadsheet", a)).toBeNull();
  });
});
