/** @jest-environment jsdom */

import "@testing-library/jest-dom";

/**
 * UI tests for the connectors admin page (/admin/connectors), focused on the
 * Advanced "paste static credentials" form. Asserts: the bearer path still POSTs
 * its original {connectorName, baseUrl, authHeader, objectMap} shape (no
 * regression); selecting "Username & password" reveals the form-login fields and
 * submitting POSTs the {authType:"username_password", username, password,
 * loginPath, ...} body; an error response surfaces the page's error state.
 * fetchWithRefresh + next/navigation are mocked; the create call is asserted by
 * matching the POST to /api/admin/connectors.
 */

const mockFetchWithRefresh = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: unknown[]) =>
    (mockFetchWithRefresh as unknown as (...args: unknown[]) => unknown)(...a),
  jsonHeaders: () => ({ "Content-Type": "application/json" }),
}));

jest.mock("next/navigation", () => ({
  useSearchParams: () => ({ get: () => null }),
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
  usePathname: () => "/admin/connectors",
}));

import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import AdminConnectorsPage from "@/app/(dashboard)/admin/connectors/page";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mkRes(body: unknown, opts: { ok?: boolean; status?: number } = {}): any {
  return { ok: opts.ok ?? true, status: opts.status ?? 200, json: async () => body };
}

/** GET list → empty; POST create → ok. Returns the recorded POST body. */
function routeOk() {
  mockFetchWithRefresh.mockImplementation((url: string, opts?: { method?: string }) => {
    if (url === "/api/admin/connectors" && opts?.method === "POST") {
      return Promise.resolve(mkRes({ ok: true }));
    }
    // initial list load + anything else
    return Promise.resolve(mkRes({ connectors: [] }));
  });
}

function createPost() {
  return mockFetchWithRefresh.mock.calls.find(
    (c) => c[0] === "/api/admin/connectors" && c[1]?.method === "POST",
  );
}

beforeEach(() => mockFetchWithRefresh.mockReset());

it("bearer-token create still POSTs its original shape (no regression)", async () => {
  routeOk();
  render(<AdminConnectorsPage />);
  // wait for the initial list load so the form is interactive
  await waitFor(() => expect(mockFetchWithRefresh).toHaveBeenCalled());

  fireEvent.change(screen.getByTestId("conn-base-url"), {
    target: { value: "https://api.acme.com" },
  });
  fireEvent.change(screen.getByTestId("conn-auth-header"), {
    target: { value: "Bearer abc123" },
  });
  fireEvent.click(screen.getByTestId("conn-submit"));

  await waitFor(() => expect(createPost()).toBeTruthy());
  const body = JSON.parse(String(createPost()![1].body));
  expect(body.authType).toBeUndefined();
  expect(body.authHeader).toBe("Bearer abc123");
  expect(body.connectorName).toBe("rest-default");
  expect(body.username).toBeUndefined();
});

it("selecting 'Username & password' reveals the form-login fields", async () => {
  routeOk();
  render(<AdminConnectorsPage />);
  await waitFor(() => expect(mockFetchWithRefresh).toHaveBeenCalled());

  expect(screen.queryByTestId("conn-username")).not.toBeInTheDocument();

  fireEvent.change(screen.getByTestId("conn-auth-type"), {
    target: { value: "username_password" },
  });

  expect(screen.getByTestId("conn-username")).toBeInTheDocument();
  expect(screen.getByTestId("conn-password")).toBeInTheDocument();
  expect(screen.getByTestId("conn-login-path")).toBeInTheDocument();
  expect(screen.getByTestId("conn-session-cookie")).toBeInTheDocument();
  // bearer field is hidden in this mode
  expect(screen.queryByTestId("conn-auth-header")).not.toBeInTheDocument();
});

it("username/password create POSTs the username_password body", async () => {
  routeOk();
  render(<AdminConnectorsPage />);
  await waitFor(() => expect(mockFetchWithRefresh).toHaveBeenCalled());

  fireEvent.change(screen.getByTestId("conn-base-url"), {
    target: { value: "https://beyond.example.com" },
  });
  fireEvent.change(screen.getByTestId("conn-auth-type"), {
    target: { value: "username_password" },
  });
  fireEvent.change(screen.getByTestId("conn-username"), {
    target: { value: "admin@acme.com" },
  });
  fireEvent.change(screen.getByTestId("conn-password"), {
    target: { value: "s3cret" },
  });
  fireEvent.change(screen.getByTestId("conn-login-path"), {
    target: { value: "/api/auth/login" },
  });
  fireEvent.change(screen.getByTestId("conn-session-cookie"), {
    target: { value: "session" },
  });
  fireEvent.click(screen.getByTestId("conn-submit"));

  await waitFor(() => expect(createPost()).toBeTruthy());
  const body = JSON.parse(String(createPost()![1].body));
  expect(body).toMatchObject({
    connectorName: "rest-default",
    authType: "username_password",
    username: "admin@acme.com",
    password: "s3cret",
    loginPath: "/api/auth/login",
    sessionCookieName: "session",
  });
  // bearer field must not be sent in this mode
  expect(body.authHeader).toBeUndefined();
});

it("surfaces an error when the create response fails", async () => {
  mockFetchWithRefresh.mockImplementation((url: string, opts?: { method?: string }) => {
    if (url === "/api/admin/connectors" && opts?.method === "POST") {
      return Promise.resolve(mkRes({ error: "bad creds" }, { ok: false, status: 400 }));
    }
    return Promise.resolve(mkRes({ connectors: [] }));
  });
  render(<AdminConnectorsPage />);
  await waitFor(() => expect(mockFetchWithRefresh).toHaveBeenCalled());

  fireEvent.change(screen.getByTestId("conn-base-url"), {
    target: { value: "https://api.acme.com" },
  });
  fireEvent.change(screen.getByTestId("conn-auth-header"), {
    target: { value: "Bearer abc123" },
  });
  fireEvent.click(screen.getByTestId("conn-submit"));

  expect(await screen.findByRole("alert")).toHaveTextContent("bad creds");
});
