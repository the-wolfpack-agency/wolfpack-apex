/** @jest-environment jsdom */

import "@testing-library/jest-dom";

/**
 * ExtractedFieldsTable — pure presentational table.
 *
 * Pins:
 *   1. Empty state when fields is empty.
 *   2. One row per field when populated.
 *   3. Field names humanized (PascalCase / snake_case → spaced Title).
 *   4. Confidence shown as integer percent.
 *   5. Rows sorted by confidence descending.
 *   6. Long values wrap (do not overflow the table layout).
 */

import { render, screen } from "@testing-library/react";
import {
  ExtractedFieldsTable,
  humanizeFieldName,
} from "../ExtractedFieldsTable";
import type { ExtractedField } from "@/lib/document-recognition/types";

function mkField(overrides: Partial<ExtractedField> = {}): ExtractedField {
  return {
    name: "vendor",
    value: "Acme Hardware",
    confidence: 0.9,
    ...overrides,
  };
}

describe("<ExtractedFieldsTable />", () => {
  it("renders the empty state when fields is empty", () => {
    render(<ExtractedFieldsTable fields={[]} />);
    expect(screen.getByTestId("extracted-fields-empty")).toBeInTheDocument();
    expect(
      screen.queryByTestId("extracted-fields-table"),
    ).not.toBeInTheDocument();
  });

  it("renders one row per field when populated", () => {
    render(
      <ExtractedFieldsTable
        fields={[
          mkField({ name: "vendor" }),
          mkField({ name: "total", value: "42.50" }),
          mkField({ name: "transaction_date", value: "2026-05-21" }),
        ]}
      />,
    );
    expect(screen.getByTestId("extracted-fields-table")).toBeInTheDocument();
    expect(
      screen.getByTestId("extracted-field-row-vendor"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("extracted-field-row-total"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("extracted-field-row-transaction_date"),
    ).toBeInTheDocument();
  });

  it("humanizes field names (PascalCase and snake_case)", () => {
    /* Sanity-check the helper directly + via the rendered output so
       both layers are pinned. */
    expect(humanizeFieldName("WagesTipsAndOtherCompensation")).toBe(
      "Wages Tips And Other Compensation",
    );
    expect(humanizeFieldName("transaction_date")).toBe("Transaction Date");
    expect(humanizeFieldName("merchant-name")).toBe("Merchant Name");

    render(
      <ExtractedFieldsTable
        fields={[
          mkField({ name: "WagesTipsAndOtherCompensation", value: "55000" }),
          mkField({ name: "transaction_date", value: "2026-05-21" }),
        ]}
      />,
    );
    const wagesRow = screen.getByTestId(
      "extracted-field-row-WagesTipsAndOtherCompensation",
    );
    expect(wagesRow).toHaveTextContent("Wages Tips And Other Compensation");
    expect(
      screen.getByTestId("extracted-field-row-transaction_date"),
    ).toHaveTextContent("Transaction Date");
  });

  it("renders confidence as an integer percentage", () => {
    render(
      <ExtractedFieldsTable
        fields={[
          mkField({ name: "vendor", confidence: 0.87 }),
          mkField({ name: "total", value: "42", confidence: 0.5 }),
        ]}
      />,
    );
    expect(
      screen.getByTestId("extracted-field-confidence-vendor"),
    ).toHaveTextContent("87%");
    expect(
      screen.getByTestId("extracted-field-confidence-total"),
    ).toHaveTextContent("50%");
  });

  it("sorts rows by confidence descending", () => {
    render(
      <ExtractedFieldsTable
        fields={[
          mkField({ name: "low", confidence: 0.1 }),
          mkField({ name: "high", confidence: 0.95 }),
          mkField({ name: "mid", confidence: 0.5 }),
        ]}
      />,
    );
    const rows = Array.from(
      document.querySelectorAll('[data-testid^="extracted-field-row-"]'),
    );
    const order = rows.map((r) =>
      (r as HTMLElement).getAttribute("data-testid"),
    );
    expect(order).toEqual([
      "extracted-field-row-high",
      "extracted-field-row-mid",
      "extracted-field-row-low",
    ]);
  });

  it("wraps long values via word-break style, not overflow", () => {
    const longValue =
      "ThisIsAReallyLongRunOfCharactersThatHasNoNaturalBreakPointsAndCouldOverflowATableCellIfNotConstrained";
    render(
      <ExtractedFieldsTable
        fields={[mkField({ name: "raw_text", value: longValue })]}
      />,
    );
    const cell = screen.getByTestId("extracted-field-value-raw_text");
    /* The cell sets word-break and a max-width so the long token wraps
       inside the column instead of forcing the table wider. */
    expect(cell.getAttribute("style") ?? "").toMatch(/word-break:\s*break-word/);
    expect(cell.getAttribute("style") ?? "").toMatch(/max-width/);
  });
});
