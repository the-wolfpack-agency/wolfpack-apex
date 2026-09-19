/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mockPush = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: mockPush }) }));

const mockFetch = jest.fn();
let user: unknown = { role: "cto" };
jest.mock("@/lib/client-auth", () => ({
  getInstinctUser: () => user,
  fetchWithRefresh: (...a: unknown[]) => mockFetch(...a),
  jsonHeaders: () => ({ "content-type": "application/json" }),
}));

import ForcefieldPage from "../page";

function resp(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}
const CANARY = { id: "c1", kind: "token", seededIn: "customers table", valueHint: "****9f3a", active: true, createdAt: "2026-09-17T00:00:00.000Z" };
const TRIP = { id: "t1", agent: "agent-x", whenIso: "2026-09-17T01:00:00.000Z", riskTier: "critical", reason: "1 canary trip(s) [customers table]; agent-x quarantined", contained: true };

/** URL/method-aware fetch double so tests do not depend on call ORDER (the page
 *  loads canaries + trips together). Tests set these state holders. */
let canaries: unknown[] = [];
let trips: unknown[] = [];
function routedFetch() {
  mockFetch.mockImplementation(async (url: string, opts?: { method?: string }) => {
    const method = opts?.method ?? "GET";
    if (url.includes("/forcefield/grid")) {
      canaries = [
        { ...CANARY, id: "a", kind: "token" }, { ...CANARY, id: "b", kind: "route" },
        { ...CANARY, id: "c", kind: "row" }, { ...CANARY, id: "d", kind: "tool" },
      ];
      return resp(200, { result: { seeded: [{ kind: "row", placement: "x" }, { kind: "tool", placement: "x" }], alreadyPresent: ["token", "route"], pendingPlacement: [] } });
    }
    if (url.includes("/forcefield/trips")) return resp(200, { trips });
    if (url.includes("/forcefield/canaries")) {
      if (method === "POST") { canaries = [CANARY]; return resp(201, { canary: CANARY }); }
      if (method === "DELETE") { canaries = [{ ...CANARY, active: false }]; return resp(200, { ok: true }); }
      return resp(200, { canaries });
    }
    return resp(404, {});
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  user = { role: "cto" };
  canaries = [];
  trips = [];
  routedFetch();
});

test("redirects an unauthenticated user instead of rendering an empty shell", () => {
  user = null;
  render(<ForcefieldPage />);
  expect(mockPush).toHaveBeenCalledWith("/login?next=/admin/forcefield");
  expect(screen.queryByTestId("forcefield")).not.toBeInTheDocument();
});

test("lists a canary with its MASKED hint, never a raw value", async () => {
  canaries = [CANARY];
  render(<ForcefieldPage />);
  await waitFor(() => expect(screen.getByTestId("ff-list")).toBeInTheDocument());
  expect(screen.getByText("****9f3a")).toBeInTheDocument();
  expect(screen.getByText(/in customers table/)).toBeInTheDocument();
  expect(screen.getByText("Active")).toBeInTheDocument();
});

test("empty state when no decoys are seeded", async () => {
  render(<ForcefieldPage />);
  await waitFor(() => expect(screen.getByTestId("ff-empty")).toBeInTheDocument());
});

test("seeds a decoy: POSTs the value, then the masked row appears (raw value never shown)", async () => {
  render(<ForcefieldPage />);
  await waitFor(() => expect(screen.getByTestId("ff-empty")).toBeInTheDocument());

  fireEvent.change(screen.getByTestId("seed-value"), { target: { value: "sk-decoy-9f3a" } });
  fireEvent.change(screen.getByTestId("seed-seededin"), { target: { value: "customers table" } });
  await act(async () => { fireEvent.click(screen.getByTestId("seed-submit")); });

  await waitFor(() => expect(screen.getByText("****9f3a")).toBeInTheDocument());
  const postCall = mockFetch.mock.calls.find((c) => (c[1] as { method?: string })?.method === "POST");
  expect(postCall).toBeTruthy();
  expect(String((postCall![1] as { body: string }).body)).toContain("sk-decoy-9f3a");
  expect(screen.queryByText("sk-decoy-9f3a")).not.toBeInTheDocument();
});

test("retires a decoy via DELETE and its Retire button disappears", async () => {
  canaries = [CANARY];
  render(<ForcefieldPage />);
  await waitFor(() => expect(screen.getByTestId("ff-retire")).toBeInTheDocument());
  await act(async () => { fireEvent.click(screen.getByTestId("ff-retire")); });

  await waitFor(() => expect(screen.queryByTestId("ff-retire")).not.toBeInTheDocument());
  const del = mockFetch.mock.calls.find((c) => (c[1] as { method?: string })?.method === "DELETE");
  expect(del).toBeTruthy();
  expect(String(del![0])).toContain("id=c1");
});

test("shows recent trips: the contained agent, the reason, and a Trips metric", async () => {
  trips = [TRIP];
  render(<ForcefieldPage />);
  await waitFor(() => expect(screen.getByTestId("trips-list")).toBeInTheDocument());
  expect(screen.getByText("agent-x")).toBeInTheDocument();
  expect(screen.getByText("Contained")).toBeInTheDocument();
  expect(screen.getByText(/canary trip/)).toBeInTheDocument();
});

test("trips empty state reads as the good state", async () => {
  render(<ForcefieldPage />);
  await waitFor(() => expect(screen.getByTestId("trips-empty")).toBeInTheDocument());
});

test("deception coverage panel: shows kind gaps and reads thin coverage honestly", async () => {
  canaries = [CANARY]; // only a 'token' decoy -> 3 kinds are gaps
  render(<ForcefieldPage />);
  await waitFor(() => expect(screen.getByTestId("deception-coverage")).toBeInTheDocument());
  expect(screen.getByTestId("coverage-kinds")).toHaveTextContent("1 / 4");
  expect(screen.getByTestId("coverage-kind-token")).toHaveTextContent(/✓/);
  expect(screen.getByTestId("coverage-kind-route")).toHaveTextContent(/gap/i);
  expect(screen.getByTestId("coverage-kind-row")).toHaveTextContent(/gap/i);
  expect(screen.getByTestId("coverage-kind-tool")).toHaveTextContent(/gap/i);
  // The whole point: a thin grid is not reassurance.
  expect(screen.getByTestId("coverage-assessment")).toHaveTextContent(/few traps/i);
});

test("deception coverage panel: full grid reads low trips as expected-by-design", async () => {
  canaries = [
    { ...CANARY, id: "a", kind: "token" },
    { ...CANARY, id: "b", kind: "route" },
    { ...CANARY, id: "c", kind: "row" },
    { ...CANARY, id: "d", kind: "tool" },
  ];
  trips = [TRIP];
  render(<ForcefieldPage />);
  await waitFor(() => expect(screen.getByTestId("deception-coverage")).toBeInTheDocument());
  expect(screen.getByTestId("coverage-kinds")).toHaveTextContent("4 / 4");
  expect(screen.getByTestId("coverage-assessment")).toHaveTextContent(/expected to be low by design/i);
});

test("seed-grid button appears only on gaps, POSTs to the grid route, and fills coverage", async () => {
  canaries = [{ ...CANARY, id: "a", kind: "token" }]; // 3 gaps -> button shows
  render(<ForcefieldPage />);
  await waitFor(() => expect(screen.getByTestId("coverage-seed-grid")).toBeInTheDocument());
  await act(async () => { fireEvent.click(screen.getByTestId("coverage-seed-grid")); });
  // POSTed to the grid route...
  const call = mockFetch.mock.calls.find((c) => String(c[0]).includes("/forcefield/grid") && (c[1] as { method?: string })?.method === "POST");
  expect(call).toBeTruthy();
  // ...and after reload the grid is full, so the button (gaps-only) is gone.
  await waitFor(() => expect(screen.getByTestId("coverage-kinds")).toHaveTextContent("4 / 4"));
  expect(screen.queryByTestId("coverage-seed-grid")).not.toBeInTheDocument();
});

test("threat coverage panel: shows the honest headline, gaps, and per-threat status", async () => {
  render(<ForcefieldPage />);
  await waitFor(() => expect(screen.getByTestId("threat-coverage")).toBeInTheDocument());
  // Honest headline: detected / observable (excludes code-level CWEs).
  expect(screen.getByTestId("coverage-headline")).toHaveTextContent(/\d+ \/ \d+ agent-observable threats detected/i);
  // The gaps callout names prompt injection - the "not caught off guard" part.
  const gaps = screen.getByTestId("coverage-gaps");
  expect(gaps).toHaveTextContent(/CWE-1427/);
  expect(gaps).toHaveTextContent(/gaps to close/i);
  // A covered injection CWE reads "covered"; a code-level CWE reads out-of-scope.
  expect(screen.getByTestId("coverage-row-CWE-89")).toHaveTextContent(/covered/i);
  expect(screen.getByTestId("coverage-row-CWE-352")).toHaveTextContent(/not agent observable/i);
  // The agent-specific OWASP-LLM classes are present.
  expect(screen.getByTestId("coverage-row-LLM08")).toHaveTextContent(/covered/i);
});
