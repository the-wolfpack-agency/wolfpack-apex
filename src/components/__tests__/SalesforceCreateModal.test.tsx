/**
 * @jest-environment jsdom
 *
 * SalesforceCreateModal — render + submit guardrails.
 *
 * Why this matters: the modal is the ONLY create surface in the portal
 * MVP. Required-field omission, allow-listed field naming, and the
 * onCreated callback are all behaviors a regression here would break
 * silently — submit would 400 server-side after a confusing UI flash.
 */

import "@testing-library/jest-dom";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import SalesforceCreateModal from "@/components/SalesforceCreateModal";

jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: jest.fn(),
}));
import { fetchWithRefresh } from "@/lib/client-auth";

describe("SalesforceCreateModal", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("renders the contact field set when type=contacts", () => {
    render(
      <SalesforceCreateModal open type="contacts" onClose={() => {}} onCreated={() => {}} />,
    );
    expect(screen.getByTestId("sf-create-modal")).toBeInTheDocument();
    expect(screen.getByTestId("sf-create-field-LastName")).toBeInTheDocument();
    expect(screen.getByTestId("sf-create-field-Email")).toBeInTheDocument();
    expect(screen.queryByTestId("sf-create-field-Amount")).toBeNull();
  });

  test("renders the opportunity field set when type=opportunities", () => {
    render(
      <SalesforceCreateModal open type="opportunities" onClose={() => {}} onCreated={() => {}} />,
    );
    expect(screen.getByTestId("sf-create-field-Name")).toBeInTheDocument();
    expect(screen.getByTestId("sf-create-field-Amount")).toBeInTheDocument();
    expect(screen.getByTestId("sf-create-field-StageName")).toBeInTheDocument();
  });

  test("returns null markup when open=false", () => {
    const { container } = render(
      <SalesforceCreateModal open={false} type="contacts" onClose={() => {}} onCreated={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
  });

  test("submits POST with allow-listed payload and fires onCreated with returned id", async () => {
    const mockFetch = fetchWithRefresh as jest.MockedFunction<typeof fetchWithRefresh>;
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: "003abc" }),
    } as unknown as Response);

    const onCreated = jest.fn();
    render(
      <SalesforceCreateModal open type="contacts" onClose={() => {}} onCreated={onCreated} />,
    );

    fireEvent.change(screen.getByTestId("sf-create-field-LastName"), { target: { value: "Doe" } });
    fireEvent.change(screen.getByTestId("sf-create-field-Email"), { target: { value: "j@e.com" } });
    fireEvent.click(screen.getByTestId("sf-create-submit"));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("003abc"));
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/portal/salesforce/record",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"LastName":"Doe"'),
      }),
    );
  });

  test("renders the server error message when POST fails", async () => {
    const mockFetch = fetchWithRefresh as jest.MockedFunction<typeof fetchWithRefresh>;
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ error: "LastName required" }),
    } as unknown as Response);

    render(
      <SalesforceCreateModal open type="contacts" onClose={() => {}} onCreated={() => {}} />,
    );
    fireEvent.change(screen.getByTestId("sf-create-field-LastName"), { target: { value: "Doe" } });
    fireEvent.click(screen.getByTestId("sf-create-submit"));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("LastName required"),
    );
  });
});
