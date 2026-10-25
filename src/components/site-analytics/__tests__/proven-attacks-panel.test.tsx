/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen, within } from "@testing-library/react";
import { ProvenAttacksPanel } from "@/components/site-analytics/ProvenAttacksPanel";
import type { ProvenAttacks, ProvenModeSummary } from "@/lib/site-analytics-proven";

const emptyProvenMode = (): ProvenModeSummary => ({ events: 0, fingerprints: null, withoutFingerprint: 0, lastSeen: null, byClass: [] });

const NOW = Date.parse("2026-10-24T12:00:00Z");

const PROVEN: ProvenAttacks = {
  available: true,
  generatedAt: "2026-10-24T12:00:00Z",
  excludedFalsePositives: 7828,
  sites: [
    {
      site: "ogiam.com",
      lastReportAt: "2026-10-24T11:30:00Z",
      excludedFalsePositives: 0,
      blocked: {
        events: 158, fingerprints: 12, withoutFingerprint: 82, lastSeen: "2026-10-24T10:00:00Z",
        byClass: [
          { attack: "decoy_trip", eventType: "site.agent_trap_tripped", count: 82, fingerprints: null, withoutFingerprint: 82, lastSeen: "2026-10-23T12:00:00Z" },
          { attack: "path_traversal", eventType: "site.agent_payload_attack", count: 76, fingerprints: 12, withoutFingerprint: 0, lastSeen: "2026-10-24T10:00:00Z" },
        ],
      },
      reportOnly: {
        events: 3, fingerprints: 2, withoutFingerprint: 1, lastSeen: "2026-10-22T12:00:00Z",
        byClass: [{ attack: "xss", eventType: "site.agent_payload_attack", count: 3, fingerprints: 2, withoutFingerprint: 1, lastSeen: "2026-10-22T12:00:00Z" }],
      },
    },
    {
      site: "instinct",
      lastReportAt: "2026-10-24T11:59:00Z",
      excludedFalsePositives: 7828,
      blocked: emptyProvenMode(),
      reportOnly: emptyProvenMode(),
    },
    {
      site: "weekendwithporsche",
      lastReportAt: "2026-10-20T12:00:00Z",
      excludedFalsePositives: 0,
      blocked: emptyProvenMode(),
      reportOnly: emptyProvenMode(),
    },
  ],
};

const base = { viewIntel: true, rangeDays: 30, blockedTotal: 158, now: NOW };

test("populated: per-site blocked attacks by class, fingerprints, last seen, report-only separate", () => {
  render(<ProvenAttacksPanel {...base} proven={PROVEN} />);
  const og = screen.getByTestId("proven-site-ogiam.com");
  expect(within(og).getByTestId("proven-site-ogiam.com-blocked-count")).toHaveTextContent("158 blocked");
  expect(within(og).getByTestId("proven-site-ogiam.com-report-only-count")).toHaveTextContent("3 report-only");
  const pt = screen.getByTestId("proven-ogiam.com-blocked-path_traversal");
  expect(pt).toHaveTextContent("76");
  expect(pt).toHaveTextContent("2h ago");
  expect(screen.getByTestId("proven-ogiam.com-blocked-path_traversal-fp")).toHaveTextContent("12");
  expect(screen.getByTestId("proven-ogiam.com-blocked-decoy_trip")).toHaveTextContent("Decoy trip");
  // report-only is its own table, not merged into blocked
  expect(screen.getByTestId("proven-ogiam.com-report-only-xss")).toHaveTextContent("3");
  expect(within(screen.getByTestId("proven-ogiam.com-blocked-table")).queryByText(/xss/i)).toBeNull();
  expect(screen.getByTestId("proven-attacks-totals")).toHaveTextContent("158 blocked");
  expect(screen.queryByTestId("proven-site-ogiam.com-stale")).toBeNull();
});

test("missing fingerprint reads 'fingerprint not recorded', never 0", () => {
  render(<ProvenAttacksPanel {...base} proven={PROVEN} />);
  const fp = screen.getByTestId("proven-ogiam.com-blocked-decoy_trip-fp");
  expect(fp).toHaveTextContent("fingerprint not recorded");
  expect(fp).not.toHaveTextContent(/^0$/);
  expect(screen.getByTestId("proven-ogiam.com-report-only-xss-fp")).toHaveTextContent("2 (+1 without fingerprint)");
});

test("empty: a site with zero proven events says so plainly, with what to check", () => {
  render(<ProvenAttacksPanel {...base} proven={PROVEN} />);
  const empty = screen.getByTestId("proven-site-weekendwithporsche-empty");
  expect(empty).toHaveTextContent("No blocked attacks reported in 30 days. If this site enforces, check that it reports blocks.");
  expect(screen.getByTestId("proven-site-weekendwithporsche-report-only-empty")).toBeInTheDocument();
  expect(screen.queryByTestId("proven-weekendwithporsche-blocked-table")).toBeNull();
});

test("stale: a site with no event for over a day is marked stale", () => {
  render(<ProvenAttacksPanel {...base} proven={PROVEN} />);
  expect(screen.getByTestId("proven-site-weekendwithporsche-stale")).toHaveTextContent(/stale: last event 4d ago/);
  expect(screen.queryByTestId("proven-site-instinct-stale")).toBeNull();
});

test("false-positive rows are excluded from counts but their number is shown", () => {
  render(<ProvenAttacksPanel {...base} proven={PROVEN} />);
  // instinct had 7,828 control-plane false positives: zero proven, not 7,828 attacks
  expect(screen.getByTestId("proven-site-instinct-blocked-count")).toHaveTextContent("0 blocked");
  expect(screen.getByTestId("proven-site-instinct-empty")).toBeInTheDocument();
  expect(screen.getByTestId("proven-site-instinct-excluded")).toHaveTextContent("7,828 control-plane false positives excluded");
  expect(screen.getByTestId("proven-attacks-totals")).not.toHaveTextContent("7,986");
  expect(screen.getByTestId("proven-attacks-asof")).toHaveTextContent("7,828 control-plane false-positive rows excluded");
});

test("error: a failed read renders an explicit error, not an empty table", () => {
  render(<ProvenAttacksPanel {...base} proven={{ ...PROVEN, available: false }} />);
  expect(screen.getByTestId("proven-attacks-error")).toHaveTextContent(/could not be loaded/i);
  expect(screen.queryByTestId("proven-site-ogiam.com")).toBeNull();
});

test("error: an intel response without the proven block (older API) is an error, not a blank", () => {
  render(<ProvenAttacksPanel {...base} proven={undefined} />);
  expect(screen.getByTestId("proven-attacks-error")).toBeInTheDocument();
});

test("no sites: explicit empty state", () => {
  render(<ProvenAttacksPanel {...base} proven={{ ...PROVEN, sites: [], excludedFalsePositives: 0 }} />);
  expect(screen.getByTestId("proven-attacks-no-sites")).toHaveTextContent(/No protected site reported any event in 30 days/);
});

test("gated: a viewer without forcefield.view sees the org-wide blocked count and why there is no breakdown", () => {
  render(<ProvenAttacksPanel {...base} viewIntel={false} proven={undefined} blockedTotal={282} />);
  expect(screen.getByTestId("proven-attacks-gated")).toHaveTextContent("282 requests blocked");
  expect(screen.getByTestId("proven-attacks-gated")).toHaveTextContent("forcefield.view");
  expect(screen.queryByTestId("proven-attacks-error")).toBeNull();
});
