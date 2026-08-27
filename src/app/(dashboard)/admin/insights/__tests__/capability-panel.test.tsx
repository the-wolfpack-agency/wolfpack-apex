/**
 * @jest-environment jsdom
 *
 * The Phase 1 capability panel: the first thing a client sees.
 *
 * /admin/insights is the pre-built version of what a client is shown before
 * their own infrastructure exists. The other panels answer "where is the
 * product failing its users", which is the right question for us and the wrong
 * first impression for them, so this one sits above them and answers "what
 * does it demonstrably do".
 *
 * The assertions that matter are the honest ones: a zero must be readable as
 * good news, and a figure nobody could measure must never render as a number.
 */

import "@testing-library/jest-dom";
import { render, screen, waitFor, within } from "@testing-library/react";

const mockGetUser = jest.fn();
const mockFetch = jest.fn();
const mockPush = jest.fn();

jest.mock("next/navigation", () => ({ useRouter: () => ({ push: mockPush }) }));
jest.mock("@/lib/client-auth", () => ({
  getInstinctUser: () => mockGetUser(),
  authHeaders: () => ({ Authorization: "Bearer x" }),
  fetchWithRefresh: (...a: unknown[]) => mockFetch(...a),
}));

import InsightsAdminPage from "@/app/(dashboard)/admin/insights/page";

const okJson = (body: unknown) =>
  ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

const reading = (value: number | null, detail: string) => ({ value, detail });

const SNAP = {
  windowDays: 90,
  gate: {
    actionsAuthorized: reading(4209, "agent actions passed the deterministic gate"),
    checkpointsSigned: reading(332, "hash-chained checkpoints signed"),
  },
  efficiency: {
    deterministicSharePct: reading(99, "10119 of 10246 answers used no model at all"),
    modelCalls: reading(577, "model calls in 90 days"),
    cheapTierPct: reading(81, "470 of 577 served by the cheapest capable model"),
    spendUsd: reading(0.6, "total model spend across 90 days"),
  },
  safety: {
    responsesRedacted: reading(0, "no outbound answer has contained a secret"),
    responsesFlagged: reading(0, "no model answer has been flagged as unsafe"),
    inspectorProven: true,
  },
  retrieval: {
    chunksEmbeddedPct: reading(100, "4881 of 4881 passages answerable"),
    answerableDocuments: reading(93, "documents indexed and quotable"),
  },
};

function routeWith(capabilityBody: unknown) {
  mockFetch.mockImplementation((url: string) => {
    if (url.includes("/capability")) return Promise.resolve(okJson(capabilityBody));
    if (url.includes("routing-coverage")) return Promise.resolve(okJson({ readable: true, total: 36, reachedOne: 31, reachedNone: 3, reachedMany: 2, percent: 86, deadClusters: [], unreachable: [] }));
    if (url.includes("role-mismatches")) return Promise.resolve(okJson({ mismatches: [], readable: true }));
    if (url.includes("unmet-intents")) return Promise.resolve(okJson({ intents: [] }));
    if (url.includes("/templates")) return Promise.resolve(okJson({ templates: [] }));
    return Promise.resolve(okJson({ vendors: [] }));
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetUser.mockReturnValue({ role: "cto" });
});

describe("the capability panel", () => {
  it("leads with the number the product is sold on", async () => {
    routeWith({ readable: true, snapshot: SNAP });
    render(<InsightsAdminPage />);
    await waitFor(() =>
      expect(within(screen.getByTestId("capability-deterministic")).getByText("99%")).toBeInTheDocument(),
    );
  });

  it("shows the gate, which is the part nobody else can show", async () => {
    routeWith({ readable: true, snapshot: SNAP });
    render(<InsightsAdminPage />);
    await waitFor(() => expect(screen.getByTestId("capability-gate")).toHaveTextContent("4209"));
    expect(screen.getByTestId("capability-checkpoints")).toHaveTextContent("332");
  });

  it("shows what the models actually cost", async () => {
    routeWith({ readable: true, snapshot: SNAP });
    render(<InsightsAdminPage />);
    await waitFor(() => expect(screen.getByTestId("capability-spend")).toHaveTextContent("0.6"));
    expect(screen.getByTestId("capability-cheap-tier")).toHaveTextContent("81%");
  });

  it("renders the safety zeros rather than hiding them", async () => {
    /* A hidden panel and a zero look identical to a client, and only one of
       them is true. */
    routeWith({ readable: true, snapshot: SNAP });
    render(<InsightsAdminPage />);
    await waitFor(() => expect(screen.getByTestId("capability-redacted")).toHaveTextContent("0"));
    expect(screen.getByTestId("capability-flagged")).toHaveTextContent("0");
  });

  it("says why a zero is good news rather than an unrun control", async () => {
    routeWith({ readable: true, snapshot: SNAP });
    render(<InsightsAdminPage />);
    await waitFor(() => expect(screen.getByTestId("capability-inspector-note")).toBeInTheDocument());
    expect(screen.getByTestId("capability-inspector-note")).toHaveTextContent(/proved to run/i);
  });

  it("renders an unmeasured figure as words, never as a number", async () => {
    const dark = {
      ...SNAP,
      efficiency: { ...SNAP.efficiency, spendUsd: reading(null, "The completion log could not be read.") },
    };
    routeWith({ readable: true, snapshot: dark });
    render(<InsightsAdminPage />);
    await waitFor(() =>
      expect(screen.getByTestId("capability-spend")).toHaveTextContent("not measurable"),
    );
    expect(screen.getByTestId("capability-spend")).not.toHaveTextContent("0 USD");
  });

  it("says unreadable rather than showing a page of zeros", async () => {
    /* 0% deterministic and $0 spend would tell a client this product does
       nothing, which is the opposite of what an unreadable event store means. */
    routeWith({ readable: false, error: "db down" });
    render(<InsightsAdminPage />);
    await waitFor(() => expect(screen.getByTestId("capability-unreadable")).toBeInTheDocument());
    expect(screen.queryByTestId("capability-deterministic")).not.toBeInTheDocument();
  });
});
