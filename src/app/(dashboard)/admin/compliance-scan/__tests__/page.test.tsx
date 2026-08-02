/**
 * @jest-environment jsdom
 */

/**
 * The compliance scan page.
 *
 * The tests that matter are about the third verdict. A report with three states
 * rendered in a two-state visual language quietly becomes a two-state report,
 * and the state that gets lost is always "we could not tell" — which collapses
 * into "fine". Someone then tells a client they are compliant.
 *
 * So: unverifiable is never worded as a pass, and the headline never claims
 * everything passed while anything was unestablished.
 */
import "@testing-library/jest-dom";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Page, { headlineFor } from "../page";

const mockPush = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: mockPush }) }));

const mockFetch = jest.fn();
const mockUser = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: unknown[]) => mockFetch(...a),
  jsonHeaders: () => ({ "content-type": "application/json" }),
  getInstinctUser: () => mockUser(),
}));

function report(over: Record<string, unknown> = {}) {
  return {
    pageUrl: "https://client.example.com/",
    finalUrl: "https://client.example.com/",
    tier: "static",
    findings: [],
    summary: { total: 0, present: 0, absent: 0, unverifiable: 0, headline: "" },
    anomaly: { findings: [], disappeared: [], caveats: [], totals: { thirdParties: 0, unexplained: 0, novel: 0 } },
    runId: "run-1",
    baselineUpdated: true,
    ...over,
  };
}

function respondWith(body: unknown, ok = true, status = 200) {
  mockFetch.mockResolvedValue({ ok, status, json: async () => body });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockUser.mockReturnValue({ role: "cto" });
});

async function runScan() {
  const user = userEvent.setup();
  render(<Page />);
  await user.type(screen.getByLabelText("Target"), "client-site");
  await user.click(screen.getByRole("button", { name: /run scan/i }));
}

