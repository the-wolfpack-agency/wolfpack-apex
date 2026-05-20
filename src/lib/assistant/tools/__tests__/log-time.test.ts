/**
 * Tests for log-time intent matcher.
 */

import { matchLogTimeIntent } from "@/lib/assistant/tools/log-time";

describe("matchLogTimeIntent", () => {
  it("matches the four trigger stems", () => {
    expect(matchLogTimeIntent("log time")).toEqual({});
    expect(matchLogTimeIntent("/log time")).toEqual({});
    expect(matchLogTimeIntent("log hours")).toEqual({});
    expect(matchLogTimeIntent("track time")).toEqual({});
    expect(matchLogTimeIntent("time entry")).toEqual({});
  });

  it("does not match unrelated phrases", () => {
    expect(matchLogTimeIntent("show me time")).toBeNull();
    expect(matchLogTimeIntent("what time is it")).toBeNull();
    expect(matchLogTimeIntent("")).toBeNull();
  });

  it("prefills hours from 'Nh' / 'N hours'", () => {
    expect(matchLogTimeIntent("log time 1.5h")).toEqual({ hours: 1.5 });
    expect(matchLogTimeIntent("log hours 3 hours")).toEqual({ hours: 3 });
  });

  it("prefills job_code from 'on/for/to <CODE>'", () => {
    expect(matchLogTimeIntent("log time 2h on WOLFPACK-AUTO")).toEqual({ hours: 2, job_code: "WOLFPACK-AUTO" });
    expect(matchLogTimeIntent("track time for CLIENT-ACME")).toEqual({ job_code: "CLIENT-ACME" });
  });
});
