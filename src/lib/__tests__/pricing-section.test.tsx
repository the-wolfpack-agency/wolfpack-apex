/**
 * @jest-environment jsdom
 */

/**
 * pricing section renderer tests.
 *
 * Covers:
 *   - N valid tiers → N cards rendered with name + price + features + CTA.
 *   - Each feature renders as its own <li> (testid="pricing-feature").
 *   - Empty / missing items → empty-state placeholder, no crash.
 *   - XSS smoke: <script> in plan name / price / feature renders as text.
 *   - Items missing required fields (name / price / non-empty features)
 *     are skipped individually; siblings still render.
 *   - `highlighted: true` tier gets a distinguishing class + data attr.
 *   - Dispatcher wiring: RenderSection routes type=pricing to PricingSection.
 */

import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { PricingSection } from "@/components/sites/sections/pricing";
import { RenderSection } from "@/components/sites/render-brief";

describe("PricingSection — happy paths", () => {
  it("renders N tiers with name, price, features, CTA", () => {
    render(
      <PricingSection
        section={{
          type: "pricing",
          heading: "Plans",
          body: "Pick a tier.",
          items: [
            {
              name: "Starter",
              price: "$0/mo",
              features: ["Solo user", "1 project"],
              cta: { label: "Start free", href: "/signup" },
            },
            {
              name: "Pro",
              price: "$29/mo",
              features: ["Up to 10 users", "Priority support"],
              cta: { label: "Upgrade", href: "/upgrade" },
              highlighted: true,
            },
            {
              name: "Enterprise",
              price: "Contact us",
              features: ["SSO", "SLA"],
              cta: { label: "Contact sales", href: "/contact" },
            },
          ],
        }}
      />,
    );
    const tiers = screen.getAllByTestId("pricing-item");
    expect(tiers).toHaveLength(3);
    expect(tiers[0]).toHaveTextContent("Starter");
    expect(tiers[0]).toHaveTextContent("$0/mo");
    expect(tiers[1]).toHaveTextContent("Pro");
    expect(tiers[1]).toHaveTextContent("$29/mo");
    expect(tiers[2]).toHaveTextContent("Contact us");

    const ctas = screen.getAllByTestId("pricing-cta");
    expect(ctas).toHaveLength(3);
    expect(ctas[0]).toHaveAttribute("href", "/signup");
    expect(ctas[0]).toHaveTextContent("Start free");
  });

  it("renders each feature as its own list item", () => {
    render(
      <PricingSection
        section={{
          type: "pricing",
          items: [
            {
              name: "Pro",
              price: "$29",
              features: ["Feature A", "Feature B", "Feature C"],
            },
          ],
        }}
      />,
    );
    const features = screen.getAllByTestId("pricing-feature");
    expect(features).toHaveLength(3);
    expect(features[0]).toHaveTextContent("Feature A");
    expect(features[1]).toHaveTextContent("Feature B");
    expect(features[2]).toHaveTextContent("Feature C");
  });

  it("renders heading + tagline body when provided", () => {
    render(
      <PricingSection
        section={{
          type: "pricing",
          heading: "Simple pricing",
          body: "No hidden fees.",
          items: [{ name: "X", price: "$1", features: ["a"] }],
        }}
      />,
    );
    expect(screen.getByRole("heading", { name: "Simple pricing" })).toBeInTheDocument();
    expect(screen.getByText("No hidden fees.")).toBeInTheDocument();
  });

  it("marks highlighted tier with data-highlighted + distinguishing class", () => {
    render(
      <PricingSection
        section={{
          type: "pricing",
          items: [
            { name: "Starter", price: "$0", features: ["a"] },
            { name: "Pro", price: "$29", features: ["a"], highlighted: true },
          ],
        }}
      />,
    );
    const tiers = screen.getAllByTestId("pricing-item");
    expect(tiers[0]).toHaveAttribute("data-highlighted", "false");
    expect(tiers[1]).toHaveAttribute("data-highlighted", "true");
    // Highlighted tier must get a distinguishing class not present on the
    // non-highlighted sibling — we key on the shared marker class.
    expect(tiers[1].className).toContain("pricing-highlighted");
    expect(tiers[0].className).not.toContain("pricing-highlighted");
  });

  it("omits CTA anchor when cta is missing", () => {
    render(
      <PricingSection
        section={{
          type: "pricing",
          items: [{ name: "Free", price: "$0", features: ["one"] }],
        }}
      />,
    );
    expect(screen.queryByTestId("pricing-cta")).not.toBeInTheDocument();
  });
});

describe("PricingSection — empty / invalid", () => {
  it("renders empty state when items missing", () => {
    render(<PricingSection section={{ type: "pricing", heading: "Plans" }} />);
    expect(screen.getByTestId("pricing-empty")).toBeInTheDocument();
    expect(screen.queryByTestId("pricing-item")).not.toBeInTheDocument();
  });

  it("renders empty state when items empty array", () => {
    render(<PricingSection section={{ type: "pricing", items: [] }} />);
    expect(screen.getByTestId("pricing-empty")).toBeInTheDocument();
  });

  it("skips invalid items (missing name / price / features) but renders valid ones", () => {
    render(
      <PricingSection
        section={{
          type: "pricing",
          items: [
            { name: "", price: "$0", features: ["a"] }, // skipped: empty name
            { name: "X", price: "", features: ["a"] }, // skipped: empty price
            { name: "Y", price: "$1", features: [] }, // skipped: empty features
            { name: "Z", price: "$1" }, // skipped: no features
            { name: "Valid", price: "$1", features: ["ok"] }, // rendered
          ],
        }}
      />,
    );
    const tiers = screen.getAllByTestId("pricing-item");
    expect(tiers).toHaveLength(1);
    expect(tiers[0]).toHaveTextContent("Valid");
  });
});

describe("PricingSection — XSS smoke", () => {
  it("escapes <script> in name / price / feature (renders as text)", () => {
    const { container } = render(
      <PricingSection
        section={{
          type: "pricing",
          items: [
            {
              name: "<script>alert('n')</script>",
              price: "<script>alert('p')</script>",
              features: ["<script>alert('f')</script>", "normal"],
            },
          ],
        }}
      />,
    );
    const section = screen.getByTestId("pricing-section");
    expect(section.querySelector("script")).toBeNull();
    expect(section).toHaveTextContent("<script>alert('n')</script>");
    expect(section).toHaveTextContent("<script>alert('p')</script>");
    expect(section).toHaveTextContent("<script>alert('f')</script>");
    expect(container.innerHTML).toContain("&lt;script&gt;");
  });
});

describe("RenderSection dispatcher — pricing routing", () => {
  it("routes type=pricing to PricingSection", () => {
    render(
      <RenderSection
        index={0}
        section={{
          type: "pricing",
          items: [{ name: "X", price: "$1", features: ["a"] }],
        }}
      />,
    );
    expect(screen.getByTestId("pricing-section")).toHaveAttribute(
      "data-section-type",
      "pricing",
    );
  });
});
