/**
 * Unit tests for classifyPage — the pure core of the browser-journey scanner.
 * Every rule branch is exercised, plus a multi-finding page and a healthy page.
 */
import {
  classifyPage,
  classifyAxe,
  iconOnlyControlNoName,
  disabledControlNoExplanation,
  tinyTapTarget,
  dialogNoAccessibleName,
  type AxeViolation,
  type PageObservation,
  type UiElement,
} from "../classify";

function obs(overrides: Partial<PageObservation> = {}): PageObservation {
  return {
    route: "/dashboard",
    journey: "dashboard",
    status: 200,
    consoleErrors: [],
    cspViolations: [],
    failedRequests: [],
    renderedContent: true,
    durationMs: 120,
    ...overrides,
  };
}

it("healthy page yields no findings", () => {
  expect(classifyPage(obs())).toEqual([]);
});

it("status >= 500 -> bug/critical with status in evidence", () => {
  const [f] = classifyPage(obs({ status: 503, renderedContent: false }));
  expect(f).toMatchObject({ severity: "critical", category: "bug", title: "Server error (503)" });
  expect(f.evidence.status).toBe(503);
  // A 5xx must NOT also raise the blank-render ux_gap (status >= 400).
  expect(classifyPage(obs({ status: 503, renderedContent: false }))).toHaveLength(1);
});

it("status 404 -> broken_journey/high", () => {
  const out = classifyPage(obs({ status: 404, renderedContent: false }));
  expect(out).toHaveLength(1);
  expect(out[0]).toMatchObject({ severity: "high", category: "broken_journey", title: "Route 404s" });
  expect(out[0].evidence.status).toBe(404);
});

it("CSP violations -> security/high with count + first sample", () => {
  const [f] = classifyPage(obs({ cspViolations: ["script-src blocked", "img-src blocked"] }));
  expect(f).toMatchObject({ severity: "high", category: "security", title: "CSP violation on page" });
  expect(f.evidence.count).toBe(2);
  expect(f.evidence.sample).toBe("script-src blocked");
});

it("failed API call (>=400) -> bug/high (silent blank-page risk) with first url+status+count", () => {
  const [f] = classifyPage(
    obs({
      failedRequests: [
        { url: "/api/me", status: 401 },
        { url: "/api/x", status: 500 },
        { url: "/api/ok", status: 200 },
      ],
    }),
  );
  expect(f).toMatchObject({
    severity: "high",
    category: "bug",
    title: "Page made a failed API call (silent blank-page risk)",
  });
  expect(f.evidence.url).toBe("/api/me");
  expect(f.evidence.status).toBe(401);
  expect(f.evidence.count).toBe(2); // only the two >= 400
});

it("a 3xx-only failedRequests list (no >=400) raises no failed-call finding", () => {
  expect(classifyPage(obs({ failedRequests: [{ url: "/api/x", status: 302 }] }))).toEqual([]);
});

it("console errors -> bug/medium with count + first message", () => {
  const [f] = classifyPage(obs({ consoleErrors: ["TypeError: x", "ref err"] }));
  expect(f).toMatchObject({ severity: "medium", category: "bug", title: "Console errors on page" });
  expect(f.evidence.count).toBe(2);
  expect(f.evidence.sample).toBe("TypeError: x");
});

it("blank render with status < 400 -> ux_gap/high", () => {
  const [f] = classifyPage(obs({ renderedContent: false }));
  expect(f).toMatchObject({ severity: "high", category: "ux_gap", title: "Page rendered blank / no content" });
});

it("blank render does NOT fire when status >= 400 (the status finding owns it)", () => {
  const out = classifyPage(obs({ status: 404, renderedContent: false }));
  expect(out.every((f) => f.category !== "ux_gap")).toBe(true);
});

it("undefined status + blank -> ux_gap fires (navigation failure)", () => {
  const out = classifyPage(obs({ status: undefined, renderedContent: false }));
  expect(out).toHaveLength(1);
  expect(out[0].category).toBe("ux_gap");
});

it("one page yields MULTIPLE findings", () => {
  const out = classifyPage(
    obs({
      status: 200,
      renderedContent: false,
      cspViolations: ["script-src blocked"],
      failedRequests: [{ url: "/api/me", status: 403 }],
      consoleErrors: ["boom"],
    }),
  );
  const titles = out.map((f) => f.title);
  expect(titles).toEqual([
    "CSP violation on page",
    "Page made a failed API call (silent blank-page risk)",
    "Console errors on page",
    "Page rendered blank / no content",
  ]);
});

