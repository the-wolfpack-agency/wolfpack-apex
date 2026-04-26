/** @jest-environment jsdom */
/* eslint-disable @typescript-eslint/no-explicit-any */
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mockFetchWithRefresh = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: any[]) => mockFetchWithRefresh(...a),
}));

import OperatorActions, {
  detectSourceTypeFromFilename,
} from "@/app/(dashboard)/automations/porsche-classes/_components/OperatorActions";

beforeEach(() => mockFetchWithRefresh.mockReset());

describe("detectSourceTypeFromFilename", () => {
  test.each([
    ["Coordinator Class Report - Amy Federman.eml", "cognito_coordinator"],
    ["Instructor Class Report - Jen Eby.eml", "cognito_instructor"],
    ["Facilitator Class Report - X.eml", "cognito_instructor"],
    ["Onsite Class Report - Y.eml", "cognito_instructor"],
    ["Survey Data PCBA 101 Pendry March 23-27th.xlsx", "survey"],
    ["102 Intercontinental March 16-20, 2026.xlsx", "survey"],
    ["Daily Report 2026-04-20.xlsx", "porsche_xlsx"],
    ["random.txt", null],
  ])("%s → %s", (filename, expected) => {
    expect(detectSourceTypeFromFilename(filename)).toBe(expected);
  });
});

describe("<OperatorActions /> — run inbox poll", () => {
  test("clicking Run inbox poll POSTs to /api/automations/porsche-classes/poll and renders the result summary", async () => {
    mockFetchWithRefresh.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        result: {
          messages_seen: 12,
          messages_matched: 5,
          artifacts_ingested: 4,
          artifacts_duplicate: 1,
          artifacts_quarantined: 0,
          errors: 0,
          duration_ms: 1234,
        },
      }),
    });
    const onChanged = jest.fn();
    render(<OperatorActions onChanged={onChanged} />);

    fireEvent.click(screen.getByTestId("operator-actions-poll"));
    await waitFor(() => {
      expect(
        screen.getByTestId("operator-actions-poll-result").textContent,
      ).toMatch(/Ingested 4/);
    });

    const [url, init] = mockFetchWithRefresh.mock.calls[0];
    expect(url).toBe("/api/automations/porsche-classes/poll");
    expect((init as RequestInit).method).toBe("POST");
    expect(onChanged).toHaveBeenCalled();
  });

  test("Run inbox poll surfaces a friendly skipped state when the user isn't connected", async () => {
    mockFetchWithRefresh.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        result: { skipped: "no_user_connected" },
      }),
    });
    render(<OperatorActions onChanged={() => {}} />);
    fireEvent.click(screen.getByTestId("operator-actions-poll"));
    await waitFor(() => {
      const txt = screen.getByTestId("operator-actions-poll-result").textContent ?? "";
      expect(txt).toMatch(/Skipped/);
      expect(txt).toMatch(/no_user_connected/);
    });
  });

  test("Run inbox poll surfaces an error message on non-200", async () => {
    mockFetchWithRefresh.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ error: "graph outage" }),
    });
    render(<OperatorActions onChanged={() => {}} />);
    fireEvent.click(screen.getByTestId("operator-actions-poll"));
    await waitFor(() => {
      expect(
        screen.getByTestId("operator-actions-poll-result").textContent,
      ).toMatch(/Poll failed: graph outage/);
    });
  });
});

describe("<OperatorActions /> — backfill upload", () => {
  function fileFromName(name: string, content = "x"): File {
    return new File([content], name, { type: "application/octet-stream" });
  }

  test("uploading a coordinator .eml file POSTs source_type=cognito_coordinator + the file", async () => {
    mockFetchWithRefresh.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        result: { snapshot_id: "snap-123" },
      }),
    });
    const onChanged = jest.fn();
    render(<OperatorActions onChanged={onChanged} />);

    const input = screen.getByTestId("operator-actions-file-input") as HTMLInputElement;
    const f = fileFromName("Coordinator Class Report - Amy Federman.eml");
    await act(async () => {
      Object.defineProperty(input, "files", {
        value: [f],
        configurable: true,
      });
      fireEvent.change(input);
    });

    await waitFor(() => {
      expect(
        screen.getByTestId("operator-actions-file-row-0").getAttribute("data-status"),
      ).toBe("ok");
    });
    const [url, init] = mockFetchWithRefresh.mock.calls[0];
    expect(url).toBe("/api/automations/porsche-classes/manual-ingest");
    expect((init as RequestInit).method).toBe("POST");
    const body = (init as RequestInit).body as FormData;
    expect(body.get("source_type")).toBe("cognito_coordinator");
    expect((body.get("file") as File).name).toBe(
      "Coordinator Class Report - Amy Federman.eml",
    );
    expect(onChanged).toHaveBeenCalled();
  });

  test("uploading multiple files routes each to the right source_type and reports per-row status", async () => {
    mockFetchWithRefresh
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: { snapshot_id: "a" } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: { snapshot_id: "b" } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: { snapshot_id: "c" } }),
      });

    render(<OperatorActions onChanged={() => {}} />);

    const input = screen.getByTestId("operator-actions-file-input") as HTMLInputElement;
    const files = [
      fileFromName("Coordinator Class Report - X.eml"),
      fileFromName("Instructor Class Report - Y.eml"),
      fileFromName("Survey Data PCBA 101 Pendry March 23-27th.xlsx"),
    ];
    await act(async () => {
      Object.defineProperty(input, "files", {
        value: files,
        configurable: true,
      });
      fireEvent.change(input);
    });

    await waitFor(() => {
      expect(
        screen.getByTestId("operator-actions-file-row-2").getAttribute("data-status"),
      ).toBe("ok");
    });

    const sourceTypes = mockFetchWithRefresh.mock.calls.map((c) => {
      const init = c[1] as RequestInit;
      return ((init.body as FormData).get("source_type") as string) ?? null;
    });
    expect(sourceTypes).toEqual([
      "cognito_coordinator",
      "cognito_instructor",
      "survey",
    ]);
  });

  test("a file with an unrecognized name fails with a clear message and does NOT call manual-ingest", async () => {
    render(<OperatorActions onChanged={() => {}} />);

    const input = screen.getByTestId("operator-actions-file-input") as HTMLInputElement;
    await act(async () => {
      Object.defineProperty(input, "files", {
        value: [fileFromName("random.txt")],
        configurable: true,
      });
      fireEvent.change(input);
    });
    await waitFor(() => {
      expect(
        screen.getByTestId("operator-actions-file-row-0").getAttribute("data-status"),
      ).toBe("error");
    });
    // Manual-ingest should not have been hit at all.
    expect(mockFetchWithRefresh).not.toHaveBeenCalled();
    expect(
      screen.getByTestId("operator-actions-file-row-0").textContent,
    ).toMatch(/could not detect source_type/);
  });

  test("a server 400 on manual-ingest renders the error message inline against the row", async () => {
    mockFetchWithRefresh.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ error: "uploaded file is empty" }),
    });
    render(<OperatorActions onChanged={() => {}} />);

    const input = screen.getByTestId("operator-actions-file-input") as HTMLInputElement;
    await act(async () => {
      Object.defineProperty(input, "files", {
        value: [fileFromName("Coordinator Class Report - Z.eml")],
        configurable: true,
      });
      fireEvent.change(input);
    });
    await waitFor(() => {
      expect(
        screen.getByTestId("operator-actions-file-row-0").getAttribute("data-status"),
      ).toBe("error");
    });
    expect(
      screen.getByTestId("operator-actions-file-row-0").textContent,
    ).toMatch(/uploaded file is empty/);
  });
});
