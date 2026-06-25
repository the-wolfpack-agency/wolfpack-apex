/**
 * @jest-environment jsdom
 *
 * The export beacon: fires a tracked POST after a download, never throws, and
 * no-ops without a code id. Uses the auth-refresh wrapper (mocked).
 */
const mockFetch = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: unknown[]) => mockFetch(...a),
  jsonHeaders: () => ({ "content-type": "application/json" }),
}));

import { reportExport } from "../export-beacon";

beforeEach(() => { mockFetch.mockReset(); mockFetch.mockResolvedValue({ ok: true }); });

test("POSTs the format to the code's export endpoint", () => {
  reportExport("code-123", "eps");
  expect(mockFetch).toHaveBeenCalledTimes(1);
  const [url, init] = mockFetch.mock.calls[0];
  expect(url).toBe("/api/qr/code-123/export");
  expect(init.method).toBe("POST");
  expect(JSON.parse(init.body)).toEqual({ format: "eps" });
});

test("no-ops without a code id (older codes / nothing to attribute)", () => {
  reportExport(undefined, "png");
  expect(mockFetch).not.toHaveBeenCalled();
});

test("never throws even if the beacon rejects (download must not break)", () => {
  mockFetch.mockRejectedValue(new Error("offline"));
  expect(() => reportExport("c1", "svg")).not.toThrow();
});

test("url-encodes the code id", () => {
  reportExport("a/b", "pdf");
  expect(mockFetch.mock.calls[0][0]).toBe("/api/qr/a%2Fb/export");
});