it("every finding carries the route + journey", () => {
  const out = classifyPage(obs({ route: "/x", journey: "jx", consoleErrors: ["e"] }));
  expect(out[0].route).toBe("/x");
  expect(out[0].evidence.journey).toBe("jx");
});

// --- Granular usability / UX detectors -------------------------------------

const R = "/dashboard";
const J = "dashboard";

function el(overrides: Partial<UiElement> = {}): UiElement {
  return { tag: "button", ...overrides };
}

describe("iconOnlyControlNoName", () => {
  it("true positive: interactive control with no name + no text -> ux_gap/medium", () => {
    const f = iconOnlyControlNoName(el({ role: "button", interactive: true }), R, J);
    expect(f).toMatchObject({
      route: R,
      severity: "medium",
      category: "ux_gap",
      title: "Interactive control has no accessible name",
    });
    expect(f!.evidence.journey).toBe(J);
    expect(f!.evidence.tag).toBe("button");
  });

  it("fires for an interactive role even without interactive===true", () => {
    expect(iconOnlyControlNoName(el({ tag: "a", role: "link" }), R, J)).not.toBeNull();
  });

  it("guard: named icon button is NOT flagged", () => {
    expect(
      iconOnlyControlNoName(el({ interactive: true, accessibleName: "Close" }), R, J),
    ).toBeNull();
  });

  it("guard: control with text content is NOT flagged", () => {
    expect(
      iconOnlyControlNoName(el({ interactive: true, textContent: "Save" }), R, J),
    ).toBeNull();
  });

  it("guard: non-interactive element with no name is NOT flagged", () => {
    expect(iconOnlyControlNoName(el({ tag: "div", role: "img" }), R, J)).toBeNull();
  });

  it("guard: whitespace-only name/text is treated as empty (still skipped only if both empty)", () => {
    expect(
      iconOnlyControlNoName(
        el({ interactive: true, accessibleName: "   ", textContent: "  " }),
        R,
        J,
      ),
    ).not.toBeNull();
  });
});

describe("disabledControlNoExplanation", () => {
  it("true positive: disabled interactive control, no explanation -> ux_gap/low", () => {
    const f = disabledControlNoExplanation(
      el({ interactive: true, disabled: true }),
      R,
      J,
    );
    expect(f).toMatchObject({
      severity: "low",
      category: "ux_gap",
      title: "Disabled control with no explanation",
    });
    expect(f!.evidence.journey).toBe(J);
  });

  it("guard: disabled WITH title/explanation is NOT flagged", () => {
    expect(
      disabledControlNoExplanation(
        el({ interactive: true, disabled: true, hasExplanation: true }),
        R,
        J,
      ),
    ).toBeNull();
  });

  it("guard: enabled control is NOT flagged", () => {
    expect(
      disabledControlNoExplanation(el({ interactive: true, disabled: false }), R, J),
    ).toBeNull();
  });

  it("guard: missing disabled field -> no finding", () => {
    expect(
      disabledControlNoExplanation(el({ interactive: true }), R, J),
    ).toBeNull();
  });

  it("guard: disabled but non-interactive is NOT flagged", () => {
    expect(
      disabledControlNoExplanation(el({ tag: "div", disabled: true }), R, J),
    ).toBeNull();
  });
});

describe("tinyTapTarget", () => {
  it("true positive: interactive 20x20 box -> ux_gap/low with dimensions", () => {
    const f = tinyTapTarget(el({ interactive: true, box: { w: 20, h: 20 } }), R, J);
    expect(f).toMatchObject({
      severity: "low",
      category: "ux_gap",
      title: "Tap target smaller than 44px",
    });
    expect(f!.evidence.w).toBe(20);
    expect(f!.evidence.h).toBe(20);
  });

  it("fires when only one axis is below 44", () => {
    expect(
      tinyTapTarget(el({ interactive: true, box: { w: 100, h: 30 } }), R, J),
    ).not.toBeNull();
  });

  it("guard: 48x48 target is NOT flagged", () => {
    expect(
      tinyTapTarget(el({ interactive: true, box: { w: 48, h: 48 } }), R, J),
    ).toBeNull();
  });

  it("guard: exactly 44x44 is NOT flagged (boundary)", () => {
    expect(
      tinyTapTarget(el({ interactive: true, box: { w: 44, h: 44 } }), R, J),
    ).toBeNull();
  });

  it("guard: missing box -> no finding", () => {
    expect(tinyTapTarget(el({ interactive: true }), R, J)).toBeNull();
  });

  it("guard: zero-area (unmeasured) box -> no finding", () => {
    expect(
      tinyTapTarget(el({ interactive: true, box: { w: 0, h: 0 } }), R, J),
    ).toBeNull();
  });

  it("guard: non-interactive tiny element is NOT flagged", () => {
    expect(tinyTapTarget(el({ tag: "span", box: { w: 10, h: 10 } }), R, J)).toBeNull();
  });
});

