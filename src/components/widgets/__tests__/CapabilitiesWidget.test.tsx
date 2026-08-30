/** @jest-environment jsdom */

/**
 * The first screen somebody sees has to be actionable, not exhaustive.
 *
 * WHAT THIS REPLACED. "What can you do" answered with a wall of markdown:
 * three headings, sixty-odd bullets, a closing paragraph. Every line accurate
 * and nothing findable. A person reading it does not want the catalogue, they
 * want one thing to try, and the catalogue was all they got.
 *
 * So the widget leads with sentences they can send, keeps whole jobs next, and
 * collapses the catalogue behind the group it belongs to. Clicking a starter
 * fills the composer rather than sending it, matching the fallback chips this
 * product already uses: somebody almost always wants to change a word, and
 * sending on their behalf takes that away.
 */

import "@testing-library/jest-dom";

const mockFetchWithRefresh = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: unknown[]) => mockFetchWithRefresh(...a),
  jsonHeaders: () => ({ "Content-Type": "application/json" }),
}));

import { render, screen, fireEvent } from "@testing-library/react";
import React from "react";
import CapabilitiesWidget from "@/components/widgets/CapabilitiesWidget";
import type { CapabilitiesWidgetSpec } from "@/lib/assistant/widgets/types";

const spec: CapabilitiesWidgetSpec = {
  kind: "capabilities",
  routines: [{ command: "run my morning", description: "Your calendar, tasks and a brief." }],
  groups: [
    { title: "Mail and people", items: ["Search your mailbox", "Identify a person by name"] },
    { title: "Money", items: ["Look up a financial metric"] },
  ],
  starters: [
    { prompt: "what came in overnight", because: "Recent mail, without opening the mail client." },
    { prompt: "what is waiting on me", because: "Your open items, oldest first." },
  ],
  fallbackInvitation: "If none of that matches your job, describe your day instead.",
};

beforeEach(() => {
  jest.clearAllMocks();
  mockFetchWithRefresh.mockResolvedValue({ ok: true, json: async () => ({}) });
});

describe("what a person sees first", () => {
  it("leads with something they can send", () => {
    render(<CapabilitiesWidget spec={spec} />);
    const starters = screen.getAllByTestId("capabilities-starter");
    expect(starters).toHaveLength(2);
    expect(starters[0].textContent).toContain("what came in overnight");
  });

  /* THE CATALOGUE IS REFERENCE, NOT THE OPENING. It must be present, because
     "can it do X" is a real question, and it must not be the first thing. */
  it("keeps the catalogue collapsed until asked for", () => {
    render(<CapabilitiesWidget spec={spec} />);
    expect(screen.queryByTestId("capabilities-group-items")).not.toBeInTheDocument();
    expect(screen.getAllByTestId("capabilities-group-toggle")).toHaveLength(2);
  });

  it("opens one group without opening the rest", () => {
    render(<CapabilitiesWidget spec={spec} />);
    fireEvent.click(screen.getAllByTestId("capabilities-group-toggle")[0]);
    const items = screen.getByTestId("capabilities-group-items");
    expect(items.textContent).toContain("Search your mailbox");
    expect(items.textContent).not.toContain("Look up a financial metric");
  });

  it("says how many things are in a group before it is opened", () => {
    render(<CapabilitiesWidget spec={spec} />);
    expect(screen.getAllByTestId("capabilities-group-toggle")[0].textContent).toContain("2");
  });
});

describe("clicking a starter", () => {
  /* FILLS, DOES NOT SEND. Asserted because sending would be the easier build
     and the worse product: it takes away the edit somebody almost always
     wants to make. */
  it("hands the sentence to the composer rather than sending it", () => {
    const onPickPrompt = jest.fn();
    render(<CapabilitiesWidget spec={spec} onPickPrompt={onPickPrompt} />);
    fireEvent.click(screen.getAllByTestId("capabilities-starter")[0]);
    expect(onPickPrompt).toHaveBeenCalledWith("what came in overnight");
  });

  it("works when no composer is wired, rather than throwing", () => {
    render(<CapabilitiesWidget spec={spec} />);
    expect(() => fireEvent.click(screen.getAllByTestId("capabilities-starter")[0])).not.toThrow();
  });

  it("hands a routine command over the same way", () => {
    const onPickPrompt = jest.fn();
    render(<CapabilitiesWidget spec={spec} onPickPrompt={onPickPrompt} />);
    fireEvent.click(screen.getByTestId("capabilities-routine"));
    expect(onPickPrompt).toHaveBeenCalledWith("run my morning");
  });
});

describe("analytics", () => {
  it("records that it rendered, with what it offered", () => {
    render(<CapabilitiesWidget spec={spec} />);
    const call = mockFetchWithRefresh.mock.calls.find((c) =>
      String(c[1]?.body ?? "").includes("widget_rendered"),
    );
    expect(call).toBeTruthy();
    const body = JSON.parse(String(call![1].body));
    expect(body.metadata.widget_kind).toBe("capabilities");
    expect(body.metadata.starter_count).toBe(2);
  });

  it("records which starter was picked, because that is the demand signal", () => {
    render(<CapabilitiesWidget spec={spec} onPickPrompt={jest.fn()} />);
    fireEvent.click(screen.getAllByTestId("capabilities-starter")[1]);
    const call = mockFetchWithRefresh.mock.calls.find((c) =>
      String(c[1]?.body ?? "").includes("starter_picked"),
    );
    expect(JSON.parse(String(call![1].body)).metadata.value).toBe("what is waiting on me");
  });
});

describe("degrading rather than breaking", () => {
  it("renders when a role has no routines and no starters", () => {
    render(
      <CapabilitiesWidget
        spec={{ ...spec, routines: [], starters: [], groups: [] }}
      />,
    );
    expect(screen.getByTestId("capabilities-widget").textContent).toContain("describe your day");
  });
});
