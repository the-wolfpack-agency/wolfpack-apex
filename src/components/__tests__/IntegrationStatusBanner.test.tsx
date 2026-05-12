/** @jest-environment jsdom */
 
import "@testing-library/jest-dom";
/**
 * IntegrationStatusBanner — surfaces ?ms / ?qbo OAuth callback outcomes
 * + the Azure error_description that ships back with denied flows.
 *
 * Primary bug this component catches: a user connecting MS 365 was
 * silently dumped at / with no explanation when Azure rejected (common
 * when .All scopes demand tenant admin consent). The banner now shows
 * the error code + first line of the Azure message + a plain-English
 * hint for the most common AADSTS codes.
 */

const mockPush = jest.fn();
const mockReplace = jest.fn();
const mockSearchParams: Record<string, string | null> = {};

jest.mock("next/navigation", () => ({
  useSearchParams: () => ({
    get: (k: string) => (k in mockSearchParams ? mockSearchParams[k] : null),
  }),
  useRouter: () => ({ push: mockPush, replace: mockReplace }),
}));

const mockFetch = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...args: any[]) => mockFetch(...args),
  jsonHeaders: () => ({ "Content-Type": "application/json" }),
}));

import { render, screen, fireEvent } from "@testing-library/react";
import IntegrationStatusBanner from "@/components/IntegrationStatusBanner";

beforeEach(() => {
  for (const k of Object.keys(mockSearchParams)) delete mockSearchParams[k];
  mockPush.mockReset();
  mockReplace.mockReset();
  mockFetch.mockReset();
  mockFetch.mockResolvedValue({ ok: true, json: async () => ({}) });
});

describe("IntegrationStatusBanner", () => {
  it("renders nothing when neither ?ms nor ?qbo is present", () => {
    render(<IntegrationStatusBanner />);
    expect(screen.queryByTestId("integration-status-banner")).toBeNull();
  });

  it("renders a success banner for ?ms=connected", () => {
    mockSearchParams.ms = "connected";
    render(<IntegrationStatusBanner />);
    const banner = screen.getByTestId("integration-status-banner");
    expect(banner).toHaveTextContent(/Microsoft 365 connected/);
  });

  it("renders denied state with the Azure error code + description", () => {
    mockSearchParams.ms = "denied";
    mockSearchParams.error_code = "consent_required";
    mockSearchParams.detail =
      "AADSTS65001: The user or administrator has not consented to use the application";
    render(<IntegrationStatusBanner />);
    const banner = screen.getByTestId("integration-status-banner");
    expect(banner).toHaveTextContent(/Microsoft 365 declined access/);
    expect(banner).toHaveTextContent(/consent_required/);
    expect(banner).toHaveTextContent(/AADSTS65001/);
    // Plain-English hint for admin-consent path
    expect(banner).toHaveTextContent(/tenant-wide scopes/);
  });

  it("shows the redirect-URI hint when the error_description contains AADSTS50011", () => {
    mockSearchParams.ms = "denied";
    mockSearchParams.detail =
      "AADSTS50011: The redirect URI specified in the request does not match";
    render(<IntegrationStatusBanner />);
    expect(
      screen.getByTestId("integration-status-banner"),
    ).toHaveTextContent(/redirect URI doesn't match/);
  });

  it("fires system.integration_connected analytics for success", () => {
    mockSearchParams.ms = "connected";
    render(<IntegrationStatusBanner />);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.event).toBe("system.integration_connected");
    expect(body.metadata.provider).toBe("microsoft");
    expect(body.metadata.status).toBe("connected");
  });

  it("fires system.integration_connect_failed analytics for denied", () => {
    mockSearchParams.ms = "denied";
    mockSearchParams.error_code = "access_denied";
    render(<IntegrationStatusBanner />);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.event).toBe("system.integration_connect_failed");
    expect(body.metadata.provider).toBe("microsoft");
    expect(body.metadata.status).toBe("denied");
    expect(body.metadata.error_code).toBe("access_denied");
  });

  it("dismiss strips the ms/qbo/detail params from the URL", () => {
    mockSearchParams.ms = "denied";
    mockSearchParams.detail = "something";
    render(<IntegrationStatusBanner />);
    fireEvent.click(screen.getByTestId("integration-status-banner-dismiss"));
    expect(mockReplace).toHaveBeenCalledTimes(1);
    const newUrl = mockReplace.mock.calls[0][0];
    expect(newUrl).not.toContain("ms=");
    expect(newUrl).not.toContain("detail=");
  });

  it("also handles QuickBooks via ?qbo", () => {
    mockSearchParams.qbo = "denied";
    render(<IntegrationStatusBanner />);
    expect(screen.getByTestId("integration-status-banner")).toHaveTextContent(
      /QuickBooks declined access/,
    );
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.metadata.provider).toBe("quickbooks");
  });
});
