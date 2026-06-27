/**
 * The Recommended Automations section is a client deliverable, so it must render
 * the persisted recommendations into a prioritized Markdown table, drop any the
 * operator dismissed, degrade to an explicit empty-state on no data / store
 * error, and never throw / never blank. The recommend store is mocked so the
 * section is tested in isolation.
 */
const mockListRecommendations = jest.fn();

jest.mock("@/lib/platform-scan/recommend/store", () => ({
  listRecommendations: (...a: unknown[]) => mockListRecommendations(...a),
}));

import { genRecommendedAutomations } from "@/lib/report-sections-engagement";
import type { RecommendationRow } from "@/lib/platform-scan/recommend/store";

const ctx = { clientName: "Acme", workspaceId: "ws-1" };

const rec = (over: Partial<RecommendationRow> = {}): RecommendationRow => ({
  id: "rec-1",
  platform: "acme",
  key: "security_remediation:headers",
  category: "security_remediation",
  priority: "high",
  title: "Add a security-headers middleware",
  rationale: "headers missing",
  suggestedAction: "Set the missing headers globally in middleware.",
  source: "finding:security",
  evidence: { count: 2 },
  status: "proposed",
  createdAt: "2026-06-27T00:00:00.000Z",
  ...over,
});

beforeEach(() => jest.clearAllMocks());

it("renders the table with a rec title + suggested action", async () => {
  mockListRecommendations.mockResolvedValue([rec()]);
  const md = await genRecommendedAutomations(ctx);
  expect(md).toMatch(/## Recommended Automations/);
  expect(md).toContain("| Priority | Category | Recommendation | Suggested action |");
  expect(md).toContain("Add a security-headers middleware");
  expect(md).toContain("Set the missing headers globally in middleware.");
  expect(md).toContain("high");
});

it("filters out dismissed recommendations", async () => {
  mockListRecommendations.mockResolvedValue([
    rec({ id: "keep", title: "Keep me", status: "proposed" }),
    rec({ id: "drop", title: "Dismissed rec", status: "dismissed" }),
  ]);
  const md = await genRecommendedAutomations(ctx);
  expect(md).toContain("Keep me");
  expect(md).not.toContain("Dismissed rec");
});

it("renders the explicit empty-state when there are no recommendations", async () => {
  mockListRecommendations.mockResolvedValue([]);
  const md = await genRecommendedAutomations(ctx);
  expect(md).toMatch(/## Recommended Automations/);
  expect(md).toContain("No automation recommendations yet");
});

it("renders the empty-state when all recommendations are dismissed", async () => {
  mockListRecommendations.mockResolvedValue([rec({ status: "dismissed" })]);
  const md = await genRecommendedAutomations(ctx);
  expect(md).toContain("No automation recommendations yet");
});

it("degrades to the empty-state on a store error (never throws)", async () => {
  mockListRecommendations.mockRejectedValue(new Error("db down"));
  const md = await genRecommendedAutomations(ctx);
  expect(md).toMatch(/## Recommended Automations/);
  expect(md).toContain("No automation recommendations yet");
});