describe("auth", () => {
  it("redirects an unauthenticated visitor instead of rendering a blank page", () => {
    mockUser.mockReturnValue(null);
    render(<Page />);
    expect(mockPush).toHaveBeenCalledWith("/login?next=/admin/compliance-scan");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("renders the form for an authenticated user", () => {
    render(<Page />);
    expect(screen.getByRole("button", { name: /run scan/i })).toBeInTheDocument();
  });
});

describe("running a scan", () => {
  it("posts the target and shows the result", async () => {
    respondWith({
      report: report({
        findings: [{ id: "privacy-policy", title: "Privacy policy is linked", verdict: "present", severity: "info", detail: "Found in the footer." }],
        summary: { total: 1, present: 1, absent: 0, unverifiable: 0, headline: "" },
      }),
    });
    await runScan();
    expect(await screen.findByText("Privacy policy is linked")).toBeInTheDocument();
    expect(mockFetch).toHaveBeenCalledWith("/api/admin/compliance-scan", expect.objectContaining({ method: "POST" }));
    expect(JSON.parse((mockFetch.mock.calls[0][1] as { body: string }).body)).toMatchObject({ platform: "client-site" });
  });

  it("will not submit an empty target", async () => {
    const user = userEvent.setup();
    render(<Page />);
    await user.click(screen.getByRole("button", { name: /run scan/i }));
    expect(mockFetch).not.toHaveBeenCalled();
    expect(await screen.findByRole("alert")).toHaveTextContent(/choose a target/i);
  });

  it("explains an unverified target in words an operator can act on", async () => {
    // "403" tells them nothing. What to do about it is the useful part.
    respondWith({ error: "target_not_verified" }, false, 403);
    await runScan();
    expect(await screen.findByRole("alert")).toHaveTextContent(/ownership-verified/i);
  });

  it("shows an error rather than a blank page when the request fails", async () => {
    mockFetch.mockRejectedValue(new Error("offline"));
    await runScan();
    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });
});

describe("the third verdict", () => {
  it("labels an unverifiable check as could-not-be-established, never as a pass", async () => {
    respondWith({
      report: report({
        findings: [
          { id: "cookie-consent", title: "Consent banner", verdict: "unverifiable", severity: "critical", detail: "Needs a browser-backed scan." },
        ],
        summary: { total: 1, present: 0, absent: 0, unverifiable: 1, headline: "" },
      }),
    });
    await runScan();
    // The pill specifically: the same phrase is also the metric label, which is
    // the point (one vocabulary), but the verdict badge is what a reader scans.
    const pill = await screen.findByTestId("status-pill");
    expect(pill).toHaveTextContent(/could not be established/i);
    // Neutral, never the success tone. Not knowing is not a pass.
    expect(pill).toHaveAttribute("data-tone", "neutral");
    // Exactly one verdict badge, and it is not a pass. (The four metric tiles
    // always render all four labels, so asserting on page text here would be
    // asserting about the tiles, not about the finding.)
    expect(screen.getAllByTestId("status-pill")).toHaveLength(1);
  });

  it("tells the reader what a static scan could not look at", async () => {
    respondWith({ report: report({ tier: "static" }) });
    await runScan();
    expect(await screen.findByText(/did not run the page in a browser/i)).toBeInTheDocument();
  });

  it("does not show that notice for a browser-backed scan", async () => {
    respondWith({ report: report({ tier: "browser" }) });
    await runScan();
    await screen.findByText(/^Result$/);
    expect(screen.queryByText(/did not run the page in a browser/i)).not.toBeInTheDocument();
  });

  it("lists what the scan could not establish, rather than dropping it", async () => {
    respondWith({
      report: report({ anomaly: { findings: [], disappeared: [], caveats: ["No previous scan of this site exists."], totals: { thirdParties: 0, unexplained: 0, novel: 0 } } }),
    });
    await runScan();
    expect(await screen.findByText("No previous scan of this site exists.")).toBeInTheDocument();
  });

  it("says when a run was not saved", async () => {
    respondWith({ report: report({ runId: null }) });
    await runScan();
    expect(await screen.findByText(/was not saved/i)).toBeInTheDocument();
  });
});

describe("headlineFor", () => {
  it("claims a clean result only when nothing is missing, unestablished, or unexplained", () => {
    const clean = report({ summary: { total: 9, present: 9, absent: 0, unverifiable: 0, headline: "" } }) as never;
    expect(headlineFor(clean)).toMatch(/All 9 checks passed/);
  });

  it("refuses to say everything passed when something could not be established", () => {
    // This is the sentence someone screenshots and sends to a client.
    const partial = report({ summary: { total: 9, present: 8, absent: 0, unverifiable: 1, headline: "" } }) as never;
    const line = headlineFor(partial);
    expect(line).not.toMatch(/All 9 checks passed/);
    expect(line).toMatch(/1 we could not establish/);
  });

  it("refuses to say everything passed when a host is unexplained", () => {
    const withHost = report({
      summary: { total: 9, present: 9, absent: 0, unverifiable: 0, headline: "" },
      anomaly: { findings: [], disappeared: [], caveats: [], totals: { thirdParties: 3, unexplained: 1, novel: 1 } },
    }) as never;
    expect(headlineFor(withHost)).toMatch(/1 host nothing accounts for/);
  });

  it("leads with the issues to fix", () => {
    const bad = report({
      summary: { total: 9, present: 6, absent: 2, unverifiable: 1, headline: "" },
      anomaly: { findings: [], disappeared: [], caveats: [], totals: { thirdParties: 4, unexplained: 2, novel: 0 } },
    }) as never;
    expect(headlineFor(bad)).toMatch(/^2 issues to fix/);
  });

  it("gets the singular right, because a report that says '1 issues' reads as unfinished", () => {
    const one = report({
      summary: { total: 9, present: 8, absent: 1, unverifiable: 0, headline: "" },
    }) as never;
    expect(headlineFor(one)).toMatch(/^1 issue to fix/);
  });
});

describe("contacted hosts", () => {
  it("names an unexplained host and marks it new", async () => {
    respondWith({
      report: report({
        anomaly: {
          findings: [
            { host: "hotjar.com", severity: "critical", novelty: "new", vendor: "Hotjar", kind: "session-replay", summary: "Hotjar (hotjar.com) was contacted for the first time.", explainedBy: null },
          ],
          disappeared: [],
          caveats: [],
          totals: { thirdParties: 3, unexplained: 1, novel: 1 },
        },
      }),
    });
    await runScan();
    expect(await screen.findByText("Hotjar")).toBeInTheDocument();
    expect(screen.getByText(/new since last scan/i)).toBeInTheDocument();
  });

  it("says plainly when nothing was unaccounted for", async () => {
    respondWith({ report: report() });
    await runScan();
    await waitFor(() => expect(screen.getByText(/do not account for/i)).toBeInTheDocument());
  });
});
