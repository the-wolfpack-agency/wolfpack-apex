/**
 * Router unit tests — pure-function routing of inbound emails to a
 * meeting-insights feed.
 */

import { routeMessageToFeed, type RoutableMessage } from "../router";
import type { MeetingFeed } from "../types";

function feed(over: Partial<MeetingFeed>): MeetingFeed {
  return {
    id: "f-default",
    slug: "default",
    name: "Default",
    description: null,
    filters: { sender_match: [], subject_match: [] },
    is_enabled: true,
    created_by: "x",
    created_at: "2026-04-01T00:00:00Z",
    updated_at: "2026-04-01T00:00:00Z",
    ...over,
  };
}

function msg(over: Partial<RoutableMessage> = {}): RoutableMessage {
  return {
    source_message_id: "m1",
    subject: "Weekly Stand-up",
    from_address: "bot@example.com",
    received_at: "2026-04-20T12:00:00Z",
    ...over,
  };
}

describe("routeMessageToFeed", () => {
  it("returns null when there are no feeds", () => {
    expect(routeMessageToFeed(msg(), [])).toBeNull();
  });

  it("matches a feed when sender substring matches", () => {
    const feeds = [
      feed({
        id: "f1",
        slug: "porsche",
        filters: { sender_match: ["@porsche.de"], subject_match: [] },
      }),
    ];
    const hit = routeMessageToFeed(msg({ from_address: "noreply@porsche.de" }), feeds);
    expect(hit?.feed_slug).toBe("porsche");
  });

  it("matches a feed when subject substring matches case-insensitively", () => {
    const feeds = [
      feed({
        id: "f1",
        slug: "weekly",
        filters: { sender_match: [], subject_match: ["stand-up"] },
      }),
    ];
    const hit = routeMessageToFeed(msg({ subject: "WEEKLY Stand-Up" }), feeds);
    expect(hit?.feed_slug).toBe("weekly");
  });

  it("returns null when no filters match", () => {
    const feeds = [
      feed({
        id: "f1",
        slug: "vendor",
        filters: { sender_match: ["@vendor.com"], subject_match: [] },
      }),
    ];
    expect(routeMessageToFeed(msg({ from_address: "x@partner.org" }), feeds)).toBeNull();
  });

  it("first-match-wins by created_at ascending", () => {
    const feeds = [
      feed({
        id: "f-late",
        slug: "late",
        filters: { sender_match: [], subject_match: [] },
        created_at: "2026-04-20T00:00:00Z",
      }),
      feed({
        id: "f-early",
        slug: "early",
        filters: { sender_match: ["bot@"], subject_match: [] },
        created_at: "2026-04-01T00:00:00Z",
      }),
    ];
    const hit = routeMessageToFeed(msg({ from_address: "bot@example.com" }), feeds);
    expect(hit?.feed_slug).toBe("early");
  });

  it("skips disabled feeds even when filters would match", () => {
    const feeds = [
      feed({
        id: "f-off",
        slug: "off",
        is_enabled: false,
        filters: { sender_match: ["bot@"], subject_match: [] },
      }),
      feed({
        id: "f-on",
        slug: "on",
        is_enabled: true,
        filters: { sender_match: ["bot@"], subject_match: [] },
        created_at: "2026-04-02T00:00:00Z",
      }),
    ];
    const hit = routeMessageToFeed(msg({ from_address: "bot@example.com" }), feeds);
    expect(hit?.feed_slug).toBe("on");
  });

  it("respects since: only matches messages received on/after", () => {
    const feeds = [
      feed({
        id: "f1",
        slug: "since",
        filters: { sender_match: [], subject_match: [], since: "2026-04-15T00:00:00Z" },
      }),
    ];
    expect(routeMessageToFeed(msg({ received_at: "2026-04-10T00:00:00Z" }), feeds)).toBeNull();
    expect(routeMessageToFeed(msg({ received_at: "2026-04-20T00:00:00Z" }), feeds)?.feed_slug).toBe("since");
  });

  it("treats empty filter arrays as match-everything", () => {
    const feeds = [
      feed({
        id: "f-catch-all",
        slug: "catch-all",
        filters: { sender_match: [], subject_match: [] },
      }),
    ];
    const hit = routeMessageToFeed(msg({ subject: "anything", from_address: "x@y.z" }), feeds);
    expect(hit?.feed_slug).toBe("catch-all");
  });

  it("requires BOTH sender and subject when both filter sets are present", () => {
    const feeds = [
      feed({
        id: "f1",
        slug: "and",
        filters: { sender_match: ["@vendor.com"], subject_match: ["urgent"] },
      }),
    ];
    expect(
      routeMessageToFeed(
        msg({ from_address: "alerts@vendor.com", subject: "info" }),
        feeds,
      ),
    ).toBeNull();
    expect(
      routeMessageToFeed(
        msg({ from_address: "alerts@vendor.com", subject: "URGENT update" }),
        feeds,
      )?.feed_slug,
    ).toBe("and");
  });
});
