/**
 * @jest-environment jsdom
 */
/**
 * UI tests for /governance-sample (public, static sample artifact).
 *
 * The page is intentionally static (no auth, no fetch, no user input), so these
 * tests assert the key sections render and the honesty disclaimer is present.
 * The illustrative-sample disclaimer is load-bearing: if it ever disappears the
 * page reads as a real customer report, which would be an overclaim.
 */

import React from "react";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import GovernanceSamplePage from "@/app/governance-sample/page";

describe("GovernanceSamplePage", () => {
  beforeEach(() => {
    render(<GovernanceSamplePage />);
  });

  it("renders the illustrative-sample disclaimer", () => {
    const disclaimer = screen.getByTestId("sample-disclaimer");
    expect(disclaimer).toBeInTheDocument();
    expect(disclaimer).toHaveTextContent(/illustrative sample/i);
    expect(disclaimer).toHaveTextContent(/not a certification and not legal advice/i);
  });

  it("renders the AI surfaces discovered + ungoverned counts", () => {
    expect(screen.getByTestId("surfaces-section")).toBeInTheDocument();
    expect(screen.getByTestId("surfaces-discovered")).toHaveTextContent("14");
    expect(screen.getByTestId("surfaces-ungoverned")).toHaveTextContent("9");
  });

  it("renders one example of each gate decision type", () => {
    expect(screen.getByTestId("decision-allow")).toBeInTheDocument();
    expect(screen.getByTestId("decision-redact")).toBeInTheDocument();
    expect(screen.getByTestId("decision-escalate")).toBeInTheDocument();
    expect(screen.getByTestId("decision-deny")).toBeInTheDocument();
  });

  it("renders the red-team pass rate", () => {
    expect(screen.getByTestId("redteam-section")).toBeInTheDocument();
    expect(screen.getByTestId("redteam-pass-rate")).toHaveTextContent("97%");
  });

  it("renders the compliance coverage table with framework rows", () => {
    expect(screen.getByTestId("compliance-section")).toBeInTheDocument();
    const rows = screen.getAllByTestId("compliance-row");
    expect(rows.length).toBeGreaterThanOrEqual(4);
    expect(screen.getByText(/EU AI Act/i)).toBeInTheDocument();
  });

  it("renders a clear CTA to request a real free scan", () => {
    const cta = screen.getByTestId("cta-request-scan");
    expect(cta).toBeInTheDocument();
    expect(cta).toHaveTextContent(/request a free scan/i);
  });

  it("does not claim certification or compliance (honesty guardrail)", () => {
    const body = screen.getByTestId("governance-sample").textContent ?? "";
    expect(body).not.toMatch(/SOC ?2 certified/i);
    expect(body).not.toMatch(/quantum-safe/i);
    expect(body).toMatch(/decision-support evidence/i);
  });
});
