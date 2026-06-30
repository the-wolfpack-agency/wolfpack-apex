/** @jest-environment jsdom */

import "@testing-library/jest-dom";

/**
 * Component: <MfaSettingsCard /> — self-service opt-in TOTP management.
 *
 * Proves the four states render and wire to the /api/auth/mfa/* routes via
 * fetchWithRefresh (mocked): disabled -> enroll shows secret + otpauth URL ->
 * entering a code confirms + shows recovery codes; confirmed state shows the
 * Disable control and disabling returns to the off state.
 */

const mockFetchWithRefresh = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: unknown[]) =>
    (mockFetchWithRefresh as unknown as (...args: unknown[]) => unknown)(...a),
  jsonHeaders: () => ({ "Content-Type": "application/json" }),
}));

import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import MfaSettingsCard from "@/components/MfaSettingsCard";

function mkRes(body: unknown, ok = true, status = 200): unknown {
  return { ok, status, json: async () => body };
}

beforeEach(() => {
  mockFetchWithRefresh.mockReset();
});

describe("<MfaSettingsCard />", () => {
  it("renders the disabled state when not enrolled", async () => {
    mockFetchWithRefresh.mockResolvedValueOnce(mkRes({ enrolled: false, confirmed: false, recoveryCodesRemaining: 0, confirmedAt: null }));
    render(<MfaSettingsCard />);
    expect(await screen.findByTestId("mfa-disabled")).toBeInTheDocument();
    expect(screen.getByTestId("mfa-enable-btn")).toBeInTheDocument();
  });

  it("renders the confirmed state when already enrolled", async () => {
    mockFetchWithRefresh.mockResolvedValueOnce(mkRes({ enrolled: true, confirmed: true, recoveryCodesRemaining: 7, confirmedAt: "2026-01-01T00:00:00Z" }));
    render(<MfaSettingsCard />);
    expect(await screen.findByTestId("mfa-confirmed")).toBeInTheDocument();
    expect(screen.getByText(/7 recovery codes remaining/)).toBeInTheDocument();
    expect(screen.getByTestId("mfa-disable-btn")).toBeInTheDocument();
  });

  it("enroll shows the secret + otpauth URL, then a valid code confirms and reveals recovery codes", async () => {
    mockFetchWithRefresh
      .mockResolvedValueOnce(mkRes({ enrolled: false, confirmed: false, recoveryCodesRemaining: 0, confirmedAt: null })) // status
      .mockResolvedValueOnce(mkRes({ secret: "JBSWY3DPEHPK3PXP", otpauthUrl: "otpauth://totp/Wolfpack%20Instinct:u@x.dev?secret=JBSWY3DPEHPK3PXP" })) // enroll
      .mockResolvedValueOnce(mkRes({ ok: true, recoveryCodes: ["aaaaa-11111", "bbbbb-22222"] })); // verify

    render(<MfaSettingsCard />);
    fireEvent.click(await screen.findByTestId("mfa-enable-btn"));

    expect(await screen.findByTestId("mfa-enrolling")).toBeInTheDocument();
    expect(screen.getByTestId("mfa-secret")).toHaveTextContent("JBSWY3DPEHPK3PXP");
    expect(screen.getByTestId("mfa-otpauth")).toHaveTextContent("otpauth://totp");

    fireEvent.change(screen.getByTestId("mfa-code-input"), { target: { value: "123456" } });
    fireEvent.click(screen.getByTestId("mfa-confirm-btn"));

    expect(await screen.findByTestId("mfa-recovery")).toBeInTheDocument();
    const codes = screen.getByTestId("mfa-recovery-codes");
    expect(codes).toHaveTextContent("aaaaa-11111");
    expect(codes).toHaveTextContent("bbbbb-22222");
  });

  it("shows an error when the entered code is rejected", async () => {
    mockFetchWithRefresh
      .mockResolvedValueOnce(mkRes({ enrolled: false, confirmed: false, recoveryCodesRemaining: 0, confirmedAt: null }))
      .mockResolvedValueOnce(mkRes({ secret: "S", otpauthUrl: "otpauth://x" }))
      .mockResolvedValueOnce(mkRes({ ok: false, error: "bad_code" }, false, 400));

    render(<MfaSettingsCard />);
    fireEvent.click(await screen.findByTestId("mfa-enable-btn"));
    fireEvent.change(await screen.findByTestId("mfa-code-input"), { target: { value: "000000" } });
    fireEvent.click(screen.getByTestId("mfa-confirm-btn"));

    expect(await screen.findByTestId("mfa-error")).toHaveTextContent(/didn't match/);
  });

  it("disable calls the route and returns to the disabled state", async () => {
    mockFetchWithRefresh
      .mockResolvedValueOnce(mkRes({ enrolled: true, confirmed: true, recoveryCodesRemaining: 5, confirmedAt: "2026-01-01T00:00:00Z" })) // status
      .mockResolvedValueOnce(mkRes({ ok: true, wasEnrolled: true })) // disable
      .mockResolvedValueOnce(mkRes({ enrolled: false, confirmed: false, recoveryCodesRemaining: 0, confirmedAt: null })); // reload status

    render(<MfaSettingsCard />);
    fireEvent.click(await screen.findByTestId("mfa-disable-btn"));
    expect(await screen.findByTestId("mfa-disabled")).toBeInTheDocument();

    await waitFor(() =>
      expect(mockFetchWithRefresh).toHaveBeenCalledWith("/api/auth/mfa/disable", expect.objectContaining({ method: "POST" })),
    );
  });
});
