/**
 * @jest-environment jsdom
 *
 * AttachmentBlock — meeting-insights per-attachment row.
 *
 * Covers:
 *   - render of filename + size + mime
 *   - click "View text" → calls fetchWithRefresh on /text endpoint
 *   - extracted text renders in <pre>
 *   - unsupported_mime status renders the "download to view" caption
 *     and never fires fetchWithRefresh
 *   - error state renders + retry re-fires fetch
 *   - download href is the correct /download route
 */

import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const mockFetch = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...args: unknown[]) => mockFetch(...args),
}));

import { AttachmentBlock } from "../AttachmentBlock";

const BASE_PROPS = {
  feedSlug: "weekly-standup",
  messageId: "msg-123",
};

beforeEach(() => {
  mockFetch.mockReset();
});

function res(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe("AttachmentBlock", () => {
  test("renders filename + size + mime", () => {
    render(
      <AttachmentBlock
        {...BASE_PROPS}
        attachment={{
          id: "att-1",
          filename: "agenda.docx",
          mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          size_bytes: 2048,
          extraction_status: "extracted",
        }}
      />,
    );
    expect(screen.getByText("agenda.docx")).toBeInTheDocument();
    expect(screen.getByText(/2\.0 KB/)).toBeInTheDocument();
  });

  test("download link points to the /download endpoint with encoded params", () => {
    render(
      <AttachmentBlock
        feedSlug="my feed/1"
        messageId="msg id"
        attachment={{
          id: "att 1",
          filename: "x.txt",
          mime: "text/plain",
          size_bytes: 5,
          extraction_status: "extracted",
        }}
      />,
    );
    const link = screen.getByRole("link", { name: /download/i });
    expect(link).toHaveAttribute(
      "href",
      "/api/meetings/feeds/my%20feed%2F1/messages/msg%20id/attachments/att%201/download",
    );
  });

  test("clicking 'View text' fetches the /text endpoint and shows the extracted text", async () => {
    mockFetch.mockResolvedValueOnce(
      res(200, {
        text: "Q2 goals\n- ship",
        status: "extracted",
        filename: "agenda.txt",
        mime: "text/plain",
        size_bytes: 16,
      }),
    );
    render(
      <AttachmentBlock
        {...BASE_PROPS}
        attachment={{
          id: "att-1",
          filename: "agenda.txt",
          mime: "text/plain",
          size_bytes: 16,
          extraction_status: "extracted",
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /view text/i }));

    expect(screen.getByTestId("attachment-loading")).toBeInTheDocument();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toBe(
      "/api/meetings/feeds/weekly-standup/messages/msg-123/attachments/att-1/text",
    );

    await waitFor(() => {
      expect(screen.getByTestId("attachment-text")).toBeInTheDocument();
    });
    expect(screen.getByTestId("attachment-text").textContent).toContain(
      "Q2 goals",
    );
  });

  test("toggling collapse and re-expanding does NOT re-fetch", async () => {
    mockFetch.mockResolvedValueOnce(
      res(200, {
        text: "hi",
        status: "extracted",
        filename: "x.txt",
        mime: "text/plain",
        size_bytes: 2,
      }),
    );
    render(
      <AttachmentBlock
        {...BASE_PROPS}
        attachment={{
          id: "att-1",
          filename: "x.txt",
          mime: "text/plain",
          size_bytes: 2,
          extraction_status: "extracted",
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /view text/i }));
    await waitFor(() =>
      expect(screen.getByTestId("attachment-text")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: /hide text/i }));
    fireEvent.click(screen.getByRole("button", { name: /view text/i }));
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test("unsupported_mime: shows 'Preview not available — download to view' and never fetches", () => {
    render(
      <AttachmentBlock
        {...BASE_PROPS}
        attachment={{
          id: "att-1",
          filename: "image.png",
          mime: "image/png",
          size_bytes: 8192,
          extraction_status: "unsupported_mime",
        }}
      />,
    );
    expect(
      screen.getByText(/Preview not available — download to view/i),
    ).toBeInTheDocument();
    // No "View text" button — extraction was already determined to be impossible.
    expect(
      screen.queryByRole("button", { name: /view text/i }),
    ).not.toBeInTheDocument();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("error status (extraction failed at ingest): shows red caption, no fetch", () => {
    render(
      <AttachmentBlock
        {...BASE_PROPS}
        attachment={{
          id: "att-1",
          filename: "broken.pdf",
          mime: "application/pdf",
          size_bytes: 1024,
          extraction_status: "error",
        }}
      />,
    );
    expect(
      screen.getByText(/We couldn't extract text from this file/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /view text/i }),
    ).not.toBeInTheDocument();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("non-OK fetch surfaces an error + retry button re-fires the fetch", async () => {
    mockFetch.mockResolvedValueOnce(res(500, {}));
    mockFetch.mockResolvedValueOnce(
      res(200, {
        text: "ok now",
        status: "extracted",
        filename: "x.txt",
        mime: "text/plain",
        size_bytes: 6,
      }),
    );
    render(
      <AttachmentBlock
        {...BASE_PROPS}
        attachment={{
          id: "att-1",
          filename: "x.txt",
          mime: "text/plain",
          size_bytes: 6,
          extraction_status: "extracted",
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /view text/i }));
    await waitFor(() =>
      expect(screen.getByText(/Failed to load preview/i)).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    await waitFor(() =>
      expect(screen.getByTestId("attachment-text")).toBeInTheDocument(),
    );
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
