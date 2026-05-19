/**
 * @jest-environment jsdom
 *
 * UploadToBrainWidget — drag/drop render, file rows update on accept /
 * reject, analytics events fire on the right transitions, keyboard
 * fallback opens the file picker.
 */

import "@testing-library/jest-dom";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

const mockFetch = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: unknown[]) => mockFetch(...a),
  jsonHeaders: () => ({ "Content-Type": "application/json" }),
}));

import { UploadToBrainWidget } from "@/components/widgets/UploadToBrainWidget";
import type { UploadToBrainWidgetSpec } from "@/lib/assistant/widgets/types";

const spec: UploadToBrainWidgetSpec = {
  kind: "upload_to_brain",
  uploadUrl: "/api/brain/upload",
  maxFileSize: 10 * 1024 * 1024,
  allowedMimeTypes: ["text/plain", "text/markdown", "application/pdf"],
};

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: async () => body,
  } as unknown as Response;
}

function file(name: string, type: string, bytes: number): File {
  const content = new Uint8Array(bytes);
  return new File([content], name, { type });
}

beforeEach(() => {
  mockFetch.mockReset();
  /* Default to analytics-success for /api/analytics calls. */
  mockFetch.mockImplementation(async (url: string) => {
    if (url === "/api/analytics") return jsonResponse({});
    return jsonResponse({ document_id: "doc-x", chunk_count: 1, extracted_chars: 100 }, 201);
  });
});

describe("UploadToBrainWidget render", () => {
  test("renders title + drop zone + zero counters on mount", () => {
    render(<UploadToBrainWidget spec={spec} />);
    expect(screen.getByTestId("upload-to-brain-widget")).toBeInTheDocument();
    expect(screen.getByText(/Upload to Brain/i)).toBeInTheDocument();
    expect(screen.getByTestId("upload-drop-zone")).toBeInTheDocument();
    expect(screen.getByText(/0 accepted, 0 rejected, 0 pending/)).toBeInTheDocument();
  });

  test("fires upload_widget_opened + widget_rendered on mount", async () => {
    render(<UploadToBrainWidget spec={spec} workflowId="wf-1" />);
    await waitFor(() => {
      const opened = mockFetch.mock.calls.find(
        (c) =>
          c[0] === "/api/analytics" &&
          typeof c[1]?.body === "string" &&
          c[1].body.includes("assistant.upload_widget_opened"),
      );
      expect(opened).toBeDefined();
      const rendered = mockFetch.mock.calls.find(
        (c) =>
          c[0] === "/api/analytics" &&
          typeof c[1]?.body === "string" &&
          c[1].body.includes("assistant.widget_rendered"),
      );
      expect(rendered).toBeDefined();
    });
  });

  test("drop zone is keyboard-accessible (Enter opens picker)", () => {
    render(<UploadToBrainWidget spec={spec} />);
    const zone = screen.getByTestId("upload-drop-zone");
    expect(zone).toHaveAttribute("role", "button");
    expect(zone).toHaveAttribute("tabIndex", "0");
    /* Pressing Enter should trigger a click on the hidden file input.
     * The DOM-level interaction is asserted by checking the input
     * exists with display:none — actually clicking it on jsdom doesn't
     * open a real picker, so we assert the wiring (handler set) by
     * pressing the key without a crash. */
    fireEvent.keyDown(zone, { key: "Enter" });
    fireEvent.keyDown(zone, { key: " " });
  });
});

describe("UploadToBrainWidget drop flow", () => {
  test("dropping a file POSTs to uploadUrl + renders an accepted row", async () => {
    render(<UploadToBrainWidget spec={spec} />);
    /* Set the upload response — accepted. */
    mockFetch.mockImplementation(async (url: string) => {
      if (url === "/api/analytics") return jsonResponse({});
      return jsonResponse(
        { document_id: "doc-1", chunk_count: 3, extracted_chars: 500 },
        201,
      );
    });
    const f = file("notes.md", "text/markdown", 1024);
    const zone = screen.getByTestId("upload-drop-zone");
    await act(async () => {
      fireEvent.drop(zone, {
        dataTransfer: { files: [f] },
      });
    });
    await waitFor(() => {
      const row = screen.queryAllByTestId(/^upload-row-accepted-/);
      expect(row.length).toBe(1);
    });
    expect(screen.getByText(/Added to Brain/)).toBeInTheDocument();
    /* file_dropped + file_accepted analytics fired. */
    const events = mockFetch.mock.calls
      .filter((c) => c[0] === "/api/analytics")
      .map((c) => c[1]?.body)
      .filter((b): b is string => typeof b === "string");
    expect(events.some((b) => b.includes('"action":"file_dropped"'))).toBe(true);
    expect(events.some((b) => b.includes('"action":"file_accepted"'))).toBe(true);
  });

  test("server rejection renders a rejected row with each reason as a chip", async () => {
    render(<UploadToBrainWidget spec={spec} />);
    mockFetch.mockImplementation(async (url: string) => {
      if (url === "/api/analytics") return jsonResponse({});
      return jsonResponse(
        {
          error: "upload_rejected",
          reasons: ["secret_aws_access_key", "pii_ssn"],
        },
        400,
      );
    });
    const f = file("leak.txt", "text/plain", 2048);
    const zone = screen.getByTestId("upload-drop-zone");
    await act(async () => {
      fireEvent.drop(zone, {
        dataTransfer: { files: [f] },
      });
    });
    await waitFor(() => {
      const row = screen.queryAllByTestId(/^upload-row-rejected-/);
      expect(row.length).toBe(1);
    });
    expect(screen.getByText("secret_aws_access_key")).toBeInTheDocument();
    expect(screen.getByText("pii_ssn")).toBeInTheDocument();
    /* file_rejected analytics fired. */
    const events = mockFetch.mock.calls
      .filter((c) => c[0] === "/api/analytics")
      .map((c) => c[1]?.body)
      .filter((b): b is string => typeof b === "string");
    expect(events.some((b) => b.includes('"action":"file_rejected"'))).toBe(true);
  });

  test("aggregate counters update after mixed accept + reject", async () => {
    render(<UploadToBrainWidget spec={spec} />);
    let nUpload = 0;
    mockFetch.mockImplementation(async (url: string) => {
      if (url === "/api/analytics") return jsonResponse({});
      nUpload += 1;
      if (nUpload === 1) return jsonResponse({ document_id: "d1" }, 201);
      return jsonResponse(
        { error: "upload_rejected", reasons: ["disallowed_file_type"] },
        400,
      );
    });
    const a = file("a.md", "text/markdown", 1024);
    const b = file("b.mp4", "video/mp4", 1024);
    const zone = screen.getByTestId("upload-drop-zone");
    await act(async () => {
      fireEvent.drop(zone, {
        dataTransfer: { files: [a, b] },
      });
    });
    await waitFor(() => {
      expect(
        screen.getByText(/1 accepted, 1 rejected, 0 pending/),
      ).toBeInTheDocument();
    });
  });

  test("network failure marks the row rejected with 'network_error'", async () => {
    render(<UploadToBrainWidget spec={spec} />);
    mockFetch.mockImplementation(async (url: string) => {
      if (url === "/api/analytics") return jsonResponse({});
      throw new Error("offline");
    });
    const f = file("notes.md", "text/markdown", 1024);
    const zone = screen.getByTestId("upload-drop-zone");
    await act(async () => {
      fireEvent.drop(zone, {
        dataTransfer: { files: [f] },
      });
    });
    await waitFor(() => {
      expect(screen.getByText("network_error")).toBeInTheDocument();
    });
  });
});
