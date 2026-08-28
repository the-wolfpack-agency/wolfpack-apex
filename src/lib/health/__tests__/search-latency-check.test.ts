/**
 * A new integration earns its place in the fan-out only if it answers in time.
 *
 * WHY THIS IS A CONTROL. Connecting a client's systems and answering across
 * them is the product, so every source added widens what we can answer AND
 * joins a fan-out where the slowest provider IS the search, because they run
 * at once. Each new connection therefore carries a latency risk that lands on
 * every question, not only the ones it answers.
 *
 * Measured over seven days of production traffic, Teams channels ran at
 * 22,181ms p95 against a 6,000ms budget while all eight other providers sat
 * inside it. It made the whole product feel broken and nobody attributed it
 * until a person complained about a twenty-second wait. #503 stopped a slow
 * provider holding the rest up. This is the other half: noticing.
 */
import {
  checkSearchLatency,
  MIN_CALLS_FOR_VERDICT,
} from "@/lib/health/search-latency-check";
import { PROVIDER_BUDGET_MS } from "@/lib/search/runSearch";

const mockQuery = jest.fn();
jest.mock("@/lib/db", () => ({ query: (...a: unknown[]) => mockQuery(...a) }));
jest.mock("@/lib/health/integration-probes", () => ({
  persistProbeResult: jest.fn().mockResolvedValue(undefined),
}));

function rows(...r: Array<{ provider: string; calls: number; p95: number; avg?: number }>) {
  mockQuery.mockResolvedValue({
    rows: r.map((x) => ({
      provider: x.provider,
      calls: String(x.calls),
      p95: String(x.p95),
      avg: String(x.avg ?? Math.round(x.p95 / 3)),
    })),
  });
}

beforeEach(() => jest.clearAllMocks());

describe("holding providers to the budget", () => {
  it("names a provider whose p95 exceeds the budget", async () => {
    rows(
      { provider: "Microsoft Teams channels", calls: 113, p95: 22181 },
      { provider: "Instinct knowledge", calls: 160, p95: 151 },
    );

    const c = await checkSearchLatency(7);
    expect(c.overBudget.map((p) => p.provider)).toEqual(["Microsoft Teams channels"]);
    expect(c.budgetMs).toBe(PROVIDER_BUDGET_MS);
  });

  it("passes a provider that answers in time", async () => {
    rows({ provider: "SharePoint", calls: 59, p95: 1994 });

    const c = await checkSearchLatency(7);
    expect(c.overBudget).toEqual([]);
    expect(c.providers[0].withinBudget).toBe(true);
  });

  /* THE TAIL IS WHAT A PERSON EXPERIENCES AS BROKEN. Teams channels averaged
     5.5 seconds, inside a naive reading of the budget, while one call in
     twenty took twenty-two. Judging on the average would have cleared it. */
  it("judges on p95, not the average that hides the tail", async () => {
    rows({ provider: "Slow tail", calls: 200, p95: 22000, avg: 5500 });

    const c = await checkSearchLatency(7);
    expect(c.overBudget).toHaveLength(1);
  });

  it("reports worst first, so the offender leads", async () => {
    rows(
      { provider: "Bad", calls: 100, p95: 9000 },
      { provider: "Worse", calls: 100, p95: 20000 },
    );

    const c = await checkSearchLatency(7);
    expect(c.overBudget.map((p) => p.provider)).toEqual(["Worse", "Bad"]);
  });
});

describe("what it refuses to call healthy", () => {
  /* A QUIET PROVIDER IS UNMEASURED, NEVER PASSING. Below the threshold one
     slow call sets the percentile, and reporting that as a pass would be
     silence reading as success, which is the failure this codebase has been
     bitten by repeatedly: a health probe with 157 runs and no successes, a
     degrade signal that could not fire, an empty mirror read as "you have no
     tasks". */
  it("reports too little traffic as unmeasured rather than within budget", async () => {
    rows({ provider: "Barely used", calls: MIN_CALLS_FOR_VERDICT - 1, p95: 100 });

    const c = await checkSearchLatency(7);
    expect(c.providers[0].withinBudget).toBeNull();
    expect(c.providers[0].p95Ms).toBeNull();
    /* And it is not counted as an offender either: unknown is not failing. */
    expect(c.overBudget).toEqual([]);
  });

  it("judges a provider the moment it has enough traffic", async () => {
    rows({ provider: "Just enough", calls: MIN_CALLS_FOR_VERDICT, p95: 100 });

    const c = await checkSearchLatency(7);
    expect(c.providers[0].withinBudget).toBe(true);
  });

  /* Unreadable telemetry is not a clean bill of health. */
  it("says the telemetry could not be read rather than reporting no offenders", async () => {
    mockQuery.mockRejectedValue(new Error("db down"));

    const c = await checkSearchLatency(7);
    expect(c.unreadable).toBe(true);
    expect(c.overBudget).toEqual([]);
    expect(c.providers).toEqual([]);
  });

  /* WARNS, DOES NOT DISABLE. Dropping a provider silently loses a client's
     data source, which is worse than a slow answer they at least receive. The
     per-request timeout already bounds the damage; this makes the trend
     visible so a person decides. */
  it("returns a verdict rather than removing anything", async () => {
    rows({ provider: "Microsoft Teams channels", calls: 113, p95: 22181 });

    const c = await checkSearchLatency(7);
    expect(c.providers).toHaveLength(1);
    expect(c.providers[0].withinBudget).toBe(false);
  });
});
