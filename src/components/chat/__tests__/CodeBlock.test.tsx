/**
 * @jest-environment jsdom
 *
 * Tests for the assistant CodeBlock component — header label, copy
 * button behavior, "Copied" feedback, analytics POST, and timing
 * revert.
 */

import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CodeBlock } from "@/components/chat/CodeBlock";

// `fetchWithRefresh` is the canonical authenticated fetch wrapper the
// rest of the chat surface uses (see InstinctChat.tsx). We mock it at
// the module boundary so the test exercises the same call path
// production hits, without needing a real `/api/analytics` endpoint.
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: jest.fn(() => Promise.resolve({ ok: true })),
  jsonHeaders: () => ({ "Content-Type": "application/json" }),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const clientAuth = require("@/lib/client-auth") as {
  fetchWithRefresh: jest.Mock;
};

describe("CodeBlock — rendering", () => {
  beforeEach(() => {
    clientAuth.fetchWithRefresh.mockClear();
  });

  it("renders the language label lowercased", () => {
    render(<CodeBlock code="x = 1" language="Python" />);
    expect(screen.getByTestId("assistant-code-language").textContent).toBe(
      "python",
    );
  });

  it("defaults to 'code' when no language is provided", () => {
    render(<CodeBlock code="hello" />);
    expect(screen.getByTestId("assistant-code-language").textContent).toBe(
      "code",
    );
  });

  it("defaults to 'code' when language is an empty string", () => {
    render(<CodeBlock code="hello" language="" />);
    expect(screen.getByTestId("assistant-code-language").textContent).toBe(
      "code",
    );
  });

  it("renders the code body verbatim — including special markdown chars", () => {
    const raw = "const a = '[link](/x)'; // **not bold**";
    render(<CodeBlock code={raw} language="ts" />);
    const body = screen.getByTestId("assistant-code-body");
    expect(body.textContent).toBe(raw);
    // No <strong>/<a> emitted inside the block.
    expect(body.querySelector("strong")).toBeNull();
    expect(body.querySelector("a")).toBeNull();
  });

  it("renders an accessible Copy button", () => {
    render(<CodeBlock code="x" language="ts" />);
    const btn = screen.getByTestId("assistant-code-copy");
    expect(btn.tagName).toBe("BUTTON");
    expect(btn).toHaveAttribute("aria-label", "Copy code");
    expect(btn.textContent).toBe("Copy");
  });
});

describe("CodeBlock — copy interaction", () => {
  let writeTextMock: jest.Mock;

  beforeEach(() => {
    clientAuth.fetchWithRefresh.mockClear();
    writeTextMock = jest.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: writeTextMock },
      configurable: true,
    });
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("clicking Copy writes to the clipboard with the code text", async () => {
    render(<CodeBlock code="echo hi" language="bash" />);
    fireEvent.click(screen.getByTestId("assistant-code-copy"));
    await waitFor(() => {
      expect(writeTextMock).toHaveBeenCalledWith("echo hi");
    });
  });

  it("clicking Copy fires analytics with language + code_length", async () => {
    render(<CodeBlock code="echo hi" language="bash" />);
    fireEvent.click(screen.getByTestId("assistant-code-copy"));
    await waitFor(() => {
      expect(clientAuth.fetchWithRefresh).toHaveBeenCalledTimes(1);
    });
    const [url, init] = clientAuth.fetchWithRefresh.mock.calls[0];
    expect(url).toBe("/api/analytics");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    expect(body.event).toBe("assistant.code_copied");
    expect(body.metadata.language).toBe("bash");
    expect(body.metadata.code_length).toBe("echo hi".length);
  });

  it("clicking Copy shows 'Copied' and reverts to 'Copy' after 1500ms", async () => {
    render(<CodeBlock code="x" language="ts" />);
    const btn = screen.getByTestId("assistant-code-copy");
    expect(btn.textContent).toBe("Copy");
    fireEvent.click(btn);
    await waitFor(() => {
      expect(screen.getByTestId("assistant-code-copy").textContent).toBe(
        "Copied",
      );
    });
    // Before the timer elapses — still Copied.
    act(() => {
      jest.advanceTimersByTime(1499);
    });
    expect(screen.getByTestId("assistant-code-copy").textContent).toBe(
      "Copied",
    );
    // After 1500ms total — reverts.
    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(screen.getByTestId("assistant-code-copy").textContent).toBe("Copy");
  });

  it("survives navigator.clipboard being undefined without throwing", async () => {
    // Some test/runtime environments don't expose the clipboard API.
    // We still want the visual "Copied" feedback to fire and analytics
    // to still log the intent.
    Object.defineProperty(navigator, "clipboard", {
      value: undefined,
      configurable: true,
    });
    render(<CodeBlock code="x" language="ts" />);
    fireEvent.click(screen.getByTestId("assistant-code-copy"));
    await waitFor(() => {
      expect(screen.getByTestId("assistant-code-copy").textContent).toBe(
        "Copied",
      );
    });
    expect(clientAuth.fetchWithRefresh).toHaveBeenCalledTimes(1);
  });
});
