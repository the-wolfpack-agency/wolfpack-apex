/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen, waitFor } from "@testing-library/react";

const mockFetch = jest.fn();
jest.mock("@/lib/client-auth", () => ({ fetchWithRefresh: (...a: unknown[]) => mockFetch(...a) }));
import { SiteAiVisibility } from "../SiteAiVisibility";

const ok = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;
const REPORT = { days: 30, byPurpose: { ai_training: 471 }, agents: [{ agent: "ClaudeBot", vendor: "Anthropic", purpose: "ai_training", requests: 471, verifiedRequests: 0, impersonations: 0, identity: "unverified", pages: 8, topPages: [{ path: "/", requests: 300 }], daily: [1, 2], lastSeen: null }] };

beforeEach(() => jest.clearAllMocks());

it("the cross-site view asks for a site and fetches nothing", () => {
  render(<SiteAiVisibility site="all" days={30} />);
  expect(screen.getByTestId("admin-ai-visibility-pick")).toBeInTheDocument();
  expect(mockFetch).not.toHaveBeenCalled();
});

it("a selected site loads its report through fetchWithRefresh and renders it", async () => {
  mockFetch.mockResolvedValue(ok({ visibility: REPORT }));
  render(<SiteAiVisibility site="weekendwithporsche" days={7} />);
  expect(await screen.findByTestId("admin-ai-visibility")).toBeInTheDocument();
  expect(mockFetch).toHaveBeenCalledWith("/api/admin/site-analytics/ai-visibility?site=weekendwithporsche&days=7");
  expect(screen.getByTestId("admin-ai-visibility-agent")).toHaveTextContent("ClaudeBot by Anthropic");
});

it.each([403, 500])("a %s answer shows a clear error, not a blank panel", async (status) => {
  mockFetch.mockResolvedValue(ok({ error: "x" }, status));
  render(<SiteAiVisibility site="ogiam.com" days={30} />);
  await waitFor(() => expect(screen.getByTestId("admin-ai-visibility-error")).toBeInTheDocument());
});
