/** @jest-environment jsdom */
import "@testing-library/jest-dom";

/**
 * UI test for "Is your server exposed?": each state renders plainly (exposed
 * with the fix line, up to date, could not check, never-reported empty state,
 * load error), the tenant token goes in the header, and a could-not-check row
 * is never labeled safe or exposed. Fixtures come from the real matcher.
 */
const mockFetch = jest.fn();
beforeAll(() => { (global as { fetch: unknown }).fetch = (...a: unknown[]) => mockFetch(...a); });

import { render, screen, within } from "@testing-library/react";
import { ServerExposurePanel } from "../ServerExposurePanel";
import { buildExposureReport, type ServerInventory } from "@/lib/forcefield-web/server-exposure";

const resp = (status: number, body: unknown = {}) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;
const reportFor = (inv: Partial<ServerInventory>) => {
  const full: ServerInventory = { phpVersion: "8.4.27", wordpressVersion: "6.8.3", serverSoftware: "Apache", plugins: [], ...inv };
  return { ...buildExposureReport(full), phpVersion: full.phpVersion, wordpressVersion: full.wordpressVersion, receivedAt: "2026-10-27T12:00:00Z", firstReceivedAt: "2026-10-27T12:00:00Z" };
};

beforeEach(() => jest.clearAllMocks());

it("exposed: names the version, the flaw in plain words, and who fixes it", async () => {
  mockFetch.mockResolvedValueOnce(resp(200, { ok: true, report: reportFor({ phpVersion: "8.3.10", plugins: [{ slug: "akismet", version: "5.3" }] }) }));
  render(<ServerExposurePanel token="ff_tok" />);
  const report = await screen.findByTestId("ff-exposure-report");
  expect(report).toHaveAttribute("data-state", "exposed");
  expect(screen.getByTestId("ff-exposure-status")).toHaveTextContent("Exposed");
  const php = screen.getAllByTestId("ff-exposure-row").find((r) => r.getAttribute("data-key") === "php2shell:php")!;
  expect(php).toHaveAttribute("data-state", "exposed");
  expect(php).toHaveTextContent("Your server runs PHP 8.3.10, which is open to PHP2Shell, PHP server takeover");
  expect(within(php).getByTestId("ff-exposure-fix")).toHaveTextContent("How to fix it: Your hosting company updates PHP. Ask them to move this site to PHP 8.3.36 or later");
  expect(php).toHaveTextContent("CVE-2026-109618, CVE-2026-109619");
  expect(screen.getByTestId("ff-exposure-meta")).toHaveTextContent("1 other active plugin is not on the actively exploited list");
  expect(((mockFetch.mock.calls[0][1] as RequestInit).headers as Record<string, string>)["x-forcefield-token"]).toBe("ff_tok");
  expect(mockFetch.mock.calls[0][0]).toBe("/api/forcefield/my-exposure");
});

it("up to date: says so, with no fix line", async () => {
  mockFetch.mockResolvedValueOnce(resp(200, { ok: true, report: reportFor({}) }));
  render(<ServerExposurePanel token="ff_tok" />);
  expect(await screen.findByTestId("ff-exposure-report")).toHaveAttribute("data-state", "ok");
  expect(screen.getByTestId("ff-exposure-status")).toHaveTextContent("Up to date");
  expect(screen.getByTestId("ff-exposure-headline")).toHaveTextContent("No actively exploited flaw on our list affects your server");
  expect(screen.queryByTestId("ff-exposure-fix")).not.toBeInTheDocument();
  expect(screen.getAllByTestId("ff-exposure-row").map((r) => r.getAttribute("data-state"))).toEqual(["ok", "ok"]);
});

it("could not check: explains why, never labels it safe or exposed", async () => {
  mockFetch.mockResolvedValueOnce(resp(200, { ok: true, report: reportFor({ phpVersion: "8.3.6-1ubuntu1" }) }));
  render(<ServerExposurePanel token="ff_tok" />);
  expect(await screen.findByTestId("ff-exposure-report")).toHaveAttribute("data-state", "unknown");
  expect(screen.getByTestId("ff-exposure-status")).toHaveTextContent("Could not check");
  const php = screen.getAllByTestId("ff-exposure-row")[0];
  expect(php).toHaveAttribute("data-state", "unknown");
  expect(php).toHaveTextContent("Linux distribution build");
  expect(php).toHaveTextContent("Fixed in PHP 8.3.36 and later.");
  expect(php).not.toHaveTextContent("Up to date");
  expect(php).not.toHaveTextContent(/^Exposed/);
  expect(screen.queryByTestId("ff-exposure-fix")).not.toBeInTheDocument();
});

it("empty: the plugin has not reported yet", async () => {
  mockFetch.mockResolvedValueOnce(resp(200, { ok: true, report: null }));
  render(<ServerExposurePanel token="ff_tok" />);
  expect(await screen.findByTestId("ff-exposure-empty")).toHaveTextContent("No server report yet");
  expect(screen.queryByTestId("ff-exposure-report")).not.toBeInTheDocument();
});

it.each([[401], [503]])("a %i shows an explicit error, not a blank panel", async (status) => {
  mockFetch.mockResolvedValueOnce(resp(status, { ok: false }));
  render(<ServerExposurePanel token="ff_tok" />);
  expect(await screen.findByTestId("ff-exposure-error")).toBeInTheDocument();
});

it("a network failure shows the error state", async () => {
  mockFetch.mockRejectedValueOnce(new Error("offline"));
  render(<ServerExposurePanel token="ff_tok" />);
  expect(await screen.findByTestId("ff-exposure-error")).toBeInTheDocument();
});
