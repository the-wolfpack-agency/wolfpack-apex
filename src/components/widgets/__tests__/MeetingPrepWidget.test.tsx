/**
 * @jest-environment jsdom
 *
 * MeetingPrepWidget — render, source-click analytics, regen role-gating.
 */

import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";

const mockFetch = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: unknown[]) => mockFetch(...a),
  jsonHeaders: () => ({ "Content-Type": "application/json" }),
}));

import { MeetingPrepWidget } from "@/components/widgets/MeetingPrepWidget";
import type { MeetingPrepWidgetSpec } from "@/lib/assistant/widgets/types";

const SPEC: MeetingPrepWidgetSpec = {
  kind: "meeting_prep",
  meetingId: "evt-1",
  subject: "Acme sync",
  start: "2026-05-20T15:00:00Z",
  cacheStatus: "miss",
  generatedAt: "2026-05-19T00:00:00Z",
  synthesisUnavailable: false,
  summary: "Quick alignment with Alice on Q3.",
  goal: "Confirm priorities",
  talking_points: [
    {
      point: "Q3 OKR confirmation",
      source_refs: [
        { type: "brain", id: "k-1", label: "OKR doc", url: "https://e/k-1" },
      ],
    },
  ],
  risk_flags: [
    {
      flag: "Deal is stalled",
      severity: "high",
      source_refs: [{ type: "crm", id: "opp-1", label: "Opp", url: "https://e/opp-1" }],
    },
  ],
  attendee_briefs: [
    {
      email: "alice@acme.example",
      name: "Alice Doe",
      one_liner: "VP Ops at Acme",
      key_facts: ["Hired 2024"],
      links: [],
    },
  ],
  open_questions: ["What's the launch date?"],
  viewerCanRegenerate: true,
};

beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
});

describe("MeetingPrepWidget", () => {
  test("renders subject + summary + goal + talking points + risk severity + open questions", () => {
    render(<MeetingPrepWidget spec={SPEC} />);
    expect(screen.getByTestId("meeting-prep-widget")).toBeInTheDocument();
    expect(screen.getByText("Acme sync")).toBeInTheDocument();
    expect(screen.getByText(SPEC.summary)).toBeInTheDocument();
    expect(screen.getByText(SPEC.goal)).toBeInTheDocument();
    expect(screen.getByText("Q3 OKR confirmation")).toBeInTheDocument();
    expect(screen.getByTestId("meeting-prep-risk-severity-0")).toHaveTextContent(/high/i);
    expect(screen.getByText("Deal is stalled")).toBeInTheDocument();
    expect(screen.getByText("Alice Doe")).toBeInTheDocument();
    expect(screen.getByText("Hired 2024")).toBeInTheDocument();
    expect(screen.getByText("What's the launch date?")).toBeInTheDocument();
  });

  test("cache pill text reflects cache status", () => {
    const { rerender } = render(<MeetingPrepWidget spec={SPEC} />);
    expect(screen.getByTestId("meeting-prep-cache-pill")).toHaveTextContent(/fresh/i);
    rerender(
      <MeetingPrepWidget spec={{ ...SPEC, cacheStatus: "hit" }} />,
    );
    expect(screen.getByTestId("meeting-prep-cache-pill")).toHaveTextContent(/shared/i);
  });

  test("source ref click emits assistant.meeting_prep_source_clicked", () => {
    render(<MeetingPrepWidget spec={SPEC} />);
    const chip = screen.getByTestId("meeting-prep-source-brain-k-1");
    fireEvent.click(chip);
    const calls = mockFetch.mock.calls.map((c: unknown[]) => {
      const body = JSON.parse(((c[1] as { body: string }) ?? { body: "{}" }).body);
      return body;
    });
    const sourceClickedCall = calls.find(
      (b) => b.event === "assistant.meeting_prep_source_clicked",
    );
    expect(sourceClickedCall).toBeDefined();
    expect(sourceClickedCall.metadata.ref_type).toBe("brain");
    expect(sourceClickedCall.metadata.meeting_id).toBe("evt-1");
  });

  test("widget_rendered fires on mount with widget_kind=meeting_prep", () => {
    render(<MeetingPrepWidget spec={SPEC} />);
    const renderedCall = mockFetch.mock.calls.find((c: unknown[]) => {
      const body = JSON.parse(((c[1] as { body: string }) ?? { body: "{}" }).body);
      return body.event === "assistant.widget_rendered";
    });
    expect(renderedCall).toBeDefined();
    const body = JSON.parse((renderedCall![1] as { body: string }).body);
    expect(body.metadata.widget_kind).toBe("meeting_prep");
  });

  test("regenerate button hidden when viewerCanRegenerate=false", () => {
    render(
      <MeetingPrepWidget spec={{ ...SPEC, viewerCanRegenerate: false }} />,
    );
    expect(screen.queryByTestId("meeting-prep-regenerate")).toBeNull();
  });

  test("regenerate button visible + clicking calls the API route with force=1", () => {
    render(<MeetingPrepWidget spec={SPEC} />);
    const btn = screen.getByTestId("meeting-prep-regenerate");
    expect(btn).toBeInTheDocument();
    fireEvent.click(btn);
    const apiCall = mockFetch.mock.calls.find((c: unknown[]) =>
      String(c[0]).includes("/api/insights/meeting-prep"),
    );
    expect(apiCall).toBeDefined();
    expect(String(apiCall![0])).toMatch(/force=1/);
  });

  test("synthesis_unavailable renders the empty banner", () => {
    render(
      <MeetingPrepWidget
        spec={{ ...SPEC, synthesisUnavailable: true, summary: "", goal: "" }}
      />,
    );
    expect(screen.getByTestId("meeting-prep-unavailable")).toBeInTheDocument();
  });
});
