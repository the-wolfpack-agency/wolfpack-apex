/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { PageIntegrityPanel, type PageIntegrityData } from "../PageIntegrityPanel";

const DAY = 86400_000;
const T0 = Date.parse("2026-10-01T00:00:00Z");
const origin = (o: Partial<PageIntegrityData["origins"][number]>): PageIntegrityData["origins"][number] => ({
  directive: "script-src", origin: "https://cdn.example", status: "baseline", wouldAlert: false,
  firstSeen: new Date(T0).toISOString(), lastSeen: new Date(T0 + DAY).toISOString(),
  reports: 10, sessions: 8, pages: 3, sessions24h: 0, pages24h: 0, topPage: "/", ...o,
});
const learning = (active: boolean) => ({ startedAt: new Date(T0).toISOString(), endsAt: new Date(T0 + 7 * DAY).toISOString(), active });

it("no reports yet: an explicit empty state, never a blank panel", () => {
  render(<PageIntegrityPanel data={{ learning: null, origins: [], totals: { origins: 0, newOrigins: 0, wouldAlert: 0 } }} />);
  expect(screen.getByTestId("page-integrity-empty")).toHaveTextContent(/No reports yet/);
});

it("while learning it says so, and lists what the pages normally load", () => {
  render(<PageIntegrityPanel data={{ learning: learning(true), origins: [origin({})], totals: { origins: 1, newOrigins: 0, wouldAlert: 0 } }} />);
  expect(screen.getByTestId("page-integrity-learning")).toHaveTextContent(/Learning what your pages normally load/);
  expect(screen.getByTestId("page-integrity-row-0")).toHaveTextContent("Runs a script from https://cdn.example");
  expect(screen.getByTestId("page-integrity-status-0")).toHaveTextContent("Seen in the baseline");
});

it("after the baseline with nothing new: the reassuring line", () => {
  render(<PageIntegrityPanel data={{ learning: learning(false), origins: [origin({})], totals: { origins: 1, newOrigins: 0, wouldAlert: 0 } }} />);
  expect(screen.getByTestId("page-integrity-headline")).toHaveTextContent("Your pages load only what they loaded during the baseline.");
});

it("a new origin for few visitors reads as likely an extension; one for many visitors says to check it", () => {
  const { rerender } = render(<PageIntegrityPanel data={{ learning: learning(false), origins: [origin({ origin: "https://ext.example", status: "new" })], totals: { origins: 1, newOrigins: 1, wouldAlert: 0 } }} />);
  expect(screen.getByTestId("page-integrity-headline")).toHaveTextContent(/usually a browser extension/);
  rerender(<PageIntegrityPanel data={{ learning: learning(false), origins: [origin({ origin: "https://skim.example", directive: "connect-src", status: "new", wouldAlert: true })], totals: { origins: 1, newOrigins: 1, wouldAlert: 1 } }} />);
  expect(screen.getByTestId("page-integrity-headline")).toHaveTextContent(/1 new place is reaching many of your visitors/);
  expect(screen.getByTestId("page-integrity-row-0")).toHaveTextContent("Sends data to https://skim.example");
  expect(screen.getByTestId("page-integrity-status-0")).toHaveTextContent("New, many visitors");
});
