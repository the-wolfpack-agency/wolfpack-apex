/**
 * @jest-environment node
 *
 * Exhaustive unit tests for `assessLayout` — the PURE core of the post-deploy
 * multi-device UI verification. These tests are the primary correctness
 * guarantee: they exercise every layout rule with a hand-built LayoutObservation
 * and NO browser, so a green run here means the live driver's classification is
 * correct regardless of chromium availability.
 *
 * Also covers `deviceFindingToScanFinding` (pipeline composition) and
 * `runDeviceMatrix`'s chromium-unavailable degrade path (never throws).
 */
import {
  assessLayout,
  deviceFindingToScanFinding,
  runDeviceMatrix,
  DEVICES,
  DEVICE_MATRIX_EVENT,
  type LayoutObservation,
  type ProbedElement,
  type ProbedRect,
} from "../device-matrix";

/** A clean, no-issues observation. Overrides let each test perturb one signal. */
function obs(overrides: Partial<LayoutObservation> = {}): LayoutObservation {
  return {
    device: "phone",
    viewportWidth: 390,
    viewportHeight: 844,
    documentScrollWidth: 390,
    innerWidth: 390,
    probed: [],
    consoleErrors: [],
    cspViolations: [],
    failedRequests: [],
    ...overrides,
  };
}

/** Build a ProbedRect from a right edge + size (the fields the rules read). */
function rect(over: Partial<ProbedRect> = {}): ProbedRect {
  return {
    x: 0,
    y: 0,
    width: 100,
    height: 40,
    top: 0,
    right: 100,
    bottom: 40,
    left: 0,
    ...over,
  };
}

function probed(over: Partial<ProbedElement> = {}): ProbedElement {
  return { selector: "#el", rect: rect(), ...over };
}

// ---------------------------------------------------------------------------
// The device matrix constant
// ---------------------------------------------------------------------------

describe("DEVICES", () => {
  it("spans phone, tablet, and desktop with the required widths", () => {
    const byName = Object.fromEntries(DEVICES.map((d) => [d.name, d]));
    expect(byName.phone).toMatchObject({ width: 390, height: 844 });
    expect(byName.tablet).toMatchObject({ width: 820, height: 1180 });
    expect(byName.desktop).toMatchObject({ width: 1440, height: 900 });
  });
});

// ---------------------------------------------------------------------------
// assessLayout — clean case
// ---------------------------------------------------------------------------

