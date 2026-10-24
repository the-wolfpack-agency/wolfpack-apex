/** @jest-environment jsdom */
import "@testing-library/jest-dom";
const mockFetchWithRefresh = jest.fn();
jest.mock("@/lib/client-auth", () => ({ fetchWithRefresh: (...a: any[]) => mockFetchWithRefresh(...a) }));
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ForcefieldAssurance } from "@/components/forcefield/ForcefieldAssurance";

const DATA = {
  assurance: {
    controls: [
      { id: "enforce.inline", title: "Inline edge enforcement", status: "gap", detail: "Monitor mode.", enablement: "Turn protection on with the hero switch." },
      { id: "verify.replay", title: "Delegation replay defense (jti)", status: "active", detail: "Accepted once." },
    ],
    activeCount: 1, partialCount: 0, gapCount: 1, total: 2, score: 50,
  },
  adversarial: {
    results: [{ id: "replay", attack: "An agent replays a captured delegation.", control: "Replay defense (jti)", defended: true, detail: "first: verified, replay: claimed" }],
    defendedCount: 1, total: 1, allDefended: true,
  },
  breaches: {
    results: [
      { id: "token-replay", attack: "An attacker replays a stolen token.", realWorld: "OAuth token theft + replay.", coverage: "prevented", control: "Replay defense (jti).", detail: "" },
      { id: "supply-chain", attack: "Build-pipeline compromise.", realWorld: "SolarWinds class.", coverage: "out_of_scope", control: "Out of scope.", detail: "" },
    ],
    prevented: 1, detected: 0, outOfScope: 1, total: 2,
  },
  lowAndSlow: {
    profiles: [
      { id: "greedy-decoy", name: "Greedy scraper", evasive: false, detected: true, outcome: "aggressive_scraper (proven)" },
      { id: "patient-passive", name: "Patient passive reader", evasive: true, detected: false, outcome: "unclassified" },
    ],
    detected: 1, total: 2, rate: 50, evasiveRate: 0, note: "A truly passive, decoy-avoiding agent is the residual gap.",
  },
};

beforeEach(() => mockFetchWithRefresh.mockReset());

it("runs on open and shows the posture score, controls, and self-attack results", async () => {
  mockFetchWithRefresh.mockResolvedValue({ ok: true, json: async () => DATA });
  render(<ForcefieldAssurance />);
  // collapsed: does not fetch until opened
  expect(mockFetchWithRefresh).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText(/Assurance & self-test/i));
  await waitFor(() => expect(screen.getByTestId("assurance-score")).toHaveTextContent("50%"));
  expect(screen.getByTestId("assurance-control-enforce.inline")).toHaveTextContent(/gap/i);
  expect(screen.getByTestId("assurance-enable-enforce.inline")).toHaveTextContent(/To enable/i);
  expect(screen.getByTestId("assurance-selftest")).toHaveTextContent("1/1 defended");
  expect(screen.getByTestId("assurance-scenario-replay")).toHaveTextContent(/replays a captured delegation/i);
  // known-attack coverage renders, honestly including an out-of-scope class
  expect(screen.getByTestId("assurance-breach-token-replay")).toHaveTextContent(/prevented/i);
  expect(screen.getByTestId("assurance-breach-supply-chain")).toHaveTextContent(/out of scope/i);
  // low-and-slow honestly shows the missed profile
  expect(screen.getByTestId("lowslow-rate")).toHaveTextContent("50%");
  expect(screen.getByTestId("lowslow-patient-passive")).toHaveTextContent(/MISSED/);
});

it("surfaces an error without crashing", async () => {
  mockFetchWithRefresh.mockResolvedValue({ ok: false, json: async () => ({}) });
  render(<ForcefieldAssurance />);
  fireEvent.click(screen.getByText(/Assurance & self-test/i));
  await waitFor(() => expect(screen.getByTestId("assurance-error")).toBeInTheDocument());
});

