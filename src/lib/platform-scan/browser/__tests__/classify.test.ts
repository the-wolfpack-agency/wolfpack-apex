/**
 * Unit tests for classifyPage — the pure core of the browser-journey scanner.
 * Every rule branch is exercised, plus a multi-finding page and a healthy page.
 */
import { classifyPage, type PageObservation } from "../classify";

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
