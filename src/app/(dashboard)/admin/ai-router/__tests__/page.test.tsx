/**
 * @jest-environment jsdom
 */

/**
 * The model router page.
 *
 * The tests that matter are about money and about absence. A cost figure that
 * silently excludes half the calls, or an empty page that reads as "the router
 * is idle", both put a confident wrong impression in front of someone who will
 * act on it.
 */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import Page from "../page";

const mockPush = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: mockPush }) }));

const mockFetch = jest.fn();
const mockUser = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: unknown[]) => mockFetch(...a),
  getInstinctUser: () => mockUser(),
}));

function insights(over: Record<string, unknown> = {}) {
  return {
    days: 30,
    totalDecisions: 4,
    estimatedCostUsd: 0.12,
    decisionsWithoutEstimate: 0,
    usage: [
      { modelId: "gpt-4o-mini", provider: "azure", tier: "small", decisions: 4, estimated: 4, estimatedCostUsd: 0.12, fallbacks: 0 },
    ],
    reasons: [{ reason: "cheapest_at_tier", count: 4, description: "the cheapest model that met the requirement" }],
    fallbacks: 0,
    models: [
      {
        modelId: "gpt-4o-mini",
        provider: "azure",
        tier: "small",
        contextWindow: 128000,
        inputPricePer1kUsd: 0.00015,
        outputPricePer1kUsd: 0.0006,
        available: true,
        blockedBy: null,
      },
    ],
    smallTierShare: 1,
    headline: "4 routing decisions, 100% served by the cheapest tier.",
    ...over,
  };
}

const respond = (body: unknown, ok = true, status = 200) =>
  mockFetch.mockResolvedValue({ ok, status, json: async () => body });

beforeEach(() => {
  jest.clearAllMocks();
  mockUser.mockReturnValue({ role: "cto" });
});

describe("auth", () => {
  it("redirects an unauthenticated visitor instead of rendering a blank page", () => {
    mockUser.mockReturnValue(null);
    render(<Page />);
    expect(mockPush).toHaveBeenCalledWith("/login?next=/admin/ai-router");
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("money", () => {
  it("labels the cost as an estimate, never as billed", async () => {
    // Someone will reconcile this against an invoice. If it does not say
    // "estimated", they will find it wrong and stop trusting the surface.
    respond(insights());
    render(<Page />);
    expect(await screen.findByTestId("router-metric-cost")).toHaveTextContent(/estimated/i);
    expect(screen.getByTestId("router-metric-cost")).toHaveTextContent(/not billed/i);
  });

  it("says when decisions carried no estimate, so the total is read correctly", async () => {
    respond(insights({ decisionsWithoutEstimate: 3 }));
    render(<Page />);
    expect(await screen.findByTestId("router-estimate-caveat")).toHaveTextContent(/understates the real total/i);
  });

  it("does not show the caveat when every decision was estimated", async () => {
    respond(insights());
    render(<Page />);
    await screen.findByTestId("router-headline");
    expect(screen.queryByTestId("router-estimate-caveat")).not.toBeInTheDocument();
  });

  it("shows a sub-cent estimate at enough precision to be meaningful", async () => {
    // $0.00 for real spend reads as free, which is a different claim.
    respond(insights({ estimatedCostUsd: 0.0012 }));
    render(<Page />);
    expect(await screen.findByTestId("router-metric-cost")).toHaveTextContent("$0.0012");
  });
});

describe("absence", () => {
  it("does not present an unreadable router as an idle one", async () => {
    respond({ nonsense: true });
    render(<Page />);
    const el = await screen.findByTestId("router-unavailable");
    expect(el).toHaveTextContent(/not the same as no activity having happened/i);
  });

  it("shows an error rather than a blank page on a failed request", async () => {
    respond(null, false, 500);
    render(<Page />);
    expect(await screen.findByTestId("router-error")).toBeInTheDocument();
  });

  it("survives a malformed payload instead of throwing", async () => {
    // Version skew during a deploy is a real scenario, and an unguarded .map
    // on a missing array blanks an authenticated page.
    respond({ days: 30, usage: null, models: undefined });
    render(<Page />);
    expect(await screen.findByTestId("router-unavailable")).toBeInTheDocument();
  });

  it("shows n/a rather than 0% when nothing has been routed", async () => {
    // 0% reads as "we never use the cheap model", which is a finding. Nothing
    // recorded is not a finding.
    respond(insights({ smallTierShare: null, totalDecisions: 0 }));
    render(<Page />);
    expect(await screen.findByTestId("router-metric-cheap")).toHaveTextContent("n/a");
  });
});

describe("what it shows", () => {
  it("lists which models were used and why", async () => {
    respond(insights());
    render(<Page />);
    expect(await screen.findByTestId("router-usage")).toHaveTextContent("gpt-4o-mini");
    expect(screen.getByTestId("router-reasons")).toHaveTextContent("the cheapest model that met the requirement");
  });

  it("names the missing variable for a model that is not configured", async () => {
    // "Unavailable" sends someone digging. The variable name is the fix.
    respond(
      insights({
        models: [
          {
            modelId: "gpt-4o",
            provider: "azure",
            tier: "large",
            contextWindow: 128000,
            inputPricePer1kUsd: 0.005,
            outputPricePer1kUsd: 0.015,
            available: false,
            blockedBy: "AZURE_OPENAI_CHAT_DEPLOYMENT is not set",
          },
        ],
      }),
    );
    render(<Page />);
    expect(await screen.findByTestId("router-models")).toHaveTextContent("AZURE_OPENAI_CHAT_DEPLOYMENT is not set");
    expect(screen.getByTestId("router-models")).toHaveTextContent("Not configured");
  });

  it("says availability is not editable here, and why", async () => {
    // Changing which models serve every AI call belongs in a deployment with a
    // review, not a form post.
    respond(insights());
    render(<Page />);
    expect(await screen.findByText(/belongs in a deployment with a review/i)).toBeInTheDocument();
  });
});
