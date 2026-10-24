import { noteRequest, rateKey, _resetRateWindow, type RateConfig } from "../rate-window";

const CFG: RateConfig = { windowMs: 10_000, threshold: 5, maxKeys: 3 };

describe("rate-window", () => {
  beforeEach(() => _resetRateWindow());

  it("reports exactly once when a client crosses the threshold in one window", () => {
    const hits = [];
    for (let i = 0; i < 12; i++) hits.push(noteRequest("k", 1_000 + i, CFG));
    const reported = hits.filter(Boolean);
    expect(reported).toHaveLength(1);
    expect(reported[0]).toEqual({ count: 5, windowMs: 10_000, threshold: 5 });
    expect(hits.indexOf(reported[0])).toBe(4);
  });

  it("does not report a client that stays under the threshold", () => {
    for (let i = 0; i < 4; i++) expect(noteRequest("k", 1_000 + i, CFG)).toBeNull();
  });

  it("starts a fresh window after windowMs, so a slow client never accumulates", () => {
    for (let i = 0; i < 4; i++) noteRequest("k", 0, CFG);
    for (let i = 0; i < 4; i++) expect(noteRequest("k", 10_000, CFG)).toBeNull();
  });

  it("can report again in a later window", () => {
    for (let i = 0; i < 5; i++) noteRequest("k", 0, CFG);
    const later = [];
    for (let i = 0; i < 5; i++) later.push(noteRequest("k", 20_000, CFG));
    expect(later.filter(Boolean)).toHaveLength(1);
  });

  it("keeps clients separate", () => {
    for (let i = 0; i < 4; i++) noteRequest("a", 0, CFG);
    expect(noteRequest("b", 0, CFG)).toBeNull();
    expect(noteRequest("a", 0, CFG)).not.toBeNull();
  });

  it("bounds memory by evicting the oldest key", () => {
    for (let i = 0; i < 4; i++) noteRequest("old", 0, CFG);
    noteRequest("x", 1, CFG);
    noteRequest("y", 2, CFG);
    noteRequest("z", 3, CFG); // evicts "old"
    // "old" restarted from zero, so one more request does not cross the threshold.
    expect(noteRequest("old", 4, CFG)).toBeNull();
  });

  it("rateKey is stable, site-scoped, and does not contain the IP", () => {
    const k = rateKey("s1", "203.0.113.9", "curl/8");
    expect(k).toBe(rateKey("s1", "203.0.113.9", "curl/8"));
    expect(k).not.toBe(rateKey("s2", "203.0.113.9", "curl/8"));
    expect(k).not.toContain("203.0.113.9");
    expect(k).toMatch(/^[0-9a-f]{8}$/);
  });
});
