/**
 * Exercising the integrations that were built and never run.
 *
 * The first version of this reported three surfaces as working while the
 * machine it ran on had no Microsoft connection at all. That is the failure
 * these tests exist to prevent, and it is the same one the product spends its
 * life designing against: a call that fails and returns nothing looks exactly
 * like a call that succeeded and found nothing.
 */
const mockPersist = jest.fn();
jest.mock("@/lib/health/integration-probes", () => ({
  persistProbeResult: (...a: unknown[]) => mockPersist(...a),
}));
jest.mock("@/lib/microsoft-graph", () => ({ getValidToken: jest.fn() }));

import { exerciseUnprovenSurfaces, UNPROVEN_SURFACES, type SurfaceProbe } from "../unproven-surfaces";

const connected = async () => true;
const notConnected = async () => false;

const surface = (over: Partial<SurfaceProbe> = {}): SurfaceProbe => ({
  objectType: "people",
  run: async () => ({ detail: { suggested: 3 } }),
  ...over,
});

beforeEach(() => mockPersist.mockReset().mockResolvedValue(undefined));

describe("with no Microsoft connection", () => {
  /* THE BUG THIS SHIPPED WITH. Presence and mailbox settings both map a
     failure to null by design, so a probe reading the return value recorded
     mailbox settings as working while the scope it needs is not even
     requested. Impossible, and reported as fact. */
  it("proves nothing rather than reporting success", async () => {
    const results = await exerciseUnprovenSurfaces(
      "ws-1",
      "nobody@example.com",
      [surface({ run: async () => ({ detail: {} }) })],
      notConnected,
    );
    expect(results[0].ok).toBe(false);
  });

  it("calls it expected state, not a fault in the surface", async () => {
    const [r] = await exerciseUnprovenSurfaces("ws-1", "n@e.com", [surface()], notConnected);
    /* Reported as a fault it would send somebody debugging code that was
       never reached. */
    expect(r.notConfigured).toBe(true);
    expect(r.errorMessage).toMatch(/no connected Microsoft account/);
  });

  it("never runs the surface at all", async () => {
    const run = jest.fn();
    await exerciseUnprovenSurfaces("ws-1", "n@e.com", [surface({ run })], notConnected);
    expect(run).not.toHaveBeenCalled();
  });

  it("still records every surface, so the gap stays visible", async () => {
    const results = await exerciseUnprovenSurfaces("ws-1", "n@e.com", UNPROVEN_SURFACES, notConnected);
    expect(results).toHaveLength(UNPROVEN_SURFACES.length);
    expect(mockPersist).toHaveBeenCalledTimes(UNPROVEN_SURFACES.length);
  });
});

describe("with a working connection", () => {
  it("records a surface that answered", async () => {
    const [r] = await exerciseUnprovenSurfaces("ws-1", "n@e.com", [surface()], connected);
    expect(r.ok).toBe(true);
    expect(r.schemaPayload).toEqual({ suggested: 3 });
  });

  /* One failure must not stop the others: the whole reason these went
     unexercised is that nothing ran them. */
  it("keeps going after one surface throws", async () => {
    const results = await exerciseUnprovenSurfaces(
      "ws-1",
      "n@e.com",
      [
        surface({ objectType: "a", run: async () => { throw new Error("graph 500"); } }),
        surface({ objectType: "b" }),
      ],
      connected,
    );
    expect(results.map((r) => r.ok)).toEqual([false, true]);
    expect(results[0].errorMessage).toContain("graph 500");
  });

  /* A scope this deployment deliberately does not request is a decision
     somebody has to make, not a bug somebody has to fix, so it must not page
     anybody. */
  it("treats a deliberately unrequested scope as expected state", async () => {
    const [r] = await exerciseUnprovenSurfaces(
      "ws-1",
      "n@e.com",
      [
        surface({
          objectType: "mailbox",
          needsDisabledScope: true,
          scope: "MailboxSettings.Read",
          run: async () => { throw new Error("403"); },
        }),
      ],
      connected,
    );
    expect(r.ok).toBe(false);
    expect(r.notConfigured).toBe(true);
    expect(r.errorMessage).toMatch(/MailboxSettings\.Read needs administrator consent/);
  });
});

describe("what it will and will not touch", () => {
  /* A number on a slide is not a reason to write into somebody's mailbox. */
  it("covers exactly the six that had never run", () => {
    expect(UNPROVEN_SURFACES.map((s) => s.objectType).sort()).toEqual([
      "contacts",
      "mailbox",
      "onenote",
      "people",
      "presence",
      "project",
    ]);
  });

  it("declares only the mailbox as needing a permission we do not request", () => {
    const blocked = UNPROVEN_SURFACES.filter((s) => s.needsDisabledScope);
    expect(blocked.map((s) => s.objectType)).toEqual(["mailbox"]);
    expect(blocked[0].scope).toBe("MailboxSettings.Read");
  });
});
