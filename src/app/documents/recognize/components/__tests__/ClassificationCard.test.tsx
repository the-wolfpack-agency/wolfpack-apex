/** @jest-environment jsdom */

import "@testing-library/jest-dom";

/**
 * ClassificationCard — pure presentational component.
 *
 * Pins:
 *   1. Type label is humanized ("tax_w2" → "W-2 Tax Form").
 *   2. Confidence rendered as integer percent.
 *   3. Rationale text appears.
 *   4. Reclassify dropdown surfaces every DocumentType option.
 *   5. Changing the dropdown invokes onCorrected with the new type.
 *   6. After correction, "Corrected" indicator appears.
 */

import { render, screen, fireEvent } from "@testing-library/react";
import { ClassificationCard } from "../ClassificationCard";
import { DOCUMENT_TYPES } from "@/lib/document-recognition/types";
import type {
  DocumentClassification,
  DocumentType,
} from "@/lib/document-recognition/types";

function mkClassification(
  overrides: Partial<DocumentClassification> = {},
): DocumentClassification {
  return {
    type: "tax_w2",
    confidence: 0.87,
    alternates: [
      { type: "tax_1099", confidence: 0.06 },
      { type: "invoice", confidence: 0.03 },
    ],
    rationale: "Header reads 'Form W-2 Wage and Tax Statement'.",
    model: "claude-3-haiku",
    latencyMs: 420,
    costCents: 0.2,
    ...overrides,
  };
}

describe("<ClassificationCard />", () => {
  it("renders the document type as a humanized label", () => {
    render(
      <ClassificationCard
        classification={mkClassification({ type: "tax_w2" })}
        recognitionId="rec_1"
        onCorrected={jest.fn()}
      />,
    );
    expect(screen.getByTestId("classification-type-label")).toHaveTextContent(
      "W-2 Tax Form",
    );
  });

  it("renders confidence as an integer percentage", () => {
    render(
      <ClassificationCard
        classification={mkClassification({ confidence: 0.87 })}
        recognitionId="rec_1"
        onCorrected={jest.fn()}
      />,
    );
    expect(
      screen.getByTestId("classification-confidence-badge"),
    ).toHaveTextContent("87%");
  });

  it("renders the model's rationale text", () => {
    render(
      <ClassificationCard
        classification={mkClassification({
          rationale: "Header reads 'Form W-2 Wage and Tax Statement'.",
        })}
        recognitionId="rec_1"
        onCorrected={jest.fn()}
      />,
    );
    expect(screen.getByTestId("classification-rationale")).toHaveTextContent(
      /Form W-2/,
    );
  });

  it("reclassify dropdown lists every DocumentType option", () => {
    render(
      <ClassificationCard
        classification={mkClassification()}
        recognitionId="rec_1"
        onCorrected={jest.fn()}
      />,
    );
    const select = screen.getByTestId(
      "classification-reclassify-select",
    ) as HTMLSelectElement;
    const optionValues = Array.from(select.options).map((o) => o.value);
    for (const t of DOCUMENT_TYPES) {
      expect(optionValues).toContain(t);
    }
    /* Every type label must surface as a human string in the dropdown
       (so non-tech users see "Receipt" not "receipt"). */
    expect(select.textContent).toMatch(/Receipt/);
    expect(select.textContent).toMatch(/W-2 Tax Form/);
    expect(select.textContent).toMatch(/1099 Tax Form/);
    expect(select.textContent).toMatch(/ID Document/);
  });

  it("changing the dropdown invokes onCorrected with the new type", () => {
    const onCorrected = jest.fn();
    render(
      <ClassificationCard
        classification={mkClassification({ type: "tax_w2" })}
        recognitionId="rec_1"
        onCorrected={onCorrected}
      />,
    );
    const select = screen.getByTestId(
      "classification-reclassify-select",
    ) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "tax_1099" } });
    expect(onCorrected).toHaveBeenCalledTimes(1);
    expect(onCorrected).toHaveBeenCalledWith<[DocumentType]>("tax_1099");
  });

  it("shows the Corrected indicator after a correction", () => {
    render(
      <ClassificationCard
        classification={mkClassification({ type: "tax_w2" })}
        recognitionId="rec_1"
        onCorrected={jest.fn()}
      />,
    );
    expect(
      screen.queryByTestId("classification-corrected-indicator"),
    ).not.toBeInTheDocument();
    const select = screen.getByTestId(
      "classification-reclassify-select",
    ) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "tax_1099" } });
    expect(
      screen.getByTestId("classification-corrected-indicator"),
    ).toHaveTextContent(/corrected/i);
  });

  it("selecting the same type does NOT bubble a no-op correction", () => {
    /* Bonus: defensively guarantee we never PATCH the API just because
       the user opened-then-closed the dropdown on the same value. */
    const onCorrected = jest.fn();
    render(
      <ClassificationCard
        classification={mkClassification({ type: "tax_w2" })}
        recognitionId="rec_1"
        onCorrected={onCorrected}
      />,
    );
    const select = screen.getByTestId(
      "classification-reclassify-select",
    ) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "tax_w2" } });
    expect(onCorrected).not.toHaveBeenCalled();
  });
});
