/** @jest-environment jsdom */
/* eslint-disable @typescript-eslint/no-explicit-any */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";

const mockFetchWithRefresh: jest.Mock = jest.fn(() =>
  Promise.resolve({ ok: true } as Response),
);
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: any[]) => mockFetchWithRefresh(...a),
}));

import {
  describeSystemEvent,
  describeAttachment,
  isAttachmentOnly,
  shouldRenderAsPill,
  SystemEventPill,
  AttachmentSummaryPill,
  type RenderableMessage,
} from "@/lib/messages/system-event-renderer";

describe("describeSystemEvent", () => {
  test("call started + ended → call icon", () => {
    expect(describeSystemEvent({ subtype: "callStarted" })).toMatchObject({
      icon: "📞",
      text: "Call started",
    });
    expect(describeSystemEvent({ subtype: "callEnded" })).toMatchObject({
      icon: "📞",
      text: "Call ended",
    });
  });

  test("members added with names → 'Ashley joined the chat'", () => {
    expect(
      describeSystemEvent({ subtype: "membersAdded", memberNames: ["Ashley"] }),
    ).toMatchObject({ icon: "👤", text: "Ashley joined the chat" });
  });

  test("members deleted with names → 'Ashley and Bob left the chat'", () => {
    expect(
      describeSystemEvent({
        subtype: "membersDeleted",
        memberNames: ["Ashley", "Bob"],
      }),
    ).toMatchObject({ text: "Ashley and Bob left the chat" });
  });

  test("topic updated with newTopic → quoted text", () => {
    expect(
      describeSystemEvent({ subtype: "topicUpdated", newTopic: "Launch plan" }),
    ).toMatchObject({ icon: "✏️", text: 'Topic updated to "Launch plan"' });
  });

  test("meeting + history events have plain-language copy", () => {
    expect(describeSystemEvent({ subtype: "meetingEnded" }).text).toBe(
      "Meeting ended",
    );
    expect(describeSystemEvent({ subtype: "historyDisclosed" }).text).toMatch(
      /history/i,
    );
  });

  test("unknown subtype falls back to generic 'System event'", () => {
    expect(describeSystemEvent({ subtype: "somethingNew" }).text).toBe(
      "System event",
    );
    expect(describeSystemEvent(undefined).text).toBe("System event");
  });
});

describe("describeAttachment", () => {
  test("file reference → paperclip + name", () => {
    expect(
      describeAttachment({
        contentType: "reference",
        name: "budget.xlsx",
      }),
    ).toMatchObject({ icon: "📎", text: "budget.xlsx", kind: "fileReference" });
  });

  test("adaptive card", () => {
    expect(
      describeAttachment({
        contentType: "application/vnd.microsoft.card.adaptive",
        name: "",
      }),
    ).toMatchObject({ icon: "🧩", text: "Adaptive card", kind: "adaptiveCard" });
  });

  test("meeting reference card", () => {
    expect(
      describeAttachment({
        contentType: "meetingReference",
        name: "",
      }),
    ).toMatchObject({ icon: "📅", kind: "meetingCard" });
  });

  test("code snippet", () => {
    expect(
      describeAttachment({
        contentType: "application/vnd.microsoft.card.codesnippet",
        name: "",
      }),
    ).toMatchObject({ icon: "💻", kind: "codeSnippet" });
  });

  test("messageReference (quoted reply)", () => {
    expect(
      describeAttachment({ contentType: "messageReference", name: "" }),
    ).toMatchObject({ kind: "messageReference" });
  });

  test("unknown contentType falls back to paperclip + 'Attachment'", () => {
    expect(
      describeAttachment({ contentType: "novel/format", name: "" }),
    ).toMatchObject({ icon: "📎", text: "Attachment" });
  });
});

describe("isAttachmentOnly + shouldRenderAsPill", () => {
  const empty: RenderableMessage = {
    id: "m-empty",
    body: { content: "", contentType: "text" },
    bodyText: "",
    attachments: [{ contentType: "reference", name: "x.pdf" }],
  };
  const text: RenderableMessage = {
    id: "m-text",
    body: { content: "hi", contentType: "text" },
    bodyText: "hi",
    attachments: [{ contentType: "reference", name: "x.pdf" }],
  };
  const sysEvent: RenderableMessage = {
    id: "m-sys",
    messageType: "systemEventMessage",
    bodyText: "",
    eventDetail: { subtype: "callEnded" },
  };

  test("isAttachmentOnly: empty body + attachments → true", () => {
    expect(isAttachmentOnly(empty)).toBe(true);
    expect(isAttachmentOnly(text)).toBe(false);
  });

  test("shouldRenderAsPill: systemEventMessage → true regardless of body", () => {
    expect(shouldRenderAsPill(sysEvent)).toBe(true);
  });

  test("shouldRenderAsPill: attachment-only message → true", () => {
    expect(shouldRenderAsPill(empty)).toBe(true);
  });

  test("shouldRenderAsPill: text-with-attachment → false (let normal bubble render)", () => {
    expect(shouldRenderAsPill(text)).toBe(false);
  });
});

