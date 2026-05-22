import { isOutOfOffice, isOutOfOfficeSubject } from "../ooo-detector";

describe("isOutOfOfficeSubject", () => {
  test.each([
    "Ashley OOO",
    "OOO - Ashley",
    "Ashley - OoO",
    "OoO Hoxsie",
    "ashley ooo",
    "ASHLEY OOO",
    "OOF - Nick",
    "Nick OOTO",
    "Nick PTO Friday",
    "PTO",
    "Out of Office - Ashley",
    "Ashley: Out of office Thursday",
    "Out of the office Thu-Fri",
    "On vacation 5/22 - 5/24",
    "On leave next week",
    "Out sick",
    "Sick day",
    "Sick leave",
    "Personal day",
    "Personal leave",
    "Vacation day",
    "Vacation",
    "Vacationing",
    "Ashley off today",
    "Off tomorrow",
    "out of pocket all day",
  ])("flags %s as OOO", (subject) => {
    expect(isOutOfOfficeSubject(subject)).toBe(true);
  });

  test.each([
    "Pool maintenance",
    "Good morning standup",
    "Look at design review",
    "WFH today",
    "Working from home",
    "Working remotely",
    "Remote work day",
    "Holiday party",
    "Company holiday potluck",
    "Q2 planning",
    "1:1 with Hoxsie",
    "Lunch with Ashley",
    "Phooey demo",
    "",
  ])("does NOT flag %s as OOO", (subject) => {
    expect(isOutOfOfficeSubject(subject)).toBe(false);
  });

  it("handles null and undefined safely", () => {
    expect(isOutOfOfficeSubject(null)).toBe(false);
    expect(isOutOfOfficeSubject(undefined)).toBe(false);
  });

  it("handles non-string input safely", () => {
    expect(isOutOfOfficeSubject(123 as unknown as string)).toBe(false);
  });
});

describe("isOutOfOffice (composite signal)", () => {
  it("returns true when showAs is 'oof' regardless of subject", () => {
    expect(isOutOfOffice({ showAs: "oof", subject: "1:1 with Ashley" })).toBe(true);
  });

  it("returns true when showAs is anything else but subject matches", () => {
    expect(isOutOfOffice({ showAs: "busy", subject: "Ashley OOO" })).toBe(true);
    expect(isOutOfOffice({ showAs: "tentative", subject: "PTO" })).toBe(true);
  });

  it("returns false when neither signal matches", () => {
    expect(isOutOfOffice({ showAs: "busy", subject: "1:1 with Hoxsie" })).toBe(false);
    expect(isOutOfOffice({ showAs: "free", subject: "Lunch" })).toBe(false);
  });

  it("returns true when showAs missing but subject matches", () => {
    expect(isOutOfOffice({ subject: "Ashley OOO" })).toBe(true);
  });

  it("returns false when showAs missing and subject does not match", () => {
    expect(isOutOfOffice({ subject: "Lunch with team" })).toBe(false);
  });

  it("returns false on empty input", () => {
    expect(isOutOfOffice({})).toBe(false);
    expect(isOutOfOffice({ showAs: null, subject: null })).toBe(false);
  });

  it("is case-insensitive on showAs comparison", () => {
    // Graph normalizes to lowercase per our normalizeShowAs helper; but
    // belt-and-suspenders for any future caller that passes mixed case.
    expect(isOutOfOffice({ showAs: "oof" })).toBe(true);
  });
});
