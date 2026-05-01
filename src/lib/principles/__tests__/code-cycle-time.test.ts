/* eslint-disable @typescript-eslint/no-explicit-any */
import { evaluateCodeCycleTime } from "@/lib/principles/evaluators/code-cycle-time";

const ORIG_FETCH = global.fetch;
const ORIG_ENV = { ...process.env };
afterEach(() => {
  global.fetch = ORIG_FETCH;
});
afterAll(() => {
  process.env = ORIG_ENV;
});

describe("evaluateCodeCycleTime", () => {
  test("no GH_PAT → []", async () => {
    delete process.env.GH_PAT;
    const out = await evaluateCodeCycleTime({
      windowStart: "x",
      windowEnd: "y",
      subjectUserId: "u1",
    });
    expect(out).toEqual([]);
  });
  test("merged PR within window + under threshold → +0.5", async () => {
    process.env.GH_PAT = "ghp_test";
    process.env.PRINCIPLES_CODE_REPO = "wp/repo";
    /* 24h cycle — well under default 48h threshold. */
    const created = "2026-04-28T09:00:00Z";
    const merged = "2026-04-29T09:00:00Z";
    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => [
        { number: 1, html_url: "u", title: "t", created_at: created, merged_at: merged, closed_at: merged },
      ],
    })) as any;
    const out = await evaluateCodeCycleTime({
      windowStart: "2026-04-28T00:00:00Z",
      windowEnd: "2026-04-30T00:00:00Z",
      subjectUserId: "u1",
    });
    expect(out).toHaveLength(1);
    expect(out[0].score).toBe(0.5);
    expect(out[0].surface).toBe("code");
    expect((out[0].evidence as any).metric.value).toBeCloseTo(24, 1);
  });
  test("PR outside window is skipped", async () => {
    process.env.GH_PAT = "ghp_test";
    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => [
        {
          number: 1,
          html_url: "u",
          title: "old",
          created_at: "2020-01-01T00:00:00Z",
          merged_at: "2020-01-02T00:00:00Z",
          closed_at: "2020-01-02T00:00:00Z",
        },
      ],
    })) as any;
    const out = await evaluateCodeCycleTime({
      windowStart: "2026-04-28T00:00:00Z",
      windowEnd: "2026-04-30T00:00:00Z",
      subjectUserId: "u1",
    });
    expect(out).toEqual([]);
  });
  test("PR over threshold → -0.5", async () => {
    process.env.GH_PAT = "ghp_test";
    /* 96h cycle = 4 days = > 48h. */
    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => [
        {
          number: 2,
          html_url: "u",
          title: "slow",
          created_at: "2026-04-25T00:00:00Z",
          merged_at: "2026-04-29T00:00:00Z",
          closed_at: "2026-04-29T00:00:00Z",
        },
      ],
    })) as any;
    const out = await evaluateCodeCycleTime({
      windowStart: "2026-04-25T00:00:00Z",
      windowEnd: "2026-04-30T00:00:00Z",
      subjectUserId: "u1",
    });
    expect(out).toHaveLength(1);
    expect(out[0].score).toBe(-0.5);
  });
  test("API non-200 → []", async () => {
    process.env.GH_PAT = "ghp_test";
    global.fetch = jest.fn(async () => ({
      ok: false,
      status: 403,
      json: async () => ({}),
    })) as any;
    const out = await evaluateCodeCycleTime({
      windowStart: "x",
      windowEnd: "y",
      subjectUserId: "u1",
    });
    expect(out).toEqual([]);
  });
});
