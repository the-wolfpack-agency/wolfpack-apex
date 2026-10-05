/** @jest-environment node */
/**
 * pull-approvals: the read model for the in-tool approval surface. Reuses the real
 * gate + eligibility (pure), with the GitHub/CI IO mocked. Asserts a PR's status
 * reflects CI + gate + sensitivity + tests, that eligibility matches the shared
 * policy, and that only factory branches are listed + per-PR failures degrade one row.
 */
const mockListOpen = jest.fn();
const mockListChanged = jest.fn();
const mockCi = jest.fn();
const mockContents = jest.fn();
jest.mock("@/lib/github-client", () => ({
  listOpenPullRequests: (...a: unknown[]) => mockListOpen(...a),
  listChangedFiles: (...a: unknown[]) => mockListChanged(...a),
}));
jest.mock("@/lib/ai-code/ci-status", () => ({ fetchCiStatus: (...a: unknown[]) => mockCi(...a) }));
jest.mock("@/lib/ai-code/ci-failure-detail", () => ({ fetchFilesContent: (...a: unknown[]) => mockContents(...a) }));

import { pullApprovalStatus, listFactoryPullStatuses } from "@/lib/ai-code/pull-approvals";

const client = { token: "t", fetch: jest.fn() } as unknown as Parameters<typeof pullApprovalStatus>[0];
const clean = (p: string) => ({ path: p, content: "export const x = 1;" });

beforeEach(() => {
  jest.clearAllMocks();
  mockCi.mockResolvedValue({ ciComplete: true, readable: true });
  mockListChanged.mockResolvedValue(["src/lib/util/x.ts", "src/lib/util/__tests__/x.test.ts"]);
  mockContents.mockResolvedValue([clean("src/lib/util/x.ts")]);
});

const pr = { number: 5, headRef: "factory/x", baseRef: "main", title: "Add x" };

it("eligible low-risk PR: CI green + gate allow + tests + no sensitive surface", async () => {
  const s = await pullApprovalStatus(client, "o/r", pr);
  expect(s).toMatchObject({ number: 5, ciGreen: true, ciReadable: true, gateOutcome: "allow", hasTests: true, touchesSensitiveSurface: false, eligible: true });
  expect(s.url).toBe("https://github.com/o/r/pull/5");
});

it("CI not green -> not eligible", async () => {
  mockCi.mockResolvedValue({ ciComplete: false, readable: true });
  const s = await pullApprovalStatus(client, "o/r", pr);
  expect(s.ciGreen).toBe(false);
  expect(s.eligible).toBe(false);
});

it("CI unreadable -> ciReadable false, not eligible", async () => {
  mockCi.mockResolvedValue({ ciComplete: false, readable: false });
  const s = await pullApprovalStatus(client, "o/r", pr);
  expect(s.ciReadable).toBe(false);
  expect(s.eligible).toBe(false);
});

it("sensitive surface (auth) -> flagged, not eligible", async () => {
  mockListChanged.mockResolvedValue(["src/lib/auth/require-capability.ts", "src/lib/auth/__tests__/x.test.ts"]);
  mockContents.mockResolvedValue([clean("src/lib/auth/require-capability.ts")]);
  const s = await pullApprovalStatus(client, "o/r", pr);
  expect(s.touchesSensitiveSurface).toBe(true);
  expect(s.eligible).toBe(false);
});

it("gate block (introduced secret) -> gateOutcome not allow, not eligible", async () => {
  mockContents.mockResolvedValue([{ path: "src/lib/util/x.ts", content: 'const key = "sk-ant-abcdefghijklmnopqrstuvwx0123";' }]);
  const s = await pullApprovalStatus(client, "o/r", pr);
  expect(s.gateOutcome).not.toBe("allow");
  expect(s.eligible).toBe(false);
});

it("no tests -> not eligible", async () => {
  mockListChanged.mockResolvedValue(["src/lib/util/x.ts"]);
  mockContents.mockResolvedValue([clean("src/lib/util/x.ts")]);
  const s = await pullApprovalStatus(client, "o/r", pr);
  expect(s.hasTests).toBe(false);
  expect(s.eligible).toBe(false);
});

it("listChangedFiles failure degrades ONE row (gate unknown), never throws", async () => {
  mockListChanged.mockRejectedValue(new Error("gh down"));
  const s = await pullApprovalStatus(client, "o/r", pr);
  expect(s.gateOutcome).toBe("unknown");
  expect(s.eligible).toBe(false);
});

describe("listFactoryPullStatuses", () => {
  it("lists only factory branches, each with a status", async () => {
    mockListOpen.mockResolvedValue([
      { number: 5, headRef: "factory/x", baseRef: "main", title: "Add x", labels: [] },
      { number: 6, headRef: "feature/hand-authored", baseRef: "main", title: "Human PR", labels: [] },
    ]);
    const list = await listFactoryPullStatuses(client, "o/r");
    expect(list.map((p) => p.number)).toEqual([5]); // the hand-authored branch is excluded
    expect(list[0].eligible).toBe(true);
  });
});
