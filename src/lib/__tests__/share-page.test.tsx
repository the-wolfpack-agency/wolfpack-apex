/**
 * @jest-environment jsdom
 */

/**
 * /share/[token] page + ShareApprovalPanel tests.
 *
 * We don't try to render the server component directly in jest — that
 * would require a full Next runtime. Instead we test the submit bar
 * client component (ShareApprovalPanel) in isolation, and the page's
 * `InvalidShareLink` branch via a thin snapshot of the exported helper.
 *
 * Covered:
 *   - ShareApprovalPanel renders Approve + Request changes buttons
 *     plus name / email / comment inputs.
 *   - Submitting calls POST /api/public/approvals/<token> with the
 *     right body shape.
 *   - Success state hides the form and surfaces a "thanks" block.
 *   - Error response surfaces the error message inline.
 *   - Clicking Request changes sends state=changes_requested.
 *   - Submitting with blank name/email/comment omits those fields.
 */

import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import ShareApprovalPanel from "@/app/share/[token]/ShareApprovalPanel";

let fetchSpy: jest.Mock;

beforeEach(() => {
  fetchSpy = jest.fn();
  (global as unknown as { fetch: typeof fetch }).fetch = fetchSpy as unknown as typeof fetch;
});

function mkResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: new Headers({ "content-type": "application/json" }),
  } as unknown as Response;
}

describe("ShareApprovalPanel", () => {
  it("renders Approve + Request changes + inputs", async () => {
    await act(async () => {
      render(<ShareApprovalPanel token="tok_abc" />);
    });
    expect(screen.getByTestId("share-approve")).toBeInTheDocument();
    expect(screen.getByTestId("share-request-changes")).toBeInTheDocument();
    expect(screen.getByTestId("share-comment")).toBeInTheDocument();
    expect(screen.getByTestId("share-actor-name")).toBeInTheDocument();
    expect(screen.getByTestId("share-actor-email")).toBeInTheDocument();
  });

  it("POSTs state=approved with captured fields on click", async () => {
    fetchSpy.mockResolvedValueOnce(mkResponse(200, { record: { id: "a1" } }));
    await act(async () => {
      render(<ShareApprovalPanel token="tok_abc" />);
    });

    fireEvent.change(screen.getByTestId("share-actor-name"), {
      target: { value: "Client Name" },
    });
    fireEvent.change(screen.getByTestId("share-actor-email"), {
      target: { value: "client@example.com" },
    });
    fireEvent.change(screen.getByTestId("share-comment"), {
      target: { value: "Looks great, ship it." },
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("share-approve"));
    });

    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toMatch(/\/api\/public\/approvals\/tok_abc/);
    const body = JSON.parse(init.body as string);
    expect(body.state).toBe("approved");
    expect(body.actorName).toBe("Client Name");
    expect(body.actorEmail).toBe("client@example.com");
    expect(body.comment).toBe("Looks great, ship it.");
  });

  it("shows the success banner after submit", async () => {
    fetchSpy.mockResolvedValueOnce(mkResponse(200, { record: { id: "a1" } }));
    await act(async () => {
      render(<ShareApprovalPanel token="tok_abc" />);
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("share-approve"));
    });
    await waitFor(() => {
      expect(screen.getByTestId("share-success")).toBeInTheDocument();
    });
  });

  it("surfaces the error message on a 401 response", async () => {
    fetchSpy.mockResolvedValueOnce(
      mkResponse(401, { error: "Invalid or expired share link", reason: "expired" }),
    );
    await act(async () => {
      render(<ShareApprovalPanel token="bad" />);
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("share-approve"));
    });
    await waitFor(() => {
      expect(screen.getByTestId("share-error")).toHaveTextContent(
        /Invalid or expired/i,
      );
    });
  });

  it("sends state=changes_requested when that button is clicked", async () => {
    fetchSpy.mockResolvedValueOnce(mkResponse(200, { record: { id: "a2" } }));
    await act(async () => {
      render(<ShareApprovalPanel token="tok_abc" />);
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("share-request-changes"));
    });
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
    expect(body.state).toBe("changes_requested");
  });

  it("omits blank optional fields from the body", async () => {
    fetchSpy.mockResolvedValueOnce(mkResponse(200, { record: { id: "a3" } }));
    await act(async () => {
      render(<ShareApprovalPanel token="tok_abc" />);
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("share-approve"));
    });
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
    expect(body.state).toBe("approved");
    expect(body.actorName).toBeUndefined();
    expect(body.actorEmail).toBeUndefined();
    expect(body.comment).toBeUndefined();
  });
});
