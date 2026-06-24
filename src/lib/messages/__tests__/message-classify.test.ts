/**
 * Pure message classification - the shared source of truth for "is this a real
 * typed human message" used by both the timeline renderer and the unread-count
 * notification path. The notification-worthy predicate is the meeting-invite
 * fix: a meeting invite / system event / attachment card must never be counted
 * as a new message.
 */

import {
  isAttachmentOnly,
  shouldRenderAsPill,
  isNoiseMessage,
  isNotificationWorthy,
  type RenderableMessage,
} from "@/lib/messages/message-classify";

const text = (s: string): RenderableMessage => ({
  bodyText: s,
  body: { content: s, contentType: "text" },
});

describe("isNotificationWorthy", () => {
  it("counts a genuine typed human message", () => {
    expect(isNotificationWorthy(text("hey, are we still on for 3pm?"))).toBe(true);
    // messageType absent (older Graph payloads) is treated as a normal message.
    expect(isNotificationWorthy({ ...text("ping"), messageType: undefined })).toBe(true);
    expect(isNotificationWorthy({ ...text("ping"), messageType: "message" })).toBe(true);
  });

  it("does NOT count a meeting invite / system event carrying eventDetail", () => {
    // The exact bug: a meeting invite with a non-empty body still has
    // eventDetail, so it must not flash the badge.
    const meetingInvite: RenderableMessage = {
      ...text("Next Steps: A Weekend with Porsche"),
      messageType: "message",
      eventDetail: { subtype: "meetingStarted" },
    };
    expect(isNotificationWorthy(meetingInvite)).toBe(false);
  });

  it("does NOT count a systemEventMessage even with body text", () => {
    expect(
      isNotificationWorthy({ ...text("Call ended"), messageType: "systemEventMessage" }),
    ).toBe(false);
  });

  it("does NOT count non-message Graph types (chatEvent / typing / unknownFutureValue)", () => {
    for (const t of ["chatEvent", "typing", "unknownFutureValue"]) {
      expect(isNotificationWorthy({ ...text("x"), messageType: t })).toBe(false);
    }
  });

  it("does NOT count an attachment-only card (meeting card / file share)", () => {
    const card: RenderableMessage = {
      body: { content: "", contentType: "html" },
      bodyText: "",
      attachments: [{ contentType: "application/vnd.microsoft.card.meeting", name: "Meeting" }],
    };
    expect(isAttachmentOnly(card)).toBe(true);
    expect(isNotificationWorthy(card)).toBe(false);
  });

  it("does NOT count a deleted message", () => {
    expect(
      isNotificationWorthy({ ...text("was here"), deletedDateTime: "2026-06-19T10:00:00Z" }),
    ).toBe(false);
  });

  it("does NOT count an empty / noise bubble", () => {
    expect(isNoiseMessage({ body: { content: "<div></div>", contentType: "html" }, bodyText: "" })).toBe(
      true,
    );
    expect(isNotificationWorthy({ body: { content: "", contentType: "text" }, bodyText: "" })).toBe(
      false,
    );
  });
});

describe("shouldRenderAsPill / isAttachmentOnly (re-exported, unchanged semantics)", () => {
  it("system events and attachment-only render as pills", () => {
    expect(shouldRenderAsPill({ messageType: "systemEventMessage", bodyText: "" })).toBe(true);
    expect(
      shouldRenderAsPill({
        bodyText: "",
        body: { content: "", contentType: "text" },
        attachments: [{ contentType: "reference", name: "budget.xlsx" }],
      }),
    ).toBe(true);
  });

  it("a normal text message is neither a pill nor noise", () => {
    expect(shouldRenderAsPill(text("hello"))).toBe(false);
    expect(isNoiseMessage(text("hello"))).toBe(false);
  });
});
