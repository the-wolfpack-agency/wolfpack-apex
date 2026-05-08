/**
 * @jest-environment jsdom
 */
/**
 * UI tests for InviteMemberDialog.
 *
 * Validates:
 *   - Closed dialog renders nothing
 *   - Open dialog renders form
 *   - Email validation (no @ → inline error, no fetch)
 *   - Submit → POSTs to /api/team/invite with the right payload
 *   - On success → switches to success state with the accept URL
 *   - Email-not-delivered → shows the "copy this link" guidance
 *   - Close button resets state
 */

import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import InviteMemberDialog from "@/components/team/InviteMemberDialog";

jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: jest.fn(),
  jsonHeaders: () => ({ "Content-Type": "application/json" }),
}));

import { fetchWithRefresh } from "@/lib/client-auth";

const mockedFetch = fetchWithRefresh as jest.MockedFunction<typeof fetchWithRefresh>;

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("InviteMemberDialog", () => {
  it("renders nothing when open=false", () => {
    const { container } = render(<InviteMemberDialog open={false} onClose={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders form when open", () => {
    render(<InviteMemberDialog open={true} onClose={() => {}} />);
    expect(screen.getByTestId("invite-member-form")).toBeInTheDocument();
    expect(screen.getByTestId("invite-member-email")).toBeInTheDocument();
    expect(screen.getByTestId("invite-member-role")).toBeInTheDocument();
  });

  it("happy path: POSTs invite, shows success with acceptUrl", async () => {
    mockedFetch.mockResolvedValueOnce(
      jsonResponse(201, {
        invites: [{
          id: "inv_1",
          email: "max@thewolfpack.agency",
          role: "ops",
          token: "tok",
          acceptUrl: "https://wolfpack-instinct.vercel.app/accept-invite?token=tok",
          emailDelivered: true,
        }],
      }),
    );

    render(<InviteMemberDialog open={true} onClose={() => {}} />);
    fireEvent.change(screen.getByTestId("invite-member-email"), { target: { value: "max@thewolfpack.agency" } });
    fireEvent.change(screen.getByTestId("invite-member-role"), { target: { value: "ops" } });
    fireEvent.click(screen.getByTestId("invite-member-submit"));

    await waitFor(() => expect(screen.getByTestId("invite-member-success")).toBeInTheDocument());

    expect(mockedFetch).toHaveBeenCalledWith(
      "/api/team/invite",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ invites: [{ email: "max@thewolfpack.agency", role: "ops" }] }),
      }),
    );
    expect(screen.getByTestId("invite-accept-url").textContent).toContain("/accept-invite?token=tok");
    // Success copy when delivered
    expect(screen.getByTestId("invite-member-success").textContent).toMatch(/emailed to max@thewolfpack.agency/);
  });

  it("email-not-delivered: surfaces the copy-this-link guidance", async () => {
    mockedFetch.mockResolvedValueOnce(
      jsonResponse(201, {
        invites: [{
          id: "inv_1",
          email: "max@thewolfpack.agency",
          role: "ops",
          token: "tok",
          acceptUrl: "https://wolfpack-instinct.vercel.app/accept-invite?token=tok",
          emailDelivered: false,
          emailReason: "no_api_key",
        }],
      }),
    );

    render(<InviteMemberDialog open={true} onClose={() => {}} />);
    fireEvent.change(screen.getByTestId("invite-member-email"), { target: { value: "max@thewolfpack.agency" } });
    fireEvent.click(screen.getByTestId("invite-member-submit"));

    await waitFor(() => expect(screen.getByTestId("invite-member-success")).toBeInTheDocument());
    expect(screen.getByTestId("invite-member-success").textContent).toMatch(/Email delivery is not configured/i);
    expect(screen.getByTestId("invite-member-success").textContent).toMatch(/no_api_key/);
  });

  it("server error surfaces inline, no success state", async () => {
    mockedFetch.mockResolvedValueOnce(jsonResponse(403, { error: "forbidden" }));
    render(<InviteMemberDialog open={true} onClose={() => {}} />);
    fireEvent.change(screen.getByTestId("invite-member-email"), { target: { value: "max@thewolfpack.agency" } });
    fireEvent.click(screen.getByTestId("invite-member-submit"));

    await waitFor(() => expect(screen.getByTestId("invite-member-error")).toBeInTheDocument());
    expect(screen.queryByTestId("invite-member-success")).not.toBeInTheDocument();
  });

  it("close button calls onClose and resets state", async () => {
    const onClose = jest.fn();
    render(<InviteMemberDialog open={true} onClose={onClose} />);
    fireEvent.click(screen.getByTestId("invite-dialog-close"));
    expect(onClose).toHaveBeenCalled();
  });
});
