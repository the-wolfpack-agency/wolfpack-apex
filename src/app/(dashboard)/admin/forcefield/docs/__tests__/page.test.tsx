/** @jest-environment jsdom */
import "@testing-library/jest-dom";

/**
 * UI test for the in-app Forcefield docs viewer. Proves it loads the doc list +
 * the default doc on mount, renders the returned HTML, and switches docs on a
 * nav click. Auth + fetch are mocked.
 */
const mockFetch = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  getInstinctUser: () => ({ role: "cto" }),
  fetchWithRefresh: (...a: unknown[]) => mockFetch(...a),
}));
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: jest.fn() }) }));

import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import ForcefieldDocsPage from "../page";

const DOCS = [
  { key: "readme", title: "Overview", category: "Overview", file: "README.md" },
  { key: "pricing", title: "Pricing and packaging", category: "Commercial", file: "pricing-and-packaging.md" },
  { key: "tos", title: "Terms of Service", category: "Legal (draft, needs counsel)", file: "legal/terms-of-service.md" },
];
const doc = (key: string, html: string) =>
  ({ ok: true, json: async () => ({ ok: true, docs: DOCS, doc: DOCS.find((d) => d.key === key), html }) }) as unknown as Response;

beforeEach(() => jest.clearAllMocks());

it("loads the nav + the default doc and renders its HTML", async () => {
  mockFetch.mockResolvedValueOnce(doc("readme", "<h1>Overview</h1><p>do not publish</p>"));
  render(<ForcefieldDocsPage />);
  await waitFor(() => expect(screen.getByTestId("ff-docs-body")).toHaveTextContent("Overview"));
  // nav lists every category's docs
  expect(screen.getByTestId("ff-doc-pricing")).toBeInTheDocument();
  expect(screen.getByTestId("ff-doc-tos")).toBeInTheDocument();
  // default doc requested is the readme
  expect(String(mockFetch.mock.calls[0][0])).toContain("doc=readme");
});

it("switches docs on a nav click", async () => {
  mockFetch.mockResolvedValueOnce(doc("readme", "<h1>Overview</h1>"));
  render(<ForcefieldDocsPage />);
  await screen.findByTestId("ff-doc-pricing");
  mockFetch.mockResolvedValueOnce(doc("pricing", "<h1>Pricing</h1><p>flat per site</p>"));
  fireEvent.click(screen.getByTestId("ff-doc-pricing"));
  await waitFor(() => expect(screen.getByTestId("ff-docs-body")).toHaveTextContent("flat per site"));
  expect(String(mockFetch.mock.calls[1][0])).toContain("doc=pricing");
});
