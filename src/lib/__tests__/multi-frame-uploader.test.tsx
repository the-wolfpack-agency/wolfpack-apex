/**
 * @jest-environment jsdom
 */

/**
 * MultiFrameUploader — UI contract.
 *
 * Covers:
 *   - Empty state: dropzone present, no thumbnails, no submit button.
 *   - 3 files dropped → 3 ordered thumbnails (1, 2, 3) render.
 *   - Remove button on a thumbnail updates the visible list + count.
 *   - Submit with 1 file → onSubmit called with 1-item array.
 *   - Submit with 3 files → onSubmit called with 3-item array in drop order.
 *   - Max-frame cap enforced client-side (surfaces an error banner).
 *   - Unsupported MIME in dropped set surfaces an error banner and
 *     doesn't append any thumbnails.
 *   - Total-size cap enforced client-side.
 */

import "@testing-library/jest-dom";
import { act, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import MultiFrameUploader from "@/components/sites/MultiFrameUploader";

// jsdom has a stub for URL.createObjectURL/revokeObjectURL but it is
// undefined by default — wire simple tokens so thumbs can mint + revoke.
beforeAll(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (URL as any).createObjectURL = jest.fn((f: File) => `blob:mock/${f.name}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (URL as any).revokeObjectURL = jest.fn();
});

function pngFile(name = "w.png", size = 32): File {
  // Tiny fake PNG — the component never decodes bytes, so any Buffer works.
  const buf = new Uint8Array(size);
  return new File([buf], name, { type: "image/png" });
}

function pdfFile(name = "w.pdf", size = 32): File {
  const buf = new Uint8Array(size);
  return new File([buf], name, { type: "application/pdf" });
}

function dropFiles(dropTarget: HTMLElement, files: File[]) {
  // Simulate a drag-drop with a DataTransfer-like payload. jsdom's
  // DataTransfer is read-only; build the minimal shape the component
  // accesses (`.files`).
  const dataTransfer = {
    files,
    types: ["Files"],
  };
  act(() => {
    fireEvent.drop(dropTarget, { dataTransfer });
  });
}

describe("MultiFrameUploader", () => {
  it("renders empty state with no thumbnails", () => {
    const onSubmit = jest.fn();
    render(<MultiFrameUploader onSubmit={onSubmit} />);
    expect(screen.getByTestId("wireframe-dropzone")).toBeInTheDocument();
    expect(screen.queryByTestId("multi-frame-thumbnails")).not.toBeInTheDocument();
    expect(screen.queryByTestId("multi-frame-submit")).not.toBeInTheDocument();
  });

  it("adds 3 files and renders 3 ordered thumbnails", () => {
    const onSubmit = jest.fn();
    render(<MultiFrameUploader onSubmit={onSubmit} />);
    const dz = screen.getByTestId("wireframe-dropzone");
    dropFiles(dz, [pngFile("a.png"), pngFile("b.png"), pngFile("c.png")]);

    expect(screen.getByTestId("multi-frame-thumb-0")).toBeInTheDocument();
    expect(screen.getByTestId("multi-frame-thumb-1")).toBeInTheDocument();
    expect(screen.getByTestId("multi-frame-thumb-2")).toBeInTheDocument();
    // Submit button renders with the correct plural count.
    expect(screen.getByTestId("multi-frame-submit")).toHaveTextContent(
      /Analyze 3 frames/i,
    );
  });

  it("remove button updates the visible list", () => {
    const onSubmit = jest.fn();
    render(<MultiFrameUploader onSubmit={onSubmit} />);
    const dz = screen.getByTestId("wireframe-dropzone");
    dropFiles(dz, [pngFile("a.png"), pngFile("b.png"), pngFile("c.png")]);

    act(() => {
      fireEvent.click(screen.getByTestId("multi-frame-remove-1"));
    });
    // After removing index 1, the remaining thumbnails re-index to 0,1.
    expect(screen.getByTestId("multi-frame-thumb-0")).toBeInTheDocument();
    expect(screen.getByTestId("multi-frame-thumb-1")).toBeInTheDocument();
    expect(screen.queryByTestId("multi-frame-thumb-2")).not.toBeInTheDocument();
  });

  it("submit with 1 file calls onSubmit with 1-item array", () => {
    const onSubmit = jest.fn();
    render(<MultiFrameUploader onSubmit={onSubmit} />);
    const dz = screen.getByTestId("wireframe-dropzone");
    dropFiles(dz, [pngFile("only.png")]);

    act(() => {
      fireEvent.click(screen.getByTestId("multi-frame-submit"));
    });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    const arg = onSubmit.mock.calls[0][0] as File[];
    expect(arg).toHaveLength(1);
    expect(arg[0].name).toBe("only.png");
  });

  it("submit with 3 files calls onSubmit in drop order", () => {
    const onSubmit = jest.fn();
    render(<MultiFrameUploader onSubmit={onSubmit} />);
    const dz = screen.getByTestId("wireframe-dropzone");
    dropFiles(dz, [pngFile("one.png"), pngFile("two.png"), pngFile("three.png")]);

    act(() => {
      fireEvent.click(screen.getByTestId("multi-frame-submit"));
    });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    const arg = onSubmit.mock.calls[0][0] as File[];
    expect(arg.map((f) => f.name)).toEqual(["one.png", "two.png", "three.png"]);
  });

  it("rejects an unsupported MIME in the dropped set", () => {
    const onSubmit = jest.fn();
    render(<MultiFrameUploader onSubmit={onSubmit} />);
    const dz = screen.getByTestId("wireframe-dropzone");
    const bad = new File([new Uint8Array(4)], "x.dmg", {
      type: "application/x-apple-diskimage",
    });
    dropFiles(dz, [pngFile("a.png"), bad]);
    expect(screen.getByTestId("multi-frame-error")).toHaveTextContent(
      /PNG|JPG|WEBP|PDF/,
    );
    // No thumbnails added on a rejected batch.
    expect(screen.queryByTestId("multi-frame-thumbnails")).not.toBeInTheDocument();
  });

  it("enforces the max-frame cap client-side", () => {
    const onSubmit = jest.fn();
    render(<MultiFrameUploader onSubmit={onSubmit} maxFrames={3} />);
    const dz = screen.getByTestId("wireframe-dropzone");
    dropFiles(dz, [pngFile("a.png"), pngFile("b.png")]);
    // Attempt to push past the cap.
    dropFiles(dz, [pngFile("c.png"), pngFile("d.png")]);
    expect(screen.getByTestId("multi-frame-error")).toHaveTextContent(
      /Too many frames/i,
    );
    // First batch is still intact — 2 thumbs, no 3rd/4th.
    expect(screen.getByTestId("multi-frame-thumb-0")).toBeInTheDocument();
    expect(screen.getByTestId("multi-frame-thumb-1")).toBeInTheDocument();
    expect(screen.queryByTestId("multi-frame-thumb-2")).not.toBeInTheDocument();
  });

  it("enforces the total-size cap client-side", () => {
    const onSubmit = jest.fn();
    render(
      <MultiFrameUploader onSubmit={onSubmit} maxTotalBytes={64} />,
    );
    const dz = screen.getByTestId("wireframe-dropzone");
    // Two 40-byte PNGs → 80 > 64 ⇒ rejected.
    dropFiles(dz, [pngFile("a.png", 40), pngFile("b.png", 40)]);
    expect(screen.getByTestId("multi-frame-error")).toHaveTextContent(
      /too large/i,
    );
    expect(screen.queryByTestId("multi-frame-thumbnails")).not.toBeInTheDocument();
  });

  it("PDF frames render a doc chip instead of an <img>", () => {
    const onSubmit = jest.fn();
    render(<MultiFrameUploader onSubmit={onSubmit} />);
    const dz = screen.getByTestId("wireframe-dropzone");
    dropFiles(dz, [pdfFile("report.pdf")]);
    const thumb = screen.getByTestId("multi-frame-thumb-0");
    expect(thumb).toBeInTheDocument();
    // No <img> for PDFs
    expect(thumb.querySelector("img")).toBeNull();
    // File name surfaced inside the chip
    expect(thumb).toHaveTextContent(/report\.pdf/);
  });
});
