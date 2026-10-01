/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { SiteUsagePanel } from "@/components/site-analytics/SiteUsagePanel";
import { LearnedSignaturesPanel } from "@/components/site-analytics/LearnedSignaturesPanel";
import { AgentIntelPanel } from "@/components/site-analytics/AgentIntelPanel";

const USAGE = {
  rangeDays: 30, collectsPageViews: true, totalPageViews: 128, totalEvents: 300,
  byHour: Array.from({ length: 24 }, (_, h) => ({ hour: h, count: h })),
  byPage: [{ path: "/pricing", count: 9 }],
  byCountry: [{ country: "US", count: 40 }],
  agentOrigins: [],
  forcefield: { welcomed: 5, flagged: 2, trapped: 1, blocked: 3, hostileOperators: 1, hostileEvents: 4, topAgents: [{ agent: "GPTBot", count: 7 }] },
};

test("SiteUsagePanel renders totals, heatmap, and top pages/countries", () => {
  render(<SiteUsagePanel data={USAGE} />);
  expect(screen.getByTestId("total-page-views")).toHaveTextContent("128");
  expect(screen.getByTestId("site-hour-heatmap")).toBeInTheDocument();
  expect(screen.getByTestId("top-pages")).toHaveTextContent("/pricing");
  expect(screen.getByTestId("top-countries")).toHaveTextContent("US");
  expect(screen.getByTestId("ff-blocked")).toHaveTextContent("3");
});

test("SiteUsagePanel shows n/a (not 0) when the property collects no page views", () => {
  render(<SiteUsagePanel data={{ ...USAGE, collectsPageViews: false, totalPageViews: 0 }} />);
  expect(screen.getByTestId("total-page-views")).toHaveTextContent("n/a");
});

test("LearnedSignaturesPanel renders the shadow / enforcing / auto-blocked counts", () => {
  render(<LearnedSignaturesPanel data={{ shadow: 4, enforcing: 2, autoBlocked: 1 }} />);
  expect(screen.getByTestId("sig-shadow")).toHaveTextContent("4");
  expect(screen.getByTestId("sig-enforcing")).toHaveTextContent("2");
  expect(screen.getByTestId("sig-autoblocked")).toHaveTextContent("1");
});

test("LearnedSignaturesPanel degrades to zeros when the slice is absent", () => {
  render(<LearnedSignaturesPanel />);
  expect(screen.getByTestId("sig-shadow")).toHaveTextContent("0");
});

test("AgentIntelPanel renders the operator/campaign/automation mix", () => {
  render(<AgentIntelPanel data={{ operators: 6, campaigns: 2, automationFleet: 3, aiAgents: 1, scripts: 2, datacenterOperators: 1, persistedAfterBlock: 1, escalatedAfterBlock: 0, topCampaigns: [{ fp: "fp1", sites: ["a.com"], clientClass: "script", rhythm: "steady" }] }} />);
  expect(screen.getByTestId("intel-campaigns")).toHaveTextContent("2");
  expect(screen.getByTestId("intel-top-campaigns")).toBeInTheDocument();
});
