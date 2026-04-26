/** @jest-environment jsdom */
/* eslint-disable @typescript-eslint/no-explicit-any */
import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";

import {
  ClassRowCard,
  type ClassRow,
  type UploadState,
} from "@/app/(dashboard)/automations/porsche-classes/page";

const ROW: ClassRow = {
  class_key: "BA101|2026-04-20|Ritz Carlton",
  course_type: "BA101",
  class_date: "2026-04-20",
  location: "Ritz Carlton",
  sources_present: [],
  sources_missing: [],
  status: "waiting",
  sharepoint_uploaded_at: null,
  last_activity_at: "2026-04-25T18:54:00Z",
  open_exception_count: 0,
};

describe("<ClassRowCard /> — full-row click target", () => {
  test("renders an overlay link covering the entire card with the encoded class_key", () => {
    render(
      <ClassRowCard
        row={ROW}
        uploadState={{ kind: "idle" } as UploadState}
        onUpload={() => {}}
      />,
    );
    const overlay = screen.getByTestId(
      "this-week-row-link-BA101|2026-04-20|Ritz Carlton",
    ) as HTMLAnchorElement;
    expect(overlay.tagName).toBe("A");
    // Overlay link points at the per-class summary route with the
    // class_key encoded for the dynamic segment.
    expect(overlay.getAttribute("href")).toBe(
      `/automations/porsche-classes/summaries/${encodeURIComponent(ROW.class_key)}`,
    );
    // Visible text affordance: the row no longer renders the small
    // "Open" pill — the entire row IS the click target.
    expect(
      screen.queryByTestId(`this-week-open-${ROW.class_key}`),
    ).toBeNull();
  });

  test("overlay link carries an aria-label naming the class for screen readers", () => {
    render(
      <ClassRowCard
        row={ROW}
        uploadState={{ kind: "idle" } as UploadState}
        onUpload={() => {}}
      />,
    );
    const overlay = screen.getByTestId(
      "this-week-row-link-BA101|2026-04-20|Ritz Carlton",
    );
    const label = overlay.getAttribute("aria-label") ?? "";
    expect(label).toMatch(/Open/);
    expect(label).toMatch(/BA101/);
  });

  test("Send to SharePoint button fires onUpload and is NOT swallowed by the overlay link", () => {
    const onUpload = jest.fn();
    render(
      <ClassRowCard
        row={{ ...ROW, status: "ready", sources_present: [] }}
        uploadState={{ kind: "idle" } as UploadState}
        onUpload={onUpload}
      />,
    );
    const sendBtn = screen.getByTestId(`this-week-upload-${ROW.class_key}`);
    fireEvent.click(sendBtn);
    expect(onUpload).toHaveBeenCalledTimes(1);
  });

  test("Send button hidden once the class has already been uploaded to SharePoint", () => {
    render(
      <ClassRowCard
        row={{
          ...ROW,
          status: "ready",
          sharepoint_uploaded_at: "2026-04-25T20:00:00Z",
        }}
        uploadState={{ kind: "idle" } as UploadState}
        onUpload={() => {}}
      />,
    );
    expect(
      screen.queryByTestId(`this-week-upload-${ROW.class_key}`),
    ).toBeNull();
    // Overlay link still works — the whole row is still clickable.
    expect(
      screen.getByTestId(`this-week-row-link-${ROW.class_key}`),
    ).toBeInTheDocument();
  });
});
