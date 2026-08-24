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
import { fireEvent, render, screen } from "@testing-library/react";
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
    /* The route answers this from the capability set the gate resolved. The
       existing probe cases below assume the control is on screen, which is now
       a statement about who is asking. */
    canProbe: true,
    days: 30,
    totalDecisions: 4,
    estimatedCostUsd: 0.12,
    decisionsWithoutEstimate: 0,
    /* Measured spend, from ai.completion. The page leads with this: an
       estimate is computed before the answer exists and cannot know how long
       it will be, while this is what the provider billed. */
    actualCalls: 4,
    actualCostUsd: 0.0431,
    inputTokens: 3200,
    outputTokens: 1100,
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
  it("leads with what was actually spent, not with an estimate", async () => {
    /* This tile used to read "Estimated cost / List price, not billed",
       computed from a token guess made BEFORE the answer existed. Someone
       reconciling against an invoice deserves the billed figure, which the
       provider reports on every completion and which the page never read. */
    respond(insights());
    render(<Page />);
    const tile = await screen.findByTestId("router-metric-spend");
    expect(tile).toHaveTextContent("$0.04");
    expect(tile).toHaveTextContent(/Total spent/i);
    // And it says where the number comes from, so it can be trusted.
    expect(tile).toHaveTextContent(/billed by the provider/i);
    expect(tile).not.toHaveTextContent(/estimate/i);
  });

  it("shows the output tokens, which is the work the money bought", async () => {
    respond(insights());
    render(<Page />);
    const tile = await screen.findByTestId("router-metric-tokens");
    expect(tile).toHaveTextContent("1,100");
    expect(tile).toHaveTextContent("3,200 in");
  });

  it("with nothing completed, says spend cannot be measured", async () => {
    /* The only case where the estimate gap still matters: no completions
       recorded at all, which is a worse problem than a missing estimate. */
    respond(insights({ actualCalls: 0, actualCostUsd: 0, decisionsWithoutEstimate: 3 }));
    render(<Page />);
    expect(await screen.findByTestId("router-estimate-caveat")).toHaveTextContent(
      /spend cannot be measured/i,
    );
  });

  it("does not apologise about estimates when spend was measured", async () => {
    respond(insights({ decisionsWithoutEstimate: 3 }));
    render(<Page />);
    await screen.findByTestId("router-headline");
    expect(screen.queryByTestId("router-estimate-caveat")).not.toBeInTheDocument();
  });

  it("shows sub-cent spend at enough precision to be meaningful", async () => {
    /* $0.00 against real spend reads as free, which is a different claim. The
       property matters MORE now than when it guarded the estimate: measured
       spend on a cheap tier is routinely sub-cent, so rounding it to two
       places would show $0.00 on a page whose whole purpose is proving the
       router saves money. */
    respond(insights({ actualCostUsd: 0.0012 }));
    render(<Page />);
    expect(await screen.findByTestId("router-metric-spend")).toHaveTextContent("$0.0012");
  });
});

/**
 * Reported 2026-08-19: "this doesn't seem to update".
 *
 * Two causes, and the page could only fix one of them. The route had no cache
 * headers, so a browser could serve its own stored copy back; and the page
 * fetched once on mount, so the only way to get new numbers was a full reload.
 * Counters with no timestamp cannot be told apart from counters that stopped.
 */
