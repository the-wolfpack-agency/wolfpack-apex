/**
 * @jest-environment jsdom
 *
 * ProductCatalog UI tests: empty state, card rendering (value + potential
 * uses), status chips, the live/in-flight counts, and the status filter.
 */

import "@testing-library/jest-dom";
import { fireEvent, render, screen, within } from "@testing-library/react";
import ProductCatalog from "@/components/products/ProductCatalog";
import type { Product } from "@/lib/products";

function make(over: Partial<Product>): Product {
  return {
    id: over.id ?? "p",
    name: over.name ?? "Product",
    area: over.area ?? "Area",
    tagline: over.tagline ?? "A tagline",
    summary: over.summary ?? "A summary of value.",
    highlights: over.highlights ?? ["Value point"],
    audience: over.audience ?? "Everyone",
    potentialUses: over.potentialUses ?? ["Reusable elsewhere"],
    status: over.status ?? "live",
    ...over,
  };
}

const PRODUCTS: Product[] = [
  make({ id: "auto", name: "Auto", status: "live", highlights: ["Runs the dealership"], potentialUses: ["Adapts to marine and RV retail"] }),
  make({ id: "beyond", name: "Beyond", status: "in_flight" }),
  make({ id: "porsche", name: "Porsche Weekend", status: "preview" }),
];

test("renders an empty state when there are no products", () => {
  render(<ProductCatalog products={[]} />);
  expect(screen.getByTestId("products-empty")).toBeInTheDocument();
});

test("renders a card per product with value and potential-uses content", () => {
  render(<ProductCatalog products={PRODUCTS} />);
  const auto = screen.getByTestId("product-card-auto");
  expect(within(auto).getByText("Auto")).toBeInTheDocument();
  expect(within(auto).getByText("Runs the dealership")).toBeInTheDocument();
  expect(within(auto).getByText("Adapts to marine and RV retail")).toBeInTheDocument();
  expect(within(auto).getByText(/Where its parts could be reused/i)).toBeInTheDocument();
});

test("shows live and in-flight counts (the engagements read)", () => {
  render(<ProductCatalog products={PRODUCTS} />);
  const counts = screen.getByTestId("products-counts");
  // 1 live (auto), 2 in flight (beyond in_flight + porsche preview).
  expect(within(counts).getByText("1")).toBeInTheDocument();
  expect(within(counts).getByText("2")).toBeInTheDocument();
});

test("filtering to Live shows only production products", () => {
  render(<ProductCatalog products={PRODUCTS} />);
  fireEvent.click(screen.getByTestId("products-filter-live"));
  expect(screen.getByTestId("product-card-auto")).toBeInTheDocument();
  expect(screen.queryByTestId("product-card-beyond")).not.toBeInTheDocument();
  expect(screen.queryByTestId("product-card-porsche")).not.toBeInTheDocument();
});

test("filtering to In flight shows in_flight and preview products, not live", () => {
  render(<ProductCatalog products={PRODUCTS} />);
  fireEvent.click(screen.getByTestId("products-filter-in_flight"));
  expect(screen.queryByTestId("product-card-auto")).not.toBeInTheDocument();
  expect(screen.getByTestId("product-card-beyond")).toBeInTheDocument();
  expect(screen.getByTestId("product-card-porsche")).toBeInTheDocument();
});
