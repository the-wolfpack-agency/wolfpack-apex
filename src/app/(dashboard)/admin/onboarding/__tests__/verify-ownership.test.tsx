/**
 * @jest-environment jsdom
 *
 * /admin/onboarding - ownership verification flow.
 *
 * Asserts: clicking "Verify ownership" on a target issues a token and renders it
 * with both placement instructions (HTTP file + DNS TXT); a "Check" that returns
 * verified shows the Verified banner; a "Check" that returns not-verified shows
 * the Not-yet-verified banner with the reason. fetchWithRefresh is mocked
 * (no raw fetch); routing requests are matched by URL + body.
 */

import "@testing-library/jest-dom";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const mockGetUser = jest.fn();
const mockFetch = jest.fn();
const mockPush = jest.fn();

jest.mock("next/navigation", () => ({ useRouter: () => ({ push: mockPush }) }));
jest.mock("@/lib/client-auth", () => ({
  getInstinctUser: () => mockGetUser(),
  jsonHeaders: () => ({ "Content-Type": "application/json" }),
  fetchWithRefresh: (...a: unknown[]) => mockFetch(...a),
}));

import OnboardingPage from "@/app/(dashboard)/admin/onboarding/page";

const okJson = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

const TOKEN = "f".repeat(64);
const ISSUE_RESPONSE = {
  ok: true,
  platform: "acme",
  token: TOKEN,
  status: "pending",
  verifiedAt: null,
  instructions: [
    { method: "http_well_known", summary: "Serve the token", location: `https://app.acme.com/.well-known/ogiam-site-verification.txt`, value: TOKEN },
    { method: "dns_txt", summary: "Add a DNS TXT record", location: "app.acme.com", value: `ogiam-site-verification=${TOKEN}` },
  ],
};

function routeFetch(handlers: { check?: () => Response }) {
  mockFetch.mockImplementation((url: string, opts?: { body?: string }) => {
    if (url === "/api/admin/platform-scans/targets" && !opts) {
      return Promise.resolve(okJson({ targets: [{ platform: "acme", baseUrl: "https://app.acme.com", hasStatic: false, hasApi: false, hasLogin: false }] }));
    }
    if (url === "/api/admin/platform-scans/verify-target") {
      const body = JSON.parse(opts?.body ?? "{}");
      if (body.action === "issue") return Promise.resolve(okJson(ISSUE_RESPONSE));
      if (body.action === "check" && handlers.check) return Promise.resolve(handlers.check());
    }
    return Promise.resolve(okJson({}));
  });
}

beforeEach(() => {
  mockGetUser.mockReset();
  mockFetch.mockReset();
  mockPush.mockReset();
  mockGetUser.mockReturnValue({ role: "cto" });
});

async function renderAndIssue() {
  render(<OnboardingPage />);
  const verifyBtn = await screen.findByTestId("onboard-verify-ownership");
  fireEvent.click(verifyBtn);
  await screen.findByTestId("onboard-verify-token");
}

describe("ownership verification flow", () => {
  test("issuing a token shows the token and both placement instructions", async () => {
    routeFetch({});
    await renderAndIssue();

    expect(screen.getByTestId("onboard-verify-token")).toHaveTextContent(TOKEN);
    const instructions = screen.getAllByTestId("onboard-verify-instruction");
    expect(instructions).toHaveLength(2); // http file + dns txt
    expect(screen.getByTestId("onboard-verify-check-http_well_known")).toBeInTheDocument();
    expect(screen.getByTestId("onboard-verify-check-dns_txt")).toBeInTheDocument();
  });

  test("check -> verified shows the Verified banner", async () => {
    routeFetch({ check: () => okJson({ ok: true, platform: "acme", method: "http_well_known", status: "verified", verifiedAt: "2026-06-27T00:00:00Z" }) });
    await renderAndIssue();

    fireEvent.click(screen.getByTestId("onboard-verify-check-http_well_known"));
    await waitFor(() => expect(screen.getByTestId("onboard-verify-banner-verified")).toBeInTheDocument());
    expect(screen.getByTestId("onboard-verify-banner-verified")).toHaveTextContent(/Verified/i);
  });

  test("check -> not verified shows the Not-yet-verified banner with reason", async () => {
    routeFetch({ check: () => okJson({ ok: false, platform: "acme", method: "dns_txt", status: "failed", verifiedAt: null, reason: "token_mismatch" }) });
    await renderAndIssue();

    fireEvent.click(screen.getByTestId("onboard-verify-check-dns_txt"));
    await waitFor(() => expect(screen.getByTestId("onboard-verify-banner-pending")).toBeInTheDocument());
    expect(screen.getByTestId("onboard-verify-banner-pending")).toHaveTextContent(/token_mismatch/);
  });

  test("redirects to /login when unauthenticated", () => {
    mockGetUser.mockReturnValue(null);
    render(<OnboardingPage />);
    expect(mockPush).toHaveBeenCalledWith("/login?next=/admin/onboarding");
  });
});