describe("SystemEventPill rendering", () => {
  beforeEach(() => mockFetchWithRefresh.mockClear());

  test("renders plain-language pill for callEnded with timestamp", () => {
    const m: RenderableMessage = {
      id: "ev-1",
      messageType: "systemEventMessage",
      eventDetail: { subtype: "callEnded" },
    };
    render(<SystemEventPill message={m} relativeTime="15h" />);
    const pill = screen.getByTestId("system-event-ev-1");
    expect(pill).toBeInTheDocument();
    expect(pill).toHaveAttribute("data-subtype", "callEnded");
    expect(pill.textContent).toMatch(/Call ended/);
    expect(pill.textContent).toMatch(/15h/);
  });

  test("renders generic pill for unknown subtype (never empty)", () => {
    const m: RenderableMessage = {
      id: "ev-2",
      messageType: "systemEventMessage",
      eventDetail: { subtype: "novelEvent" },
    };
    render(<SystemEventPill message={m} relativeTime="2d" />);
    const pill = screen.getByTestId("system-event-ev-2");
    expect(pill.textContent).toMatch(/System event/);
    expect(pill).toHaveAttribute("data-subtype", "novelEvent");
  });

  test("fires messages.system_event_rendered analytics on mount", () => {
    const m: RenderableMessage = {
      id: "ev-3",
      messageType: "systemEventMessage",
      eventDetail: { subtype: "membersAdded", memberNames: ["Ashley"] },
    };
    render(<SystemEventPill message={m} relativeTime="1h" />);
    expect(mockFetchWithRefresh).toHaveBeenCalledWith(
      "/api/analytics",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining("messages.system_event_rendered"),
      }),
    );
    const body = JSON.parse((mockFetchWithRefresh.mock.calls[0] as any[])[1].body);
    expect(body.metadata.subtype).toBe("membersAdded");
  });
});

describe("AttachmentSummaryPill rendering", () => {
  beforeEach(() => mockFetchWithRefresh.mockClear());

  test("renders attachment kind + name + sender", () => {
    const m: RenderableMessage = {
      id: "att-1",
      from: { displayName: "Ashley" },
      bodyText: "",
      attachments: [{ contentType: "reference", name: "budget.xlsx" }],
    };
    render(<AttachmentSummaryPill message={m} relativeTime="3h" />);
    const pill = screen.getByTestId("attachment-summary-att-1");
    expect(pill).toBeInTheDocument();
    expect(pill).toHaveAttribute("data-attachment-kind", "fileReference");
    expect(pill.textContent).toMatch(/Ashley/);
    expect(pill.textContent).toMatch(/budget\.xlsx/);
    expect(pill.textContent).toMatch(/3h/);
  });

  test("shows '+N more' when multiple attachments", () => {
    const m: RenderableMessage = {
      id: "att-2",
      from: { displayName: "Bob" },
      bodyText: "",
      attachments: [
        { contentType: "reference", name: "a.pdf" },
        { contentType: "reference", name: "b.pdf" },
        { contentType: "reference", name: "c.pdf" },
      ],
    };
    render(<AttachmentSummaryPill message={m} relativeTime="1d" />);
    expect(screen.getByTestId("attachment-summary-att-2").textContent).toMatch(
      /\(\+2 more\)/,
    );
  });

  test("fires messages.attachment_summary_rendered analytics on mount", () => {
    const m: RenderableMessage = {
      id: "att-3",
      attachments: [
        { contentType: "application/vnd.microsoft.card.adaptive", name: "" },
      ],
    };
    render(<AttachmentSummaryPill message={m} relativeTime="5m" />);
    expect(mockFetchWithRefresh).toHaveBeenCalled();
    const body = JSON.parse((mockFetchWithRefresh.mock.calls[0] as any[])[1].body);
    expect(body.event).toBe("messages.attachment_summary_rendered");
    expect(body.metadata.attachment_kind).toBe("adaptiveCard");
  });
});
