/**
 * The case file must read like a report a non-engineer can follow: contiguous
 * lead-up -> hostile action -> aftermath bands, a plain sentence per step, and
 * honest severities. Pure + deterministic.
 */
import { buildActionLog, PHASE_LABEL } from "@/lib/agent-action-log";
import type { JourneyStep } from "@/lib/agent-behavior";

const step = (at: string, path: string, signal: JourneyStep["signal"], attack?: string): JourneyStep => ({ at, path, signal, ...(attack ? { attack } : {}) });

describe("buildActionLog", () => {
  it("groups steps into contiguous lead-up / hostile / aftermath bands around the incident", () => {
    const log = buildActionLog([
      step("2026-09-20T10:00:00Z", "/robots.txt", "read_robots"),
      step("2026-09-20T10:00:04Z", "/faq", null),
      step("2026-09-20T10:00:09Z", "/wp-login.php", "probed_sensitive"),
      step("2026-09-20T10:00:12Z", "/trap", "tripped_decoy"),
      step("2026-09-20T10:00:20Z", "/", null),
    ]);
    expect(log.map((e) => e.phase)).toEqual(["lead_up", "lead_up", "hostile_act", "hostile_act", "aftermath"]);
  });

  it("writes a plain sentence and honest severity for each signal", () => {
    const [robots] = buildActionLog([step("2026-09-20T10:00:00Z", "/robots.txt", "read_robots")]);
    expect(robots.severity).toBe("info");
    expect(robots.detail).toMatch(/off-limits|rules/i);

    const [decoy] = buildActionLog([step("2026-09-20T10:00:00Z", "/trap", "tripped_decoy")]);
    expect(decoy.severity).toBe("hostile");
    expect(decoy.detail).toMatch(/invisible trap link|real person can never see/i);

    const [payload] = buildActionLog([step("2026-09-20T10:00:00Z", "/api", "payload_attack", "sql_injection")]);
    expect(payload.severity).toBe("hostile");
    expect(payload.detail).toMatch(/sql injection/i); // underscores humanized
  });

  it("computes a wall clock and elapsed delta (start, then +Ns/+Nm)", () => {
    const log = buildActionLog([
      step("2026-09-20T10:00:00Z", "/a", null),
      step("2026-09-20T10:00:05Z", "/b", null),
      step("2026-09-20T10:02:05Z", "/c", null),
    ]);
    expect(log[0].delta).toBe("start");
    expect(log[1].delta).toBe("+5s");
    expect(log[2].delta).toBe("+2m");
    expect(log[0].clock).toBe("10:00:00");
  });

  it("carries an explicit UTC date + day key so a multi-day journey is unambiguous", () => {
    const log = buildActionLog([
      step("2026-09-20T23:59:00Z", "/a", null),
      step("2026-09-21T00:10:00Z", "/b", "probed_sensitive"), // crosses midnight
    ]);
    expect(log[0].date).toBe("20 Sep 2026");
    expect(log[0].dayKey).toBe("2026-09-20");
    expect(log[1].date).toBe("21 Sep 2026");
    expect(log[1].dayKey).toBe("2026-09-21");
    expect(log[0].dayKey).not.toBe(log[1].dayKey);
  });

  it("labels everything lead-up when there is no hostile act", () => {
    const log = buildActionLog([
      step("2026-09-20T10:00:00Z", "/robots.txt", "read_robots"),
      step("2026-09-20T10:00:03Z", "/faq", "identified_agent"),
    ]);
    expect(log.every((e) => e.phase === "lead_up")).toBe(true);
    expect(log[1].severity).toBe("good");
  });

  it("returns nothing for an empty trace", () => {
    expect(buildActionLog([])).toEqual([]);
    expect(PHASE_LABEL.hostile_act).toMatch(/hostile/i);
  });
});
