/**
 * Harness DB-orchestration tests with an in-memory query() mock (recognizes the
 * specific SQL statements). Proves the full public-tool lifecycle without a real
 * database: create -> record hits (with the cap + expiry gates) -> read (which
 * captures ONE idempotent sighting into learning).
 */

interface SessionRec { id: string; goal: string; agent_label: string; expiresAt: number; hit_count: number; sighting_recorded: boolean; operator_key: string | null; }
interface HitRec { session_id: string; path: string; method: string; status: number; event_type: string | null; seen_at: string; }

const sessions = new Map<string, SessionRec>();
const hits: HitRec[] = [];
let nowMs = Date.parse("2026-09-19T00:00:00Z");
let seq = 0;

const mockRecordSighting = jest.fn(async () => "op_deadbeef");

jest.mock("@/lib/agent-operators", () => ({ recordSighting: mockRecordSighting }));

jest.mock("@/lib/db", () => ({
  query: jest.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes("INSERT INTO instinct_harness_sessions")) {
      const [id, goal, agent_label] = params as string[];
      sessions.set(id, { id, goal, agent_label, expiresAt: nowMs + 30 * 60000, hit_count: 0, sighting_recorded: false, operator_key: null });
      return { rows: [{ expires_at: new Date(nowMs + 30 * 60000).toISOString() }] };
    }
    if (sql.includes("FROM instinct_harness_sessions WHERE id")) {
      const s = sessions.get((params as string[])[0]);
      if (!s) return { rows: [] };
      return { rows: [{ id: s.id, goal: s.goal, agent_label: s.agent_label, hit_count: s.hit_count, sighting_recorded: s.sighting_recorded, expired: s.expiresAt < nowMs }] };
    }
    if (sql.includes("INSERT INTO instinct_harness_hits")) {
      const [session_id, path, method, status, event_type] = params as [string, string, string, number, string | null];
      hits.push({ session_id, path, method, status, event_type, seen_at: new Date(nowMs + seq++).toISOString() });
      return { rows: [] };
    }
    if (sql.includes("SET hit_count = hit_count + 1")) {
      const s = sessions.get((params as string[])[0]); if (s) s.hit_count++;
      return { rows: [] };
    }
    if (sql.includes("FROM instinct_harness_hits WHERE session_id")) {
      const sid = (params as string[])[0];
      return { rows: hits.filter((h) => h.session_id === sid).map((h) => ({ path: h.path, method: h.method, status: h.status, event_type: h.event_type, seen_at: h.seen_at })) };
    }
    if (sql.includes("SET sighting_recorded = true")) {
      const [id, opKey] = params as [string, string]; const s = sessions.get(id); if (s) { s.sighting_recorded = true; s.operator_key = opKey; }
      return { rows: [] };
    }
    return { rows: [] };
  }),
}));

import { createHarnessSession, recordHarnessHit, getHarnessReading, HARNESS_MAX_HITS } from "@/lib/harness/harness";
import { SANDBOX_TRAP_PATH } from "@/lib/harness/sandbox";

const BASE = "https://apex.test/harness/hs_x";

beforeEach(() => { sessions.clear(); hits.length = 0; seq = 0; nowMs = Date.parse("2026-09-19T00:00:00Z"); mockRecordSighting.mockClear(); });

describe("harness lifecycle (DB-orchestration, mocked store)", () => {
  it("creates a session, records a crawl, and reads a proven-hostile dossier", async () => {
    const s = await createHarnessSession({ goal: "find admin", agentLabel: "gpt + custom" });
    expect(s.id).toMatch(/^hs_/);

    for (const [p] of [["/"], ["/pricing"], [SANDBOX_TRAP_PATH]] as const) {
      const r = await recordHarnessHit({ sessionId: s.id, relPath: p, method: "GET", base: BASE });
      expect(r.ok).toBe(true);
    }
    const reading = await getHarnessReading(s.id, "public-harness");
    expect(reading.ok).toBe(true);
    if (reading.ok) {
      expect(reading.reading.journey.behaviorClass).toBe("aggressive_scraper");
      expect(reading.reading.dossier.threatLevel).toBe("hostile");
      expect(reading.reading.hitCount).toBe(3);
    }
  });

  it("captures exactly one sighting into learning, even across repeated reads (idempotent)", async () => {
    const s = await createHarnessSession({});
    await recordHarnessHit({ sessionId: s.id, relPath: "/", method: "GET", base: BASE });
    await getHarnessReading(s.id, "public-harness");
    await getHarnessReading(s.id, "public-harness");
    await getHarnessReading(s.id, "public-harness");
    expect(mockRecordSighting).toHaveBeenCalledTimes(1);
    expect(sessions.get(s.id)?.operator_key).toBe("op_deadbeef");
  });

  it("does not capture a sighting for a session with zero hits", async () => {
    const s = await createHarnessSession({});
    await getHarnessReading(s.id, "public-harness");
    expect(mockRecordSighting).not.toHaveBeenCalled();
  });

  it("rejects an unknown session (404 sandbox response), records nothing", async () => {
    const r = await recordHarnessHit({ sessionId: "hs_nope", relPath: "/", method: "GET", base: BASE });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("unknown");
    expect(hits).toHaveLength(0);
  });

  it("rejects hits after expiry (410) and after the hard hit cap (429)", async () => {
    const s = await createHarnessSession({});
    // expiry
    nowMs += 31 * 60000;
    const exp = await recordHarnessHit({ sessionId: s.id, relPath: "/", method: "GET", base: BASE });
    expect(exp.ok).toBe(false);
    if (!exp.ok) { expect(exp.reason).toBe("expired"); expect(exp.response.status).toBe(410); }
    // cap: reset time, force the count to the cap
    nowMs -= 31 * 60000;
    sessions.get(s.id)!.hit_count = HARNESS_MAX_HITS;
    const capped = await recordHarnessHit({ sessionId: s.id, relPath: "/", method: "GET", base: BASE });
    expect(capped.ok).toBe(false);
    if (!capped.ok) { expect(capped.reason).toBe("capped"); expect(capped.response.status).toBe(429); }
  });

  it("records a filled honeypot on a POST as a form-honeypot event", async () => {
    const s = await createHarnessSession({});
    await recordHarnessHit({ sessionId: s.id, relPath: "/login", method: "POST", base: BASE, honeypotTripped: true });
    expect(hits[0].event_type).toBe("site.agent_form_honeypot");
  });
});
