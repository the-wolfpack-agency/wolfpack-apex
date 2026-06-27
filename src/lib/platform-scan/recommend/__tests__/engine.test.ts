/**
 * Deterministic recommendation engine: pure rules over a SystemProfile + open
 * findings. These tests pin every rule's key + priority, the integration
 * tailoring, the operational always-present recs, dedup, and the critical-first
 * sort, so a rule change that drops or re-keys a proposal is caught here.
 */
import { recommendAutomations, type RecommendInput } from "@/lib/platform-scan/recommend/engine";
import type { ScanFindingRow } from "@/lib/platform-scan/store";
import type { SystemProfile } from "@/lib/platform-scan/profile/types";
import type { ScanSeverity, ScanCategory } from "@/lib/platform-scan/types";

let seq = 0;
function finding(
  title: string,
  category: ScanCategory,
  severity: ScanSeverity = "high",
): ScanFindingRow {
  seq += 1;
  return {
    id: `f-${seq}`,
    scanId: "scan-1",
    platform: "acme",
    route: `/r/${seq}`,
    severity,
    category,
    title,
    detail: "",
    evidence: {},
    status: "open",
    createdAt: "2026-06-27T00:00:00.000Z",
  };
}

function profile(overrides: Partial<SystemProfile> = {}): SystemProfile {
  return {
    platform: "acme",
    surface: { pages: 1, apiRoutes: 1, components: 1, libModules: 1, migrations: 0, tests: 5, totalFiles: 50 },
    entities: [],
    integrations: [],
    authModel: { publicRoutes: 1, protectedRoutes: 1 },
    riskSummary: { critical: 0, high: 0, medium: 0, low: 0, total: 0 },
    generatedAt: "2026-06-27T00:00:00.000Z",
    ...overrides,
  };
}

function run(over: Partial<RecommendInput> = {}) {
  return recommendAutomations({ platform: "acme", profile: null, findings: [], scanCount: 5, ...over });
}

function byKey(recs: ReturnType<typeof run>, key: string) {
  return recs.find((r) => r.key === key);
}

beforeEach(() => { seq = 0; });

it("maps a missing CSP finding to security_remediation:headers at high priority", () => {
  const recs = run({ findings: [finding("Missing Content-Security-Policy", "security")] });
  const r = byKey(recs, "security_remediation:headers");
  expect(r).toBeDefined();
  expect(r!.priority).toBe("high");
});

it("maps a hardcoded secret to security_remediation:secrets at critical priority", () => {
  const recs = run({ findings: [finding("Hardcoded secret (AWS access key id)", "security", "critical")] });
  const r = byKey(recs, "security_remediation:secrets");
  expect(r).toBeDefined();
  expect(r!.priority).toBe("critical");
  // Critical-first sort.
  expect(recs[0].priority).toBe("critical");
});

it("maps an auth gap to security_remediation:auth at critical priority", () => {
  const recs = run({ findings: [finding("Protected route served content without auth", "security", "critical")] });
  const r = byKey(recs, "security_remediation:auth");
  expect(r).toBeDefined();
  expect(r!.priority).toBe("critical");
  expect(recs[0].priority).toBe("critical");
});

it("maps a credentialed CORS wildcard to security_remediation:cors", () => {
  const recs = run({ findings: [finding("CORS wildcard with credentials", "security", "critical")] });
  const r = byKey(recs, "security_remediation:cors");
  expect(r).toBeDefined();
});

it("maps an unguarded fetch (bug) to quality:fetch_guards at medium priority", () => {
  const recs = run({ findings: [finding("fetch result used without an ok/status check", "bug", "medium")] });
  const r = byKey(recs, "quality:fetch_guards");
  expect(r).toBeDefined();
  expect(r!.priority).toBe("medium");
});

it("tailors a known integration (Stripe) into a payment-reconciliation rec", () => {
  const recs = run({ profile: profile({ integrations: [{ name: "Stripe", package: "stripe", category: "Payments" }] }) });
  const r = byKey(recs, "integration:stripe");
  expect(r).toBeDefined();
  expect(r!.title.toLowerCase()).toMatch(/payment reconciliation/);
});

it("falls back to a generic low-priority rec for an unknown integration", () => {
  const recs = run({ profile: profile({ integrations: [{ name: "Acme", package: "acme-sdk", category: "Other" }] }) });
  const r = byKey(recs, "integration:acme");
  expect(r).toBeDefined();
  expect(r!.priority).toBe("low");
  expect(r!.title).toBe("Automate Acme workflows");
});

it("recommends a CI test gate at high priority when there are zero tests", () => {
  const recs = run({ profile: profile({ surface: { ...profile().surface, tests: 0, totalFiles: 80 } }) });
  const r = byKey(recs, "quality:ci_tests");
  expect(r).toBeDefined();
  expect(r!.priority).toBe("high");
});

it("recommends RLS verification when migrations exist", () => {
  const recs = run({ profile: profile({ surface: { ...profile().surface, migrations: 3 } }) });
  expect(byKey(recs, "security_remediation:rls")).toBeDefined();
});

it("recommends an initial scan at high priority when scanCount is 0", () => {
  const recs = run({ scanCount: 0 });
  const r = byKey(recs, "operational:scan_cadence");
  expect(r).toBeDefined();
  expect(r!.priority).toBe("high");
  expect(r!.title).toMatch(/initial security scan/i);
});

it("recommends recurring scans at low priority once a scan has run", () => {
  const recs = run({ scanCount: 4 });
  const r = byKey(recs, "operational:scan_cadence");
  expect(r).toBeDefined();
  expect(r!.priority).toBe("low");
  expect(r!.title).toMatch(/recurring/i);
});

it("always proposes operational:sast", () => {
  expect(byKey(run(), "operational:sast")).toBeDefined();
});

it("dedups: each key appears at most once even when a rule fires twice", () => {
  const recs = run({
    findings: [
      finding("Missing Content-Security-Policy", "security"),
      finding("Missing Strict-Transport-Security", "security"),
    ],
  });
  const headerRecs = recs.filter((r) => r.key === "security_remediation:headers");
  expect(headerRecs).toHaveLength(1);
  const keys = recs.map((r) => r.key);
  expect(new Set(keys).size).toBe(keys.length);
});

it("returns the operational recs for empty input (no profile, no findings, scanCount 0)", () => {
  const recs = recommendAutomations({ platform: "acme", profile: null, findings: [], scanCount: 0 });
  expect(byKey(recs, "operational:scan_cadence")).toBeDefined();
  expect(byKey(recs, "operational:sast")).toBeDefined();
});
