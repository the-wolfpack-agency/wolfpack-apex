/**
 * Unit tests for src/lib/ms-graph-deep-links.ts — pure string builders.
 * No mocks required.
 */

import {
  chatDeepLink,
  callDeepLink,
  meetNowDeepLink,
} from "@/lib/ms-graph-deep-links";

describe("chatDeepLink", () => {
  it("builds the base chat URL with encoded email", () => {
    expect(chatDeepLink("alice+tag@example.com")).toBe(
      "https://teams.microsoft.com/l/chat/0/0?users=alice%2Btag%40example.com",
    );
  });

  it("appends URL-encoded message when provided", () => {
    const url = chatDeepLink("alice@example.com", "Hello world & 100% good!");
    expect(url).toBe(
      "https://teams.microsoft.com/l/chat/0/0?users=alice%40example.com" +
        "&message=Hello%20world%20%26%20100%25%20good!",
    );
  });

  it("omits message param when empty string", () => {
    const url = chatDeepLink("alice@example.com", "");
    expect(url).toBe("https://teams.microsoft.com/l/chat/0/0?users=alice%40example.com");
    expect(url).not.toContain("message=");
  });

  it("throws on non-email input", () => {
    expect(() => chatDeepLink("not-an-email")).toThrow(TypeError);
  });

  it("throws on non-string input", () => {
    // @ts-expect-error — runtime guard test
    expect(() => chatDeepLink(null)).toThrow(TypeError);
  });
});

describe("callDeepLink", () => {
  it("defaults to audio-only (withVideo=0)", () => {
    expect(callDeepLink("bob@example.com")).toBe(
      "https://teams.microsoft.com/l/call/0/0?users=bob%40example.com&withVideo=0",
    );
  });

  it("sets withVideo=1 when true", () => {
    expect(callDeepLink("bob@example.com", true)).toBe(
      "https://teams.microsoft.com/l/call/0/0?users=bob%40example.com&withVideo=1",
    );
  });

  it("throws on bad email", () => {
    expect(() => callDeepLink("x")).toThrow(TypeError);
  });
});

describe("meetNowDeepLink", () => {
  it("returns the fixed Teams meet-now URL", () => {
    expect(meetNowDeepLink()).toBe("https://teams.microsoft.com/l/meeting/new");
  });
});
