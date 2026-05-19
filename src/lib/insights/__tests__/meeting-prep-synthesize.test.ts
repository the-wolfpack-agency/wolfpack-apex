/**
 * meeting-prep-synthesize — single LLM call, JSON parsing, fail-soft on
 * invalid JSON. Mocks the AI client so the test never hits a provider.
 */

const mockComplete = jest.fn();

jest.mock("@/lib/ai", () => ({
  getAIClient: () => ({ complete: (...a: unknown[]) => mockComplete(...a) }),
}));

import { synthesizePrep } from "@/lib/insights/meeting-prep-synthesize";
import type { MeetingSources } from "@/lib/insights/meeting-prep-sources";

const SOURCES: MeetingSources = {
  event: {
    id: "evt-1",
    subject: "Acme sync",
    start: "2026-05-20T15:00:00Z",
    end: "2026-05-20T15:30:00Z",
    attendees: ["Alice"],
    attendeeEmails: ["alice@acme.example"],
    body_preview: "",
  },
  perAttendee: [
    {
      email: "alice@acme.example",
      name: "Alice Doe",
      crm: null,
      recentEmails: [],
      brainFacts: [],
    },
  ],
  versionMarkers: {
    crmLastModified: {},
    lastEmailReceivedAt: {},
    lastBrainEditAt: "",
  },
};

beforeEach(() => {
  mockComplete.mockReset();
});

describe("synthesizePrep", () => {
  test("makes exactly ONE LLM call and parses valid JSON", async () => {
    mockComplete.mockResolvedValue({
      content: JSON.stringify({
        summary: "Quick alignment with Alice on Q3.",
        goal: "Confirm priorities",
        talking_points: [
          {
            point: "Q3 OKR confirmation",
            source_refs: [
              {
                type: "brain",
                id: "k-1",
                label: "Acme OKR doc",
                url: "https://example/k-1",
              },
            ],
          },
        ],
        risk_flags: [],
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
      }),
      model_used: "claude-haiku-4-5",
      provider_used: "anthropic",
      input_tokens: 800,
      output_tokens: 200,
      cost_usd: 0.001,
      latency_ms: 320,
    });

    const res = await synthesizePrep(SOURCES, { userId: "u1", userRole: "cto" });
    expect(mockComplete).toHaveBeenCalledTimes(1);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.prep.summary).toMatch(/Alice/);
    expect(res.prep.talking_points[0].source_refs[0].id).toBe("k-1");
    expect(res.prep.attendee_briefs[0].email).toBe("alice@acme.example");
    expect(res.latencyMs).toBe(320);
  });

  test("uses cheap tier (Haiku-class) — not premium", async () => {
    mockComplete.mockResolvedValue({
      content: "{}",
      model_used: "x",
      provider_used: "x",
      input_tokens: 0,
      output_tokens: 0,
      cost_usd: 0,
      latency_ms: 1,
    });
    await synthesizePrep(SOURCES, { userId: "u1" });
    expect(mockComplete).toHaveBeenCalledWith(
      expect.objectContaining({ model_tier: "cheap" }),
    );
  });

  test("invalid JSON returns SynthesisError with code invalid_json", async () => {
    mockComplete.mockResolvedValue({
      content: "this is not json at all",
      model_used: "x",
      provider_used: "x",
      input_tokens: 1,
      output_tokens: 1,
      cost_usd: 0,
      latency_ms: 1,
    });
    const res = await synthesizePrep(SOURCES, { userId: "u1" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("invalid_json");
  });

  test("strips ```json fence before parsing", async () => {
    mockComplete.mockResolvedValue({
      content:
        "```json\n" +
        JSON.stringify({
          summary: "ok",
          goal: "ok",
          talking_points: [],
          risk_flags: [],
          attendee_briefs: [],
          open_questions: [],
        }) +
        "\n```",
      model_used: "x",
      provider_used: "x",
      input_tokens: 1,
      output_tokens: 1,
      cost_usd: 0,
      latency_ms: 1,
    });
    const res = await synthesizePrep(SOURCES, { userId: "u1" });
    expect(res.ok).toBe(true);
  });

  test("provider error returns SynthesisError, never throws", async () => {
    mockComplete.mockRejectedValue(new Error("boom"));
    const res = await synthesizePrep(SOURCES, { userId: "u1" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("provider_error");
    expect(res.message).toMatch(/boom/);
  });

  test("empty response → empty_response error", async () => {
    mockComplete.mockResolvedValue({
      content: "",
      model_used: "x",
      provider_used: "x",
      input_tokens: 0,
      output_tokens: 0,
      cost_usd: 0,
      latency_ms: 1,
    });
    const res = await synthesizePrep(SOURCES, { userId: "u1" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("empty_response");
  });

  test("severity outside the allowlist falls back to 'low'", async () => {
    mockComplete.mockResolvedValue({
      content: JSON.stringify({
        summary: "x",
        goal: "x",
        talking_points: [],
        risk_flags: [{ flag: "test", severity: "URGENT", source_refs: [] }],
        attendee_briefs: [],
        open_questions: [],
      }),
      model_used: "x",
      provider_used: "x",
      input_tokens: 1,
      output_tokens: 1,
      cost_usd: 0,
      latency_ms: 1,
    });
    const res = await synthesizePrep(SOURCES, { userId: "u1" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.prep.risk_flags[0].severity).toBe("low");
  });
});
