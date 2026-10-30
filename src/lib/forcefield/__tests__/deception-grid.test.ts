import { ensureDeceptionGrid, type GridDeps } from "@/lib/forcefield/deception-grid";
import type { CanaryKind } from "@/lib/forcefield/tripwire";

function fakeDeps(active: CanaryKind[]): { deps: GridDeps; created: { kind: CanaryKind; value: string; seededIn: string }[] } {
  const created: { kind: CanaryKind; value: string; seededIn: string }[] = [];
  const deps: GridDeps = {
    listActive: async () => active.map((kind) => ({ kind })),
    create: async (i) => { created.push({ kind: i.kind, value: i.value, seededIn: i.seededIn }); },
  };
  return { deps, created };
}

describe("ensureDeceptionGrid", () => {
  it("seeds all five kinds when none exist, each with a placement instruction", async () => {
    const { deps, created } = fakeDeps([]);
    const r = await ensureDeceptionGrid({ workspaceId: "w1" }, deps);
    expect(created.map((c) => c.kind).sort()).toEqual(["login", "route", "row", "token", "tool"]);
    expect(r.seeded).toHaveLength(5);
    expect(r.seeded.every((s) => s.placement.length > 10)).toBe(true);
    // every seeded canary carries its placement as seededIn (emission gap is explicit)
    expect(created.every((c) => c.seededIn.length > 10)).toBe(true);
    // decoy values are non-trivial + kind-shaped
    expect(created.find((c) => c.kind === "token")!.value).toMatch(/^wlpk_live_[0-9a-f]{24}$/);
    expect(created.find((c) => c.kind === "route")!.value).toMatch(/^\/internal\/export-/);
    // a login canary has the exact shape sites check for
    expect(created.find((c) => c.kind === "login")!.value).toMatch(/^svc_[a-z]{3,8}_[a-z2-7]{6}$/);
  });

  it("is idempotent: only seeds the MISSING kinds", async () => {
    const { deps, created } = fakeDeps(["token", "route"]);
    const r = await ensureDeceptionGrid({ workspaceId: "w1" }, deps);
    expect(created.map((c) => c.kind).sort()).toEqual(["login", "row", "tool"]);
    expect(r.alreadyPresent.sort()).toEqual(["route", "token"]);
    expect(r.seeded.map((s) => s.kind).sort()).toEqual(["login", "row", "tool"]);
  });

  it("no-ops when the full grid already exists, but still reports pending placement for all kinds", async () => {
    const { deps, created } = fakeDeps(["token", "route", "row", "tool", "login"]);
    const r = await ensureDeceptionGrid({ workspaceId: "w1" }, deps);
    expect(created).toHaveLength(0);
    expect(r.seeded).toHaveLength(0);
    expect(r.pendingPlacement).toHaveLength(5); // emission is never assumed done
  });

  it("generates unique decoy values across calls", async () => {
    const { deps, created } = fakeDeps([]);
    await ensureDeceptionGrid({ workspaceId: "w1" }, deps);
    await ensureDeceptionGrid({ workspaceId: "w1" }, deps);
    const tokens = created.filter((c) => c.kind === "token").map((c) => c.value);
    expect(new Set(tokens).size).toBe(tokens.length);
  });
});