describe("assessLayout — clean", () => {
  it("a no-issues observation yields no findings", () => {
    expect(assessLayout(obs())).toEqual([]);
  });

  it("scrollWidth within the 1px tolerance does NOT flag overflow", () => {
    expect(assessLayout(obs({ documentScrollWidth: 391, innerWidth: 390 }))).toEqual([]);
  });

  it("an element exactly at the viewport edge does NOT flag", () => {
    const out = assessLayout(
      obs({ viewportWidth: 390, probed: [probed({ rect: rect({ right: 390 }) })] }),
    );
    expect(out).toEqual([]);
  });

  it("a non-required element that is missing does NOT flag", () => {
    const out = assessLayout(obs({ probed: [probed({ rect: null, mustBeVisible: false })] }));
    expect(out).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// assessLayout — horizontal overflow
// ---------------------------------------------------------------------------

describe("assessLayout — horizontal overflow", () => {
  it("scrollWidth > innerWidth + 1 -> high/bug", () => {
    const out = assessLayout(obs({ documentScrollWidth: 500, innerWidth: 390 }));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      severity: "high",
      category: "bug",
      title: "Horizontal overflow (page scrolls sideways)",
      device: "phone",
    });
    expect(out[0].evidence).toMatchObject({ scrollWidth: 500, innerWidth: 390, overflowPx: 110 });
    expect(out[0].id).toBe("device-matrix:phone:horizontal-overflow");
  });
});

// ---------------------------------------------------------------------------
// assessLayout — element past the edge
// ---------------------------------------------------------------------------

describe("assessLayout — element overflow", () => {
  it("a probed element whose rect.right exceeds the viewport -> high/bug", () => {
    const out = assessLayout(
      obs({ viewportWidth: 390, probed: [probed({ selector: ".hero", rect: rect({ right: 520 }) })] }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      severity: "high",
      category: "bug",
      title: "Element overflows the viewport edge",
    });
    expect(out[0].evidence).toMatchObject({ right: 520, viewportWidth: 390, overflowPx: 130 });
    expect(out[0].id).toBe("device-matrix:phone:element-overflow:.hero");
  });

  it("applies only when past the edge beyond the 1px tolerance", () => {
    const out = assessLayout(
      obs({ viewportWidth: 390, probed: [probed({ rect: rect({ right: 391 }) })] }),
    );
    expect(out).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// assessLayout — must-be-visible
// ---------------------------------------------------------------------------

describe("assessLayout — required element", () => {
  it("a missing must-be-visible element -> high/ux_gap", () => {
    const out = assessLayout(
      obs({ probed: [probed({ selector: "h1", rect: null, mustBeVisible: true })] }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      severity: "high",
      category: "ux_gap",
      title: "Required element missing or zero-size",
    });
    expect(out[0].evidence).toMatchObject({ selector: "h1", missing: true });
    expect(out[0].id).toBe("device-matrix:phone:hidden-required:h1");
  });

  it("a zero-size must-be-visible element -> high/ux_gap", () => {
    const out = assessLayout(
      obs({
        probed: [probed({ selector: "main", rect: rect({ width: 0, height: 0, right: 0 }), mustBeVisible: true })],
      }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ severity: "high", category: "ux_gap" });
    expect(out[0].evidence).toMatchObject({ selector: "main", missing: false, width: 0, height: 0 });
  });

  it("a zero-HEIGHT (but non-zero width) required element still flags", () => {
    const out = assessLayout(
      obs({ probed: [probed({ rect: rect({ height: 0 }), mustBeVisible: true })] }),
    );
    expect(out).toHaveLength(1);
    expect(out[0].category).toBe("ux_gap");
  });

  it("a healthy required element does NOT flag and does NOT double-report overflow", () => {
    const out = assessLayout(
      obs({ viewportWidth: 390, probed: [probed({ rect: rect({ right: 200 }), mustBeVisible: true })] }),
    );
    expect(out).toEqual([]);
  });

  it("a missing required element is NOT also treated as an edge overflow", () => {
    // rect is null -> only the missing finding, never an element-overflow finding.
    const out = assessLayout(
      obs({ probed: [probed({ selector: "h1", rect: null, mustBeVisible: true })] }),
    );
    expect(out.every((f) => f.title !== "Element overflows the viewport edge")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// assessLayout — console / csp / failed requests
// ---------------------------------------------------------------------------

describe("assessLayout — console errors", () => {
  it("console errors -> medium/bug with count + sample", () => {
    const out = assessLayout(obs({ consoleErrors: ["boom", "bang"] }));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ severity: "medium", category: "bug", title: "Console errors on page" });
    expect(out[0].evidence).toMatchObject({ count: 2, sample: "boom" });
  });
});

describe("assessLayout — CSP violations", () => {
  it("a CSP violation -> high/security", () => {
    const out = assessLayout(obs({ cspViolations: ["script-src https://evil"] }));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ severity: "high", category: "security", title: "CSP violation on page" });
    expect(out[0].evidence).toMatchObject({ count: 1, sample: "script-src https://evil" });
  });
});

describe("assessLayout — failed requests", () => {
  it("a 5xx failed request -> high/bug", () => {
    const out = assessLayout(obs({ failedRequests: [{ url: "https://x/api/data", status: 503 }] }));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ severity: "high", category: "bug", title: "Failed request (503)" });
    expect(out[0].id).toBe("device-matrix:phone:failed-request:503:https://x/api/data");
  });

  it("a 4xx failed request -> medium/bug", () => {
    const out = assessLayout(obs({ failedRequests: [{ url: "https://x/api/me", status: 401 }] }));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ severity: "medium", category: "bug", title: "Failed request (401)" });
  });

  it("emits one finding per failed request", () => {
    const out = assessLayout(
      obs({
        failedRequests: [
          { url: "https://x/a", status: 500 },
          { url: "https://x/b", status: 404 },
        ],
      }),
    );
    expect(out).toHaveLength(2);
    expect(out.map((f) => f.severity).sort()).toEqual(["high", "medium"]);
  });

  it("a sub-400 status is ignored", () => {
    const out = assessLayout(obs({ failedRequests: [{ url: "https://x/ok", status: 302 }] }));
    expect(out).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// assessLayout — multiple simultaneous issues + device labelling
// ---------------------------------------------------------------------------

describe("assessLayout — combined", () => {
  it("one observation can yield many findings, all tagged to the device", () => {
    const out = assessLayout(
      obs({
        device: "tablet",
        viewportWidth: 820,
        documentScrollWidth: 1000,
        innerWidth: 820,
        probed: [
          probed({ selector: ".nav", rect: rect({ right: 900 }) }),
          probed({ selector: "h1", rect: null, mustBeVisible: true }),
        ],
        consoleErrors: ["x"],
        cspViolations: ["style-src"],
        failedRequests: [{ url: "https://x/api", status: 500 }],
      }),
    );
    // overflow + element-edge + missing-required + csp + failed + console = 6
    expect(out).toHaveLength(6);
    expect(out.every((f) => f.device === "tablet")).toBe(true);
    expect(new Set(out.map((f) => f.id)).size).toBe(6); // ids are unique
  });

  it("finding ids are stable across identical observations (dedupe key)", () => {
    const a = assessLayout(obs({ documentScrollWidth: 500 }))[0];
    const b = assessLayout(obs({ documentScrollWidth: 500 }))[0];
    expect(a.id).toBe(b.id);
  });
});

// ---------------------------------------------------------------------------
// deviceFindingToScanFinding — pipeline composition
// ---------------------------------------------------------------------------

describe("deviceFindingToScanFinding", () => {
  it("folds a DeviceFinding into a ScanFinding, labelling the route with the device", () => {
    const [finding] = assessLayout(obs({ documentScrollWidth: 500 }));
    const scan = deviceFindingToScanFinding(finding, "https://app.example.com/dashboard");
    expect(scan.route).toBe("https://app.example.com/dashboard [phone]");
    expect(scan.severity).toBe("high");
    expect(scan.category).toBe("bug");
    expect(scan.evidence.device).toBe("phone");
    expect(scan.evidence.finding_id).toBe(finding.id);
  });
});

// ---------------------------------------------------------------------------
// runDeviceMatrix — chromium-unavailable degrade path (never throws)
// ---------------------------------------------------------------------------

describe("runDeviceMatrix — degrade guard", () => {
  it("returns a degraded result (never throws) when the injected chromium fails to launch", async () => {
    const track = jest.fn();
    const result = await runDeviceMatrix("https://app.example.com", {
      trackEvent: track,
      chromium: {
        launch: async () => {
          throw new Error("no browser binary");
        },
      },
    });
    expect(result.degraded).toBe(true);
    expect(result.degradedReason).toContain("chromium launch failed");
    expect(result.allFindings).toEqual([]);
    expect(result.byDevice).toEqual({});
  });

  it("exposes the analytics event name matching the InstinctEventType union", () => {
    expect(DEVICE_MATRIX_EVENT).toBe("platform.device_matrix_run");
  });
});

// ---------------------------------------------------------------------------
// Cut-off text / overlap / buried-content heuristics
// ---------------------------------------------------------------------------

describe("assessLayout — cut-off text (clipped)", () => {
  it("a clipped element (content wider than box) -> medium/ux_gap", () => {
    const out = assessLayout(
      obs({ clipped: [{ label: "a #198 Change browser tab title", contentWidth: 260, boxWidth: 90 }] }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ severity: "medium", category: "ux_gap", title: "Text is cut off" });
    expect(out[0].detail).toContain("260px");
    expect(out[0].detail).toContain("90px");
  });

  it("no clipped array -> no finding", () => {
    expect(assessLayout(obs())).toEqual([]);
    expect(assessLayout(obs({ clipped: [] }))).toEqual([]);
  });

  it("emits one finding per clipped element", () => {
    const out = assessLayout(
      obs({
        clipped: [
          { label: "span one", contentWidth: 200, boxWidth: 100 },
          { label: "span two", contentWidth: 300, boxWidth: 120 },
        ],
      }),
    );
    expect(out.filter((f) => f.title === "Text is cut off")).toHaveLength(2);
  });
});

describe("assessLayout — overlapping elements", () => {
  it("an overlap pair -> high/bug", () => {
    const out = assessLayout(obs({ overlaps: [{ a: "span Status", b: "a Title text" }] }));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ severity: "high", category: "bug", title: "Elements overlap" });
    expect(out[0].detail).toContain("Status");
    expect(out[0].detail).toContain("Title text");
  });

  it("no overlaps -> no finding", () => {
    expect(assessLayout(obs({ overlaps: [] }))).toEqual([]);
  });
});

describe("assessLayout — content buried below the fold", () => {
  it("content top beyond one viewport height -> high/ux_gap", () => {
    const out = assessLayout(obs({ viewportHeight: 844, contentTopPx: 900 }));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      severity: "high",
      category: "ux_gap",
      title: "Primary content buried below the fold",
    });
    expect(out[0].detail).toContain("900px");
  });

  it("content within the first viewport does NOT flag", () => {
    expect(assessLayout(obs({ viewportHeight: 844, contentTopPx: 300 }))).toEqual([]);
    expect(assessLayout(obs({ viewportHeight: 844, contentTopPx: 844 }))).toEqual([]);
  });

  it("null contentTopPx (no content selector probed) does NOT flag", () => {
    expect(assessLayout(obs({ contentTopPx: null }))).toEqual([]);
  });
});
