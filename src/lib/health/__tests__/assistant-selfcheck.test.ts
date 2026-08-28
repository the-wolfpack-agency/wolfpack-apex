/**
 * The product asking itself the questions that were wrong.
 *
 * WHAT THESE TESTS ARE FOR. The self-check runs against production and its
 * value is entirely in what it catches, so the thing worth testing here is
 * that it actually FAILS when the product regresses. A check that cannot go
 * red is decoration, and this repo has now found several of those in one day:
 * a health probe with 157 runs and no successes, a repair endpoint never
 * called, a degrade signal that could not fire.
 *
 * So each test below breaks the product deliberately and asserts the check
 * notices.
 */
import { runAssistantSelfCheck, CHECKS } from "@/lib/health/assistant-selfcheck";

const mockChat = jest.fn();
const mockPersist = jest.fn();

jest.mock("@/lib/assistant", () => ({ chat: (...a: unknown[]) => mockChat(...a) }));
jest.mock("@/lib/health/integration-probes", () => ({
  persistProbeResult: (...a: unknown[]) => mockPersist(...a),
}));
jest.mock("@/lib/analytics", () => ({ trackEvent: () => undefined }));

/** The product behaving: every question answered by a tool, no denials. */
function healthy() {
  mockChat.mockResolvedValue({
    response: "Yes. Here is what I can do: read your mail, your calendar and your files.",
    source: "tool",
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPersist.mockResolvedValue(undefined);
});

describe("when the product is behaving", () => {
  it("passes every check and records each one", async () => {
    healthy();
    const r = await runAssistantSelfCheck();
    expect(r.failed).toEqual([]);
    expect(r.ran).toBe(CHECKS.length);
    expect(mockPersist).toHaveBeenCalledTimes(CHECKS.length);
  });

  /* Recorded in the same table as the integration probes, keyed by check id, so
     "is the product working" is one query rather than two systems. */
  it("records each result as an action probe keyed by check id", async () => {
    healthy();
    await runAssistantSelfCheck();
    const probes = mockPersist.mock.calls.map(([, p]) => p as Record<string, unknown>);
    expect(probes.every((p) => p.vendor === "assistant")).toBe(true);
    expect(probes.every((p) => p.probeKind === "action")).toBe(true);
    expect(probes.map((p) => p.objectType).sort()).toEqual(CHECKS.map((c) => c.id).sort());
  });
});

describe("when the product regresses, it goes red", () => {
  /* THE EXACT REGRESSION THIS EXISTS FOR. "I cannot send emails directly" was
     served from cache, at zero tokens, having been stored as a fact. Note the
     source is still "tool": a denial served from a cache looks perfectly
     healthy by every other measure, which is why the check reads the ANSWER. */
  it("catches a capability denial even when it is served from a tool", async () => {
    mockChat.mockResolvedValue({
      response: "I cannot send emails directly. However, I can help you draft one.",
      source: "tool",
    });
    const r = await runAssistantSelfCheck();
    const failed = r.failed.map((f) => f.id);
    expect(failed).toContain("capability_email");
    expect(failed).toContain("capability_files");
    expect(r.failed[0].reason).toMatch(/denied a capability/);
  });

  /* The routing half. "how many open tasks do I have" reached no tool and was
     answered from the Brain with training PDFs; the answer read plausibly and
     only the SOURCE gave it away. */
  it("catches a question falling through to a model", async () => {
    mockChat.mockResolvedValue({
      response: "You appear to have several tasks based on the documents I found.",
      source: "ai",
    });
    const r = await runAssistantSelfCheck();
    expect(r.failed.map((f) => f.id)).toEqual(
      expect.arrayContaining(["routing_task_count", "routing_bare_site_name", "front_door"]),
    );
    expect(r.failed.some((f) => /reached a model/.test(f.reason ?? ""))).toBe(true);
  });

  /* An answer that is technically served but says nothing. The front door is
     the first thing anybody types and an empty answer there is the difference
     between a user continuing and giving up. */
  it("catches the front door answering with almost nothing", async () => {
    mockChat.mockResolvedValue({ response: "Sure.", source: "tool" });
    const r = await runAssistantSelfCheck();
    expect(r.failed.map((f) => f.id)).toContain("front_door");
  });

  /* A check that throws must be a FAILED check, not a crashed run: it is called
     from a cron whose other work has to finish, and "it threw" is the
     information we wanted anyway. */
  it("records a thrown check as failed and keeps going", async () => {
    mockChat.mockRejectedValue(new Error("pipeline exploded"));
    const r = await runAssistantSelfCheck();
    expect(r.ran).toBe(CHECKS.length);
    expect(r.failed).toHaveLength(CHECKS.length);
    expect(r.failed[0].reason).toMatch(/threw/);
  });

  /* Persistence failing must not take the run down either. The returned summary
     is still the answer; the row is just the durable copy of it. */
  it("still returns a summary when persistence fails", async () => {
    healthy();
    mockPersist.mockRejectedValue(new Error("db down"));
    const r = await runAssistantSelfCheck();
    expect(r.ran).toBe(CHECKS.length);
    expect(r.failed).toEqual([]);
  });
});

describe("it cannot distort what it measures", () => {
  /* My own manual testing wrote three denial rows into production knowledge on
     the same day this was written. An automated check running nightly must not
     repeat that, and it must not appear in the adoption figures on /pilot,
     which count askers by joining conversations to the roster. */
  it("asks as a synthetic user that is not a real person", async () => {
    healthy();
    await runAssistantSelfCheck();
    const userIds = mockChat.mock.calls.map(([, userId]) => userId);
    expect(new Set(userIds)).toEqual(new Set(["assistant-selfcheck"]));
  });

  /* Every check must be answerable by a tool. A question that reaches the model
     path can write to the knowledge base, which is how a nightly check would
     quietly become a nightly polluter. */
  it("asks only questions whose right answer comes from a tool", async () => {
    for (const check of CHECKS) {
      expect(check.expect("A perfectly good answer about your systems.", "ai")).toMatch(
        /reached a model|^$|denied/,
      );
    }
  });
});
