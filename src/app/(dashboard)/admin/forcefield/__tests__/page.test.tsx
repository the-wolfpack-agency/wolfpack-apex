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
