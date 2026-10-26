/** @jest-environment jsdom */
import "@testing-library/jest-dom";

/**
 * UI test for /forcefield/setup (onboarding steps 2-4). fetch is routed by URL
 * so each scenario controls exactly what the server says:
 *   - no setup key -> "start with your site", no API call;
 *   - unknown key (401) -> key cleared, same start state;
 *   - verify step renders BOTH proof options with the exact values;
 *   - verify 422 -> plain per-method reasons; 429 -> wait message;
 *   - verify 200 -> token stored as the dashboard token, connect + email steps
 *     render (no-code marked coming soon, concierge, the quick-start);
 *   - concierge click POSTs with the setup key; resend PUTs the address;
 *   - confirmed address shows step 4 done.
 */
const mockFetch = jest.fn();
beforeAll(() => { (global as { fetch: unknown }).fetch = (...a: unknown[]) => mockFetch(...a); });

import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import ForcefieldSetupPage from "../page";

const resp = (status: number, body: unknown = {}) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

const VERIFY_STATE = {
  requestId: "r1", site: "acme.com", email: "qa@thewolfpack.agency", step: "verify",
  ownership: { verified: false, method: null, verifiedAt: null, instructions: [
    { method: "dns_txt", summary: "", location: "acme.com", value: "ogiam-site-verification=abc123" },
    { method: "http_well_known", summary: "", location: "https://acme.com/.well-known/ogiam-site-verification.txt", value: "abc123" },
  ] },
  tenant: null, connection: null, notify: null, conciergeRequested: false,
};
const CONNECT_STATE = {
  ...VERIFY_STATE, step: "connect",
  ownership: { verified: true, method: "dns_txt", verifiedAt: "2026-10-26T10:00:00Z", instructions: [] },
  tenant: { id: "t1", siteLabel: "acme.com" },
  connection: { connected: false, everConnected: false, lastEventAt: null },
  notify: { email: "qa@thewolfpack.agency", status: "pending", confirmedAt: null },
};
const QUICKSTART = {
  connector: { key: "generic", title: "Other / any stack", managed: false, emits: { next: true, cloudflare: true }, steps: ["Pick the adapter"] },
  cloudflareEnv: { FORCEFIELD_SITE: "acme.com", SITE_ANALYTICS_INGEST_TOKEN: "ff_tok" },
  nextEnv: { FORCEFIELD_EDGE_TOKEN: "ff_tok" },
  nextSnippet: "export async function middleware() {}",
};

type Handler = (init?: RequestInit) => Response;
function route(map: Record<string, Handler>) {
  mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    const key = `${(init?.method ?? "GET").toUpperCase()} ${url}`;
    const h = map[key];
    if (!h) throw new Error(`unexpected fetch ${key}`);
    return h(init);
  });
}

beforeEach(() => { jest.clearAllMocks(); window.localStorage.clear(); });

it("with no setup key, offers to start and calls no API", async () => {
  render(<ForcefieldSetupPage />);
  expect(await screen.findByTestId("ff-setup-missing")).toBeInTheDocument();
  expect(mockFetch).not.toHaveBeenCalled();
});

it("an unknown setup key (401) is cleared and the start state shows", async () => {
  window.localStorage.setItem("ff_setup_key", "ffs_gone");
  route({ "GET /api/forcefield/onboarding": () => resp(401, { ok: false }) });
  render(<ForcefieldSetupPage />);
  expect(await screen.findByTestId("ff-setup-missing")).toBeInTheDocument();
  expect(window.localStorage.getItem("ff_setup_key")).toBeNull();
});

it("shows both ownership proofs with exact values and the key in the header", async () => {
  window.localStorage.setItem("ff_setup_key", "ffs_k");
  route({ "GET /api/forcefield/onboarding": () => resp(200, { ok: true, state: VERIFY_STATE }) });
  render(<ForcefieldSetupPage />);
  expect(await screen.findByTestId("ff-dns-value")).toHaveTextContent("ogiam-site-verification=abc123");
  expect(screen.getByTestId("ff-file-url")).toHaveTextContent("https://acme.com/.well-known/ogiam-site-verification.txt");
  expect(screen.getByTestId("ff-file-value")).toHaveTextContent("abc123");
  expect(screen.getByTestId("ff-setup-site")).toHaveTextContent("acme.com");
  const init = mockFetch.mock.calls[0][1] as RequestInit;
  expect((init.headers as Record<string, string>)["x-forcefield-setup"]).toBe("ffs_k");
});

it("a failed verify (422) explains each method in plain words", async () => {
  window.localStorage.setItem("ff_setup_key", "ffs_k");
  route({
    "GET /api/forcefield/onboarding": () => resp(200, { ok: true, state: VERIFY_STATE }),
    "POST /api/forcefield/onboarding/verify": () => resp(422, { ok: false, error: "not_verified", attempts: [{ method: "dns_txt", reason: "no_txt_record" }, { method: "http_well_known", reason: "http_404" }] }),
  });
  render(<ForcefieldSetupPage />);
  fireEvent.click(await screen.findByTestId("ff-verify"));
  const err = await screen.findByTestId("ff-verify-error");
  expect(err).toHaveTextContent(/DNS record: no TXT record found yet/);
  expect(err).toHaveTextContent(/File: the file returned HTTP 404/);
});