it("a known-attack scenario whose detector stopped firing shows MISSED, not out of scope", async () => {
  const missed = {
    ...DATA,
    breaches: {
      results: [
        { id: "injection", attack: "An agent sends a live SQL injection payload.", realWorld: "Injection.", coverage: "missed", control: "Edge payload detector.", detail: "NOT detected by the payload engine" },
        { id: "supply-chain", attack: "Build-pipeline compromise.", realWorld: "SolarWinds class.", coverage: "out_of_scope", control: "Out of scope.", detail: "" },
      ],
      prevented: 0, detected: 0, missed: 1, outOfScope: 1, total: 2,
    },
  };
  mockFetchWithRefresh.mockResolvedValue({ ok: true, json: async () => missed });
  render(<ForcefieldAssurance />);
  fireEvent.click(screen.getByText(/Assurance & self-test/i));
  await waitFor(() => expect(screen.getByTestId("assurance-breach-injection")).toHaveTextContent(/MISSED/));
  expect(screen.getByTestId("assurance-breach-injection")).not.toHaveTextContent(/out of scope/i);
  expect(screen.getByTestId("breach-missed")).toHaveTextContent("1 MISSED");
});

it("shows no missed count when nothing is missed", async () => {
  mockFetchWithRefresh.mockResolvedValue({ ok: true, json: async () => DATA });
  render(<ForcefieldAssurance />);
  fireEvent.click(screen.getByText(/Assurance & self-test/i));
  await waitFor(() => expect(screen.getByTestId("assurance-score")).toBeInTheDocument());
  expect(screen.queryByTestId("breach-missed")).toBeNull();
});

it("renders unknown controls in neutral, with the evidence each status rests on", async () => {
  const withEvidence = {
    ...DATA,
    assurance: {
      controls: [
        {
          id: "enforce.inline", title: "Inline edge enforcement", status: "gap", detail: "No request was blocked.",
          evidence: [{ key: "ff.inline_block", proof: "site_analytics_events with blocked=true on site=instinct", windowDays: 7, count: 0, lastAt: "2026-08-01T00:00:00.000Z", state: "stale" }],
        },
        {
          id: "audit.hash_chain", title: "Tamper-evident audit (hash chain)", status: "unknown", detail: "Could not be measured.",
          evidence: [{ key: "audit.chain_verified", proof: "audit.chain_verified events", windowDays: 1, count: 0, lastAt: null, state: "error", error: "relation does not exist" }],
        },
        {
          id: "detect.decoys", title: "Web decoy traps", status: "active", detail: "Tripped.",
          evidence: [{ key: "ff.trap_tripped", proof: "trap events", windowDays: 30, count: 4, lastAt: "2026-10-23T00:00:00.000Z", state: "fresh" }],
        },
      ],
      activeCount: 1, partialCount: 0, gapCount: 1, unknownCount: 1, total: 3, score: 33, measuredAt: "2026-10-24T12:00:00.000Z",
    },
  };
  mockFetchWithRefresh.mockResolvedValue({ ok: true, json: async () => withEvidence });
  render(<ForcefieldAssurance />);
  fireEvent.click(screen.getByText(/Assurance & self-test/i));
  await waitFor(() => expect(screen.getByTestId("assurance-unknown-count")).toHaveTextContent("1 unknown"));
  expect(screen.getByTestId("assurance-control-audit.hash_chain")).toHaveAttribute("data-status", "unknown");
  expect(screen.getByTestId("assurance-status-audit.hash_chain")).toHaveTextContent("unknown");
  expect(screen.getByTestId("assurance-evidence-audit.hash_chain-audit.chain_verified")).toHaveTextContent(/could not be measured: relation does not exist/);
  expect(screen.getByTestId("assurance-evidence-enforce.inline-ff.inline_block")).toHaveTextContent(/none in 7d, last 2026-08-01/);
  expect(screen.getByTestId("assurance-evidence-detect.decoys-ff.trap_tripped")).toHaveTextContent(/4 in 30d/);
  expect(screen.getByTestId("assurance-measured-at")).toHaveTextContent("2026-10-24 12:00 UTC");
});