describe("dialogNoAccessibleName", () => {
  it("true positive: dialog with wrong role -> ux_gap/medium", () => {
    const f = dialogNoAccessibleName(
      el({ tag: "div", isDialog: true, role: "region", accessibleName: "Settings" }),
      R,
      J,
    );
    expect(f).toMatchObject({
      severity: "medium",
      category: "ux_gap",
      title: "Modal/dialog missing role or accessible name",
    });
  });

  it("true positive: role=dialog but NO accessible name -> flagged", () => {
    expect(
      dialogNoAccessibleName(el({ tag: "div", isDialog: true, role: "dialog" }), R, J),
    ).not.toBeNull();
  });

  it("guard: properly-labeled role=dialog is NOT flagged", () => {
    expect(
      dialogNoAccessibleName(
        el({ tag: "div", isDialog: true, role: "dialog", accessibleName: "Confirm" }),
        R,
        J,
      ),
    ).toBeNull();
  });

  it("guard: properly-labeled role=alertdialog is NOT flagged", () => {
    expect(
      dialogNoAccessibleName(
        el({ tag: "div", isDialog: true, role: "alertdialog", accessibleName: "Warning" }),
        R,
        J,
      ),
    ).toBeNull();
  });

  it("guard: element that is not a dialog -> no finding", () => {
    expect(
      dialogNoAccessibleName(el({ tag: "div", role: "dialog" }), R, J),
    ).toBeNull();
  });

  it("guard: missing isDialog field -> no finding", () => {
    expect(dialogNoAccessibleName(el({ tag: "div" }), R, J)).toBeNull();
  });
});

// --- Accessibility (axe-core) classification --------------------------------

function av(overrides: Partial<AxeViolation> = {}): AxeViolation {
  return {
    id: "color-contrast",
    impact: "serious",
    help: "Elements must have sufficient color contrast",
    helpUrl: "https://dequeuniversity.com/rules/axe/4.11/color-contrast",
    nodeCount: 3,
    ...overrides,
  };
}

describe("classifyAxe", () => {
  it("empty violations -> []", () => {
    expect(classifyAxe([], R, J)).toEqual([]);
  });

  it.each([
    ["critical", "high"],
    ["serious", "medium"],
    ["moderate", "low"],
    ["minor", "low"],
  ] as const)("impact %s -> severity %s, ux_gap, Accessibility: title", (impact, severity) => {
    const [f] = classifyAxe([av({ impact })], R, J);
    expect(f).toMatchObject({
      route: R,
      severity,
      category: "ux_gap",
    });
    expect(f.title.startsWith("Accessibility:")).toBe(true);
    expect(f.title).toBe("Accessibility: Elements must have sufficient color contrast");
  });

  it("evidence carries axe_id, impact, nodes, journey, helpUrl", () => {
    const [f] = classifyAxe([av({ id: "button-name", nodeCount: 7 })], R, J);
    expect(f.evidence).toMatchObject({
      axe_id: "button-name",
      impact: "serious",
      nodes: 7,
      journey: J,
    });
    expect(f.evidence.helpUrl).toContain("color-contrast");
  });

  it("detail includes the rule id, node count, and helpUrl", () => {
    const [f] = classifyAxe([av({ id: "label", nodeCount: 2 })], R, J);
    expect(f.detail).toContain('"label"');
    expect(f.detail).toContain("2 element(s)");
    expect(f.detail).toContain("https://dequeuniversity.com");
  });

  it("missing helpUrl -> evidence.helpUrl null, detail omits the See clause", () => {
    const [f] = classifyAxe([av({ helpUrl: undefined })], R, J);
    expect(f.evidence.helpUrl).toBeNull();
    expect(f.detail).not.toContain("See ");
  });

  it("unknown/missing impact -> skipped", () => {
    // Cast through unknown to simulate an axe rule with an unexpected impact.
    const bogus = av({ impact: "weird" as unknown as AxeViolation["impact"] });
    expect(classifyAxe([bogus], R, J)).toEqual([]);
  });

  it("dedupes by axe id: one finding per rule even with repeated ids", () => {
    const out = classifyAxe(
      [av({ id: "color-contrast", nodeCount: 3 }), av({ id: "color-contrast", nodeCount: 9 })],
      R,
      J,
    );
    expect(out).toHaveLength(1);
    expect(out[0].evidence.nodes).toBe(3); // first wins
  });

  it("distinct ids each produce a finding", () => {
    const out = classifyAxe(
      [av({ id: "color-contrast" }), av({ id: "button-name", impact: "critical" })],
      R,
      J,
    );
    expect(out.map((f) => f.evidence.axe_id).sort()).toEqual(["button-name", "color-contrast"]);
  });

  it("every finding carries route + journey", () => {
    const [f] = classifyAxe([av()], "/x", "jx");
    expect(f.route).toBe("/x");
    expect(f.evidence.journey).toBe("jx");
  });
});

