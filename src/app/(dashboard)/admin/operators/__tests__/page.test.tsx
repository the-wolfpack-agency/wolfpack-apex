/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen, waitFor } from "@testing-library/react";
const mockPush = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: mockPush }) }));
const mockFetch = jest.fn();
let user: unknown = { role: "cto" };
jest.mock("@/lib/client-auth", () => ({ getInstinctUser: () => user, fetchWithRefresh: (...a: unknown[]) => mockFetch(...a), jsonHeaders: () => ({}) }));
import { fireEvent } from "@testing-library/react";
import OperatorsPage from "../page";
const resp = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;
const OP = { operatorKey: "op_abc", surfaces: ["ogiam.com", "client.com"], sightingCount: 3, threatLevel: "hostile", intent: "credential_stuffing", confidence: "proven", evidence: ["Seen on 2 surface(s), 3 sighting(s)."], firstSeen: "t1", lastSeen: "t2", summary: "s", disclaimer: "Does NOT establish a real-world identity.", blocked: false };
beforeEach(() => { jest.clearAllMocks(); user = { role: "cto" }; });

test("redirects an unauthenticated user", () => {
  user = null;
  render(<OperatorsPage />);
  expect(mockPush).toHaveBeenCalledWith("/login?next=/admin/operators");
});
test("renders the operators board ranked, with evidence + disclaimer", async () => {
  mockFetch.mockResolvedValue(resp(200, { operators: [OP] }));
  render(<OperatorsPage />);
  await waitFor(() => expect(screen.getByTestId("operators-list")).toBeInTheDocument());
  expect(screen.getByTestId("operators-list")).toHaveTextContent("hostile");
  expect(screen.getByTestId("operators-list")).toHaveTextContent("op_abc");
  expect(screen.getByTestId("operators-list")).toHaveTextContent("credential stuffing");
  expect(screen.getByTestId("operators-list")).toHaveTextContent(/does not establish a real-world identity/i);
});
test("honest empty state when no operators yet", async () => {
  mockFetch.mockResolvedValue(resp(200, { operators: [] }));
  render(<OperatorsPage />);
  await waitFor(() => expect(screen.getByTestId("operators-empty")).toBeInTheDocument());
});

test("blocking an operator posts to the block endpoint and reloads", async () => {
  mockFetch.mockResolvedValue(resp(200, { operators: [OP] }));
  render(<OperatorsPage />);
  await waitFor(() => expect(screen.getByTestId("operators-list")).toBeInTheDocument());
  mockFetch.mockClear();
  mockFetch.mockResolvedValueOnce(resp(200, { ok: true })).mockResolvedValueOnce(resp(200, { operators: [{ ...OP, blocked: true }] }));
  fireEvent.click(screen.getByTestId(`op-block-${OP.operatorKey}`));
  await waitFor(() => expect(screen.getByTestId(`op-blocked-${OP.operatorKey}`)).toBeInTheDocument());
  const [url, opts] = mockFetch.mock.calls[0];
  expect(url).toBe("/api/admin/operators/block");
  expect(JSON.parse(opts.body)).toMatchObject({ operatorKey: OP.operatorKey, block: true });
});
