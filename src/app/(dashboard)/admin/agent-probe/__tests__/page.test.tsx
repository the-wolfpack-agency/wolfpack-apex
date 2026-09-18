/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

const mockPush = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: mockPush }) }));
const mockFetch = jest.fn();
let user: unknown = { role: "cto" };
jest.mock("@/lib/client-auth", () => ({
  getInstinctUser: () => user,
  fetchWithRefresh: (...a: unknown[]) => mockFetch(...a),
  jsonHeaders: () => ({ "content-type": "application/json" }),
}));

import AgentProbePage from "../page";

function resp(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}
const RESULT = {
  targetHost: "ogiam.com",
  report: {
    journey: { behaviorClass: "vuln_scanner", confidence: "proven", path: ["/", "/admin"], summary: "s" },
    scaffolding: { pathDiscovery: "path-guessing", readsRobotsFirst: false, guessedPaths: 2, probedSensitive: true },
  },
  dossier: {
    operatorKey: "op_abc123", threatLevel: "hostile", intent: "intrusion_attempt", confidence: "proven",
    policies: ["unauthorized-access"], evidence: ["Seen on 1 surface(s), 2 sighting(s).", "[ogiam.com] vuln scanner (proven)."],
    summary: "s", disclaimer: "Attributes behavior to a consistent operator profile. Does NOT establish a real-world identity.",
  },
};

beforeEach(() => { jest.clearAllMocks(); user = { role: "cto" }; });

test("redirects an unauthenticated user", () => {
  user = null;
  render(<AgentProbePage />);
  expect(mockPush).toHaveBeenCalledWith("/login?next=/admin/agent-probe");
  expect(screen.queryByTestId("agent-probe")).not.toBeInTheDocument();
});

test("runs a probe and renders the behavior report + operator dossier", async () => {
  mockFetch.mockResolvedValue(resp(200, RESULT));
  render(<AgentProbePage />);
  await waitFor(() => expect(screen.getByTestId("ap-run")).toBeInTheDocument());
  fireEvent.click(screen.getByTestId("ap-run"));

  await waitFor(() => expect(screen.getByTestId("ap-result")).toBeInTheDocument());
  expect(screen.getByTestId("ap-behavior")).toHaveTextContent("vuln scanner");
  expect(screen.getByTestId("ap-threat")).toHaveTextContent("hostile");
  expect(screen.getByTestId("ap-confidence")).toHaveTextContent("proven");
  expect(screen.getByTestId("ap-path")).toHaveTextContent("/admin");
  expect(screen.getByTestId("ap-evidence")).toHaveTextContent("vuln scanner");
  // The not-a-real-identity disclaimer is always shown.
  expect(screen.getByTestId("ap-disclaimer")).toHaveTextContent(/does not establish a real-world identity/i);

  // It POSTed the chosen tier + fixed target.
  const [, opts] = mockFetch.mock.calls[0];
  expect(JSON.parse(opts.body)).toMatchObject({ tier: "cheap", targetBase: "https://ogiam.com" });
});

test("shows an error if the run fails", async () => {
  mockFetch.mockResolvedValue(resp(500, {}));
  render(<AgentProbePage />);
  await waitFor(() => expect(screen.getByTestId("ap-run")).toBeInTheDocument());
  fireEvent.click(screen.getByTestId("ap-run"));
  await waitFor(() => expect(screen.getByTestId("ap-error")).toBeInTheDocument());
});