describe("classifyPage with axeViolations (aggregation + back-compat)", () => {
  it("no axeViolations field -> identical output to before (back-compat)", () => {
    const base = obs({ consoleErrors: ["boom"] });
    const out = classifyPage(base);
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe("Console errors on page");
    expect(classifyPage(obs())).toEqual([]);
  });

  it("empty axeViolations array on a healthy page -> still no findings", () => {
    expect(classifyPage(obs({ axeViolations: [] }))).toEqual([]);
  });

  it("a11y findings appear alongside element + page findings", () => {
    const out = classifyPage(
      obs({
        consoleErrors: ["boom"],
        elements: [el({ interactive: true })], // icon-only no name
        axeViolations: [av({ id: "color-contrast", impact: "serious" })],
      }),
    );
    const titles = out.map((f) => f.title);
    expect(titles).toContain("Console errors on page");
    expect(titles).toContain("Interactive control has no accessible name");
    expect(titles).toContain("Accessibility: Elements must have sufficient color contrast");
  });
});

describe("classifyPage with elements (aggregation + back-compat)", () => {
  it("no elements field -> identical output to before (back-compat)", () => {
    const base = obs({ consoleErrors: ["boom"] });
    const withUndefined = classifyPage(base);
    expect(withUndefined).toHaveLength(1);
    expect(withUndefined[0].title).toBe("Console errors on page");
    // And a healthy page with no elements still yields nothing.
    expect(classifyPage(obs())).toEqual([]);
  });

  it("empty elements array on a healthy page -> still no findings", () => {
    expect(classifyPage(obs({ elements: [] }))).toEqual([]);
  });

  it("aggregates UX findings from elements alongside page-level findings", () => {
    const out = classifyPage(
      obs({
        consoleErrors: ["boom"],
        elements: [
          el({ interactive: true }), // icon-only no name
          el({ interactive: true, disabled: true }), // disabled no explanation
          el({ interactive: true, accessibleName: "OK", box: { w: 10, h: 10 } }), // tiny
          el({ tag: "div", isDialog: true, role: "region" }), // dialog no role/name
        ],
      }),
    );
    const titles = out.map((f) => f.title);
    expect(titles).toContain("Console errors on page");
    expect(titles).toContain("Interactive control has no accessible name");
    expect(titles).toContain("Disabled control with no explanation");
    expect(titles).toContain("Tap target smaller than 44px");
    expect(titles).toContain("Modal/dialog missing role or accessible name");
  });

  it("a clean element set adds no findings", () => {
    const out = classifyPage(
      obs({
        elements: [
          el({ interactive: true, accessibleName: "Save", box: { w: 48, h: 48 } }),
          el({
            tag: "div",
            isDialog: true,
            role: "dialog",
            accessibleName: "Confirm",
          }),
        ],
      }),
    );
    expect(out).toEqual([]);
  });

  it("every UX finding carries route + journey from the observation", () => {
    const out = classifyPage(
      obs({ route: "/x", journey: "jx", elements: [el({ interactive: true })] }),
    );
    expect(out[0].route).toBe("/x");
    expect(out[0].evidence.journey).toBe("jx");
  });
});
