/**
 * @jest-environment jsdom
 */

/**
 * DomainManager — UI tests.
 *
 * Mocks `global.fetch` (through fetchWithRefresh) so we never hit the
 * real /api route. Verifies empty state, render of pending + verified
 * rows, Add → POST, Refresh → PATCH, Remove → confirm + DELETE.
 */

import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import DomainManager, { type DomainRecordView } from "@/components/sites/DomainManager";

let fetchSpy: jest.Mock;

beforeEach(() => {
  fetchSpy = jest.fn();
  (global as unknown as { fetch: typeof fetch }).fetch = fetchSpy as unknown as typeof fetch;
  window.localStorage.setItem("instinct_token", "test-token");
  // Silence the confirm() dialog — individual tests override when needed.
  jest.spyOn(window, "confirm").mockReturnValue(true);
  jest.spyOn(window, "alert").mockImplementation(() => {});
  Object.assign(navigator, {
    clipboard: { writeText: jest.fn().mockResolvedValue(undefined) },
  });
});

afterEach(() => {
  window.localStorage.clear();
  jest.restoreAllMocks();
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

function mkDomain(overrides: Partial<DomainRecordView> = {}): DomainRecordView {
  return {
    id: "d_1",
    site_id: "site_1",
    domain: "acme.com",
    status: "pending",
    verification_records: [
      { type: "TXT", domain: "_vercel.acme.com", value: "vc-abc123" },
    ],
    added_at: new Date().toISOString(),
    verified_at: null,
    removed_at: null,
    last_error: null,
    ...overrides,
  };
}

describe("DomainManager", () => {
  it("shows empty state when no domains are attached", async () => {
    fetchSpy.mockResolvedValueOnce(mkResponse(200, { domains: [] }));
    await act(async () => {
      render(<DomainManager siteId="site_1" previewUrl="https://wolfpack-acme.vercel.app" />);
    });
    await waitFor(() => {
      expect(screen.getByTestId("domain-empty-state")).toBeInTheDocument();
    });
    expect(screen.getByTestId("domain-empty-state")).toHaveTextContent(
      /No custom domains yet/i,
    );
  });

  it("renders a pending row with its DNS verification records", async () => {
    fetchSpy.mockResolvedValueOnce(mkResponse(200, { domains: [mkDomain()] }));
    await act(async () => {
      render(<DomainManager siteId="site_1" previewUrl={null} />);
    });
    await waitFor(() => {
      expect(screen.getByTestId("domain-row-acme.com")).toBeInTheDocument();
    });
    expect(screen.getByTestId("domain-status-acme.com")).toHaveTextContent(
      /Pending/i,
    );
    expect(screen.getByTestId("domain-verification-acme.com")).toHaveTextContent(
      /_vercel\.acme\.com/,
    );
    expect(screen.getByTestId("domain-verification-acme.com")).toHaveTextContent(
      /vc-abc123/,
    );
  });

  it("renders a verified row without the verification block", async () => {
    fetchSpy.mockResolvedValueOnce(
      mkResponse(200, {
        domains: [mkDomain({ status: "verified", verification_records: [] })],
      }),
    );
    await act(async () => {
      render(<DomainManager siteId="site_1" previewUrl={null} />);
    });
    await waitFor(() => {
      expect(screen.getByTestId("domain-status-acme.com")).toHaveTextContent(
        /Verified/,
      );
    });
    expect(
      screen.queryByTestId("domain-verification-acme.com"),
    ).not.toBeInTheDocument();
  });

  it("Add submits POST with the input value and then refetches", async () => {
    // initial GET → empty, then POST → pending, then GET → one row.
    fetchSpy
      .mockResolvedValueOnce(mkResponse(200, { domains: [] }))
      .mockResolvedValueOnce(
        mkResponse(200, {
          domain: "new.com",
          status: "pending",
          verification: [],
        }),
      )
      .mockResolvedValueOnce(
        mkResponse(200, { domains: [mkDomain({ domain: "new.com" })] }),
      );
    await act(async () => {
      render(<DomainManager siteId="site_1" previewUrl={null} />);
    });
    await waitFor(() =>
      expect(screen.getByTestId("domain-empty-state")).toBeInTheDocument(),
    );

    const input = screen.getByTestId("domain-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "new.com" } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("domain-add-button"));
    });

    await waitFor(() => {
      // First call = initial GET, second = POST, third = GET refresh.
      expect(fetchSpy.mock.calls.length).toBeGreaterThanOrEqual(3);
    });
    const postCall = fetchSpy.mock.calls.find(
      (c) => (c[1] as RequestInit)?.method === "POST",
    )!;
    expect(postCall[0]).toBe("/api/sites/site_1/domain");
    const body = JSON.parse(String((postCall[1] as RequestInit).body));
    expect(body.domain).toBe("new.com");
  });

  it("Add surfaces server error in the UI", async () => {
    fetchSpy
      .mockResolvedValueOnce(mkResponse(200, { domains: [] }))
      .mockResolvedValueOnce(
        mkResponse(409, { error: "Domain already attached" }),
      );
    await act(async () => {
      render(<DomainManager siteId="site_1" previewUrl={null} />);
    });
    await waitFor(() => screen.getByTestId("domain-empty-state"));
    fireEvent.change(screen.getByTestId("domain-input"), {
      target: { value: "dup.com" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("domain-add-button"));
    });
    await waitFor(() =>
      expect(screen.getByTestId("domain-error")).toHaveTextContent(/already attached/i),
    );
  });

  it("Refresh button on a pending row calls PATCH action=refresh", async () => {
    fetchSpy
      .mockResolvedValueOnce(mkResponse(200, { domains: [mkDomain()] }))
      .mockResolvedValueOnce(
        mkResponse(200, { record: mkDomain({ status: "verified" }) }),
      )
      .mockResolvedValueOnce(
        mkResponse(200, { domains: [mkDomain({ status: "verified" })] }),
      );
    await act(async () => {
      render(<DomainManager siteId="site_1" previewUrl={null} />);
    });
    await waitFor(() => screen.getByTestId("domain-row-acme.com"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("domain-refresh-acme.com"));
    });
    const patchCall = fetchSpy.mock.calls.find(
      (c) => (c[1] as RequestInit)?.method === "PATCH",
    );
    expect(patchCall).toBeTruthy();
    const body = JSON.parse(String((patchCall![1] as RequestInit).body));
    expect(body).toEqual({ domain: "acme.com", action: "refresh" });
  });

  it("Remove fires confirm() and then DELETE with ?domain=", async () => {
    (window.confirm as jest.Mock).mockReturnValue(true);
    fetchSpy
      .mockResolvedValueOnce(mkResponse(200, { domains: [mkDomain()] }))
      .mockResolvedValueOnce(mkResponse(200, { ok: true }))
      .mockResolvedValueOnce(
        mkResponse(200, { domains: [mkDomain({ status: "removed" })] }),
      );
    await act(async () => {
      render(<DomainManager siteId="site_1" previewUrl={null} />);
    });
    await waitFor(() => screen.getByTestId("domain-row-acme.com"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("domain-remove-acme.com"));
    });
    expect(window.confirm).toHaveBeenCalled();
    const delCall = fetchSpy.mock.calls.find(
      (c) => (c[1] as RequestInit)?.method === "DELETE",
    );
    expect(delCall).toBeTruthy();
    expect(String(delCall![0])).toContain("?domain=acme.com");
  });

  it("Remove cancellation: confirm()=false → no DELETE fires", async () => {
    (window.confirm as jest.Mock).mockReturnValue(false);
    fetchSpy.mockResolvedValueOnce(mkResponse(200, { domains: [mkDomain()] }));
    await act(async () => {
      render(<DomainManager siteId="site_1" previewUrl={null} />);
    });
    await waitFor(() => screen.getByTestId("domain-row-acme.com"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("domain-remove-acme.com"));
    });
    const delCall = fetchSpy.mock.calls.find(
      (c) => (c[1] as RequestInit)?.method === "DELETE",
    );
    expect(delCall).toBeUndefined();
  });

  it("copy DNS record button writes to clipboard", async () => {
    fetchSpy.mockResolvedValueOnce(mkResponse(200, { domains: [mkDomain()] }));
    await act(async () => {
      render(<DomainManager siteId="site_1" previewUrl={null} />);
    });
    await waitFor(() => screen.getByTestId("domain-verification-acme.com"));
    const copyBtn = screen.getByLabelText(/Copy DNS TXT record/i);
    fireEvent.click(copyBtn);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      expect.stringContaining("vc-abc123"),
    );
  });
});
