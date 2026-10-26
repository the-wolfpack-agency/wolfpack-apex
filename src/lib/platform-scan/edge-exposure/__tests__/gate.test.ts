/**
 * The edge-exposure gate is the fail-closed control in front of the classifier:
 * OFF by default (the EDGE_EXPOSURE_ENABLED setting must be explicitly on) and an
 * ownership floor (curated/internal OR a client target proven owned). Both floors
 * are pinned here, plus the observability contract (every outcome tracked +
 * audited). Collaborators are injected so no env/DB/network is touched; the
 * real isEdgeExposureEnabled env reading is covered by its own case.
 */
import {
  runEdgeDeviceExposure,
  isEdgeExposureEnabled,
  type EdgeExposureDeps,
} from "@/lib/platform-scan/edge-exposure/gate";
import type { EdgeHttpResponse } from "@/lib/platform-scan/edge-exposure/classify";

const ACTOR = { userId: "u1", role: "admin" };
const FORTI: EdgeHttpResponse = { route: "/remote/login", status: 200, bodyExcerpt: "fgt_lang" };
const CLEAN: EdgeHttpResponse = { route: "/", status: 200, bodyExcerpt: "<p>hello</p>" };

function deps(over: Partial<EdgeExposureDeps> = {}): EdgeExposureDeps {
  return {
    enabled: () => true,
    curated: () => false,
    verified: jest.fn(async () => true),
    track: jest.fn(),
    audit: jest.fn(async () => ({}) as never),
    ...over,
  };
}

describe("runEdgeDeviceExposure - OFF by default", () => {
  it("refuses with reason 'disabled' when the setting is off, before any ownership check", async () => {
    const verified = jest.fn(async () => true);
    const track = jest.fn();
    const r = await runEdgeDeviceExposure(
      { workspaceId: "w1", platform: "client-x", response: FORTI, actor: ACTOR },
      deps({ enabled: () => false, verified, track }),
    );
    expect(r).toEqual({ ran: false, reason: "disabled" });
    expect(verified).not.toHaveBeenCalled(); // short-circuits before ownership
    expect(track).toHaveBeenCalledWith(
      "platform.edge_exposure_blocked",
      "u1",
      "admin",
      expect.objectContaining({ reason: "disabled" }),
    );
  });
});

describe("runEdgeDeviceExposure - ownership floor", () => {
  it("refuses an unverified, non-curated client target", async () => {
    const r = await runEdgeDeviceExposure(
      { workspaceId: "w1", platform: "client-x", response: FORTI, actor: ACTOR },
      deps({ curated: () => false, verified: jest.fn(async () => false) }),
    );
    expect(r).toEqual({ ran: false, reason: "unverified_target" });
  });

  it("runs for a curated/internal target without an ownership check", async () => {
    const verified = jest.fn(async () => false);
    const r = await runEdgeDeviceExposure(
      { workspaceId: "w1", platform: "wolfpack-auto", response: CLEAN, actor: ACTOR },
      deps({ curated: () => true, verified }),
    );
    expect(r.ran).toBe(true);
    expect(verified).not.toHaveBeenCalled();
  });

  it("runs for a verified client target", async () => {
    const r = await runEdgeDeviceExposure(
      { workspaceId: "w1", platform: "client-x", response: CLEAN, actor: ACTOR },
      deps({ curated: () => false, verified: jest.fn(async () => true) }),
    );
    expect(r.ran).toBe(true);
  });
});

describe("runEdgeDeviceExposure - classification + observability", () => {
  it("emits a detected event + audit when a portal with KEVs is recognised", async () => {
    const track = jest.fn();
    const audit = jest.fn(async () => ({}) as never);
    const r = await runEdgeDeviceExposure(
      { workspaceId: "w1", platform: "client-x", response: FORTI, actor: ACTOR },
      deps({ track, audit }),
    );
    expect(r).toMatchObject({ ran: true, detected: true });
    if (r.ran) expect(r.findings).toHaveLength(1);
    expect(track).toHaveBeenCalledWith(
      "platform.edge_exposure_detected",
      "u1",
      "admin",
      expect.objectContaining({ product: "fortinet_fortios_sslvpn", vendor: "Fortinet" }),
    );
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "platform.edge_exposure.detected" }),
    );
  });

  it("runs clean (no findings, no detected event) on a non-edge response", async () => {
    const track = jest.fn();
    const r = await runEdgeDeviceExposure(
      { workspaceId: "w1", platform: "client-x", response: CLEAN, actor: ACTOR },
      deps({ track }),
    );
    expect(r).toMatchObject({ ran: true, detected: false });
    if (r.ran) expect(r.findings).toEqual([]);
    expect(track).not.toHaveBeenCalledWith(
      "platform.edge_exposure_detected",
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it("a failing audit ledger never flips the result (best-effort)", async () => {
    const audit = jest.fn(async () => {
      throw new Error("ledger down");
    });
    const r = await runEdgeDeviceExposure(
      { workspaceId: "w1", platform: "client-x", response: FORTI, actor: ACTOR },
      deps({ audit }),
    );
    expect(r).toMatchObject({ ran: true, detected: true });
  });
});

describe("isEdgeExposureEnabled - OFF by default via env", () => {
  const original = process.env.EDGE_EXPOSURE_ENABLED;
  afterEach(() => {
    if (original === undefined) delete process.env.EDGE_EXPOSURE_ENABLED;
    else process.env.EDGE_EXPOSURE_ENABLED = original;
  });

  it("is false when unset", () => {
    delete process.env.EDGE_EXPOSURE_ENABLED;
    expect(isEdgeExposureEnabled()).toBe(false);
  });

  it("is false for an unrecognised value", () => {
    process.env.EDGE_EXPOSURE_ENABLED = "maybe";
    expect(isEdgeExposureEnabled()).toBe(false);
  });

  it.each(["on", "true", "1", "ON", "True"])("is true for %s", (v) => {
    process.env.EDGE_EXPOSURE_ENABLED = v;
    expect(isEdgeExposureEnabled()).toBe(true);
  });
});