it("too many checks (429) asks the user to wait", async () => {
  window.localStorage.setItem("ff_setup_key", "ffs_k");
  route({
    "GET /api/forcefield/onboarding": () => resp(200, { ok: true, state: VERIFY_STATE }),
    "POST /api/forcefield/onboarding/verify": () => resp(429, { ok: false }),
  });
  render(<ForcefieldSetupPage />);
  fireEvent.click(await screen.findByTestId("ff-verify"));
  expect(await screen.findByTestId("ff-verify-error")).toHaveTextContent(/wait a few minutes/i);
});

it("a successful verify stores the dashboard token and shows connect + email steps", async () => {
  window.localStorage.setItem("ff_setup_key", "ffs_k");
  let verified = false;
  route({
    "GET /api/forcefield/onboarding": () => resp(200, { ok: true, state: verified ? CONNECT_STATE : VERIFY_STATE }),
    "POST /api/forcefield/onboarding/verify": () => { verified = true; return resp(200, { ok: true, token: "ff_tok", quickstart: QUICKSTART, notify: { status: "pending", delivered: true } }); },
    "GET /api/forcefield/my-setup": () => resp(200, { ok: true, quickstart: QUICKSTART, connection: { connected: false, everConnected: false, lastEventAt: null } }),
    "POST /api/forcefield/onboarding/concierge": () => resp(200, { ok: true }),
    "PUT /api/forcefield/alert-email": () => resp(200, { ok: true, status: "pending", delivered: true }),
  });
  render(<ForcefieldSetupPage />);
  fireEvent.click(await screen.findByTestId("ff-verify"));
  expect(await screen.findByTestId("ff-verified")).toHaveTextContent(/DNS record/);
  expect(window.localStorage.getItem("ff_dashboard_token")).toBe("ff_tok");
  expect(screen.getByTestId("ff-nocode")).toHaveTextContent(/Coming soon/);
  expect(await screen.findByTestId("ff-diy-cf")).toHaveTextContent("SITE_ANALYTICS_INGEST_TOKEN=ff_tok");
  expect(screen.getByTestId("ff-email-pending")).toHaveTextContent("qa@thewolfpack.agency");
  expect(screen.getByTestId("ff-open-dashboard")).toHaveAttribute("href", "/forcefield/dashboard");

  fireEvent.click(screen.getByTestId("ff-concierge"));
  expect(await screen.findByTestId("ff-concierge-done")).toBeInTheDocument();
  const concierge = mockFetch.mock.calls.find((c) => c[0] === "/api/forcefield/onboarding/concierge")!;
  expect(((concierge[1] as RequestInit).headers as Record<string, string>)["x-forcefield-setup"]).toBe("ffs_k");

  fireEvent.click(screen.getByTestId("ff-email-resend"));
  expect(await screen.findByTestId("ff-email-resent")).toBeInTheDocument();
  const put = mockFetch.mock.calls.find((c) => c[0] === "/api/forcefield/alert-email")!;
  expect(((put[1] as RequestInit).headers as Record<string, string>)["x-forcefield-token"]).toBe("ff_tok");
  expect(JSON.parse((put[1] as RequestInit).body as string)).toEqual({ email: "qa@thewolfpack.agency" });
});

it("a confirmed address shows the email step done", async () => {
  window.localStorage.setItem("ff_setup_key", "ffs_k");
  window.localStorage.setItem("ff_dashboard_token", "ff_tok");
  route({
    "GET /api/forcefield/onboarding": () => resp(200, { ok: true, state: { ...CONNECT_STATE, notify: { email: "qa@thewolfpack.agency", status: "confirmed", confirmedAt: "x" }, conciergeRequested: true } }),
    "GET /api/forcefield/my-setup": () => resp(200, { ok: true, quickstart: QUICKSTART, connection: { connected: true, everConnected: true, lastEventAt: "x" } }),
  });
  render(<ForcefieldSetupPage />);
  expect(await screen.findByTestId("ff-email-confirmed")).toHaveTextContent("qa@thewolfpack.agency");
  expect(screen.getByTestId("ff-concierge-done")).toBeInTheDocument();
  await waitFor(() => expect(screen.getByTestId("ff-setup-connection")).toHaveTextContent("Connected"));
});

it("a load failure shows a retry message, not a blank page", async () => {
  window.localStorage.setItem("ff_setup_key", "ffs_k");
  route({ "GET /api/forcefield/onboarding": () => resp(503, { ok: false }) });
  render(<ForcefieldSetupPage />);
  expect(await screen.findByTestId("ff-setup-error")).toBeInTheDocument();
});