describe("freshness", () => {
  it("asks the browser not to reuse a stored copy", async () => {
    respond(insights());
    render(<Page />);
    await screen.findByTestId("router-headline");
    const [, init] = mockFetch.mock.calls.find(
      (c) => String(c[0]).includes("/api/admin/ai-router") && !String(c[0]).includes("probe"),
    ) as [string, RequestInit | undefined];
    expect(init?.cache).toBe("no-store");
  });

  it("says when it read the numbers", async () => {
    respond(insights());
    render(<Page />);
    expect(await screen.findByTestId("router-loaded-at")).toHaveTextContent(/Read at /);
  });

  it("reads them again on request, without a page reload", async () => {
    respond(insights());
    render(<Page />);
    await screen.findByTestId("router-headline");
    const before = mockFetch.mock.calls.filter((c) =>
      String(c[0]).includes("/api/admin/ai-router") && !String(c[0]).includes("probe"),
    ).length;

    fireEvent.click(screen.getByTestId("router-refresh"));

    await screen.findByTestId("router-loaded-at");
    const after = mockFetch.mock.calls.filter((c) =>
      String(c[0]).includes("/api/admin/ai-router") && !String(c[0]).includes("probe"),
    ).length;
    expect(after).toBeGreaterThan(before);
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

  it("does not list a model the platform cannot reach", async () => {
    // This asserted the opposite until 2026-08-02. The panel used to name the
    // missing variable for every unconfigured model, on the reasoning that
    // "Unavailable" sends someone digging. In practice the unconfigured rows
    // were the OpenAI-hosted twins of Azure models that ARE configured, so the
    // panel read as seven models when four are reachable, and each twin carried
    // a price nothing would ever be billed at. A panel titled "models this
    // platform can reach" should list the ones it can reach.
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
    const list = await screen.findByTestId("router-models");
    expect(list).not.toHaveTextContent("AZURE_OPENAI_CHAT_DEPLOYMENT is not set");
    expect(list).not.toHaveTextContent("Not configured");
    expect(list.querySelectorAll("li")).toHaveLength(0);
  });

  it("says availability is not editable here, and why", async () => {
    // Changing which models serve every AI call belongs in a deployment with a
    // review, not a form post.
    respond(insights());
    render(<Page />);
    expect(await screen.findByText(/belongs in a deployment with a review/i)).toBeInTheDocument();
  });
});

describe("testing whether a model actually answers", () => {
  const PROBE = {
    results: [
      { modelId: "gpt-4o-mini", outcome: "reachable", latencyMs: 210, status: 200, detail: null },
      { modelId: "azure-deepseek-v3", outcome: "unreachable", latencyMs: 88, status: 404, detail: "check the deployment name" },
      { modelId: "o4-mini", outcome: "not-configured", latencyMs: null, status: null, detail: null },
    ],
    reachable: 1,
    brokenlyConfigured: ["azure-deepseek-v3"],
    headline: "1 model is configured but not answering: azure-deepseek-v3.",
  };

  /** Insights on load, probe report on the POST. */
  function respondBoth() {
    mockFetch.mockImplementation(async (url: string, init?: { method?: string }) =>
      init?.method === "POST"
        ? { ok: true, status: 200, json: async () => PROBE }
        : { ok: true, status: 200, json: async () => insights() },
    );
  }

  it("does NOT probe on page load", async () => {
    // A probe is a real inference call against every configured provider. A
    // page that spends money to render itself is a page nobody can leave open.
    respond(insights());
    render(<Page />);
    await screen.findByTestId("router-models");
    expect(mockFetch.mock.calls.every((c) => c[1]?.method !== "POST")).toBe(true);
  });

  it("says what Available does and does not prove, next to the button", async () => {
    respond(insights());
    render(<Page />);
    const btn = await screen.findByTestId("router-probe-run");
    expect(btn).toBeInTheDocument();
    expect(screen.getByText(/rotated key/i)).toBeInTheDocument();
  });

  it("names the model that did not answer, not just a count", async () => {
    respondBoth();
    render(<Page />);
    fireEvent.click(await screen.findByTestId("router-probe-run"));
    const result = await screen.findByTestId("router-probe-result");
    expect(result).toHaveTextContent(/azure-deepseek-v3/);
    expect(result).toHaveTextContent(/check the deployment name/);
  });

  it("hides models nobody configured, so the real failure is not buried", async () => {
    respondBoth();
    render(<Page />);
    fireEvent.click(await screen.findByTestId("router-probe-run"));
    const result = await screen.findByTestId("router-probe-result");
    expect(result).not.toHaveTextContent(/o4-mini/);
  });

  it("surfaces a failed test rather than leaving the button spinning", async () => {
    mockFetch.mockImplementation(async (url: string, init?: { method?: string }) =>
      init?.method === "POST"
        ? { ok: false, status: 500, json: async () => ({}) }
        : { ok: true, status: 200, json: async () => insights() },
    );
    render(<Page />);
    fireEvent.click(await screen.findByTestId("router-probe-run"));
    expect(await screen.findByTestId("router-probe-error")).toHaveTextContent(/HTTP 500/);
  });
});

describe("the model list shows only what the platform can reach", () => {
  it("hides models that are not configured", async () => {
    // Reported from production: the panel listed seven models when four are
    // reachable. The unconfigured three were the OpenAI-hosted twins of Azure
    // models that ARE configured, carrying prices nothing would be billed at.
    respond(
      insights({
        models: [
          { modelId: "azure-gpt-4o-mini", provider: "azure", tier: "small", contextWindow: 128000, inputPricePer1kUsd: 0.00015, outputPricePer1kUsd: 0.0006, available: true, blockedBy: null },
          { modelId: "gpt-4o-mini", provider: "openai", tier: "small", contextWindow: 128000, inputPricePer1kUsd: 0.00015, outputPricePer1kUsd: 0.0006, available: false, blockedBy: "OPENAI_API_KEY is not set" },
        ],
      }),
    );
    render(<Page />);
    const list = await screen.findByTestId("router-models");
    expect(list).toHaveTextContent("azure-gpt-4o-mini");
    expect(list).not.toHaveTextContent("OPENAI_API_KEY is not set");
    expect(list.querySelectorAll("li")).toHaveLength(1);
  });
});

describe("what the router would not let through", () => {
  const refusals = (over: Record<string, unknown> = {}) => ({
    total: 3,
    blocked: 2,
    escalated: 1,
    redacted: 0,
    rules: [
      {
        rule: "price_guarantee",
        title: "Promised a price",
        why: "Pricing changes by location and by day. A guarantee made in chat is a commitment nobody in the business authorised.",
        count: 2,
      },
      {
        rule: "warranty_coverage",
        title: "Decided a warranty question",
        why: "Whether a repair is covered is a decision the brand makes on the facts of the car.",
        count: 1,
      },
    ],
    profiles: ["automotive"],
    ...over,
  });

  it("names the rule and the reasoning, not just a count", async () => {
    /* A client reading this panel is deciding whether the RULE is right. A
       number alone gives them nothing to agree or disagree with. */
    respond(insights({ refusals: refusals() }));
    render(<Page />);
    const list = await screen.findByTestId("router-refusal-rules");
    expect(list).toHaveTextContent("Promised a price");
    expect(list).toHaveTextContent(/commitment nobody in the business authorised/i);
    expect(screen.getByTestId("router-metric-blocked")).toHaveTextContent("2");
    expect(screen.getByTestId("router-metric-escalated")).toHaveTextContent("1");
  });

  it("says which rule set is in force", async () => {
    respond(insights({ refusals: refusals() }));
    render(<Page />);
    expect(await screen.findByTestId("router-refusal-profiles")).toHaveTextContent("automotive");
  });

  it("still renders on a clean window, because a silent panel reads as switched off", async () => {
    respond(insights({ refusals: refusals({ total: 0, blocked: 0, escalated: 0, rules: [], profiles: [] }) }));
    render(<Page />);
    expect(await screen.findByTestId("router-refusal-clean")).toBeInTheDocument();
    expect(screen.queryByTestId("router-refusal-rules")).not.toBeInTheDocument();
  });

  it("survives a payload from a deploy that did not have the gate", async () => {
    /* Version skew is a real minute-long window, not a hypothetical: the panel
       must be absent, and the rest of the page must render. */
    respond(insights());
    render(<Page />);
    expect(await screen.findByTestId("router-metric-spend")).toBeInTheDocument();
    expect(screen.queryByTestId("router-refusal-rules")).not.toBeInTheDocument();
    expect(screen.queryByTestId("router-refusal-clean")).not.toBeInTheDocument();
  });
});

/**
 * The page is org-wide reading as of 2026-08-24. The probe is not: it sends a
 * real inference call to every configured provider and costs money on click.
 *
 * Hidden rather than disabled. A control that is permanently dead teaches
 * somebody the page is broken, and one that answers 403 teaches them not to
 * trust the buttons.
 */
describe("the probe is not for every seat", () => {
  it("hides the probe when the server says this caller may not run it", async () => {
    respond(insights({ canProbe: false }));
    render(<Page />);
    // The page still renders in full for them.
    expect(await screen.findByTestId("router-models")).toBeInTheDocument();
    expect(screen.queryByTestId("router-probe-run")).not.toBeInTheDocument();
  });

  it("hides it when the field is missing entirely, rather than assuming yes", async () => {
    /* An older deploy, or a payload that lost the field. Absent must read as
       no: failing open here means offering a spend button to everybody. */
    const { canProbe: _drop, ...withoutTheField } = insights();
    respond(withoutTheField);
    render(<Page />);
    expect(await screen.findByTestId("router-models")).toBeInTheDocument();
    expect(screen.queryByTestId("router-probe-run")).not.toBeInTheDocument();
  });

  it("shows it to a caller the server says may run it", async () => {
    respond(insights({ canProbe: true }));
    render(<Page />);
    expect(await screen.findByTestId("router-probe-run")).toBeInTheDocument();
  });
});
