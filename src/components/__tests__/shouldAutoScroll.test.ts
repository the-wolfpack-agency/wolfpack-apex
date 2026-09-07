/** @jest-environment node */
/**
 * The auto-scroll gate — the fix for the response "jumping" while you read.
 *
 * The message list auto-scrolls to the bottom on new messages, but the effect
 * fired on the messages ARRAY reference, and the ~15-30s poll/broadcast refresh
 * replaces that array with the same messages. That scrolled the reader away
 * mid-read. shouldAutoScroll gates on the count actually rising, so a refresh
 * that adds nothing never scrolls.
 */

import { shouldAutoScroll } from "@/components/InstinctChat";

describe("shouldAutoScroll", () => {
  it("scrolls when a message is added", () => {
    expect(shouldAutoScroll(2, 0)).toBe(true); // first answer arrives
    expect(shouldAutoScroll(3, 2)).toBe(true); // one more message
  });

  it("does NOT scroll on a background refresh that keeps the same count", () => {
    // This is the bug: poll re-merges 4 messages into a new array, count unchanged.
    expect(shouldAutoScroll(4, 4)).toBe(false);
  });

  it("does not scroll on an empty list or a shorter one", () => {
    expect(shouldAutoScroll(0, 0)).toBe(false);
    expect(shouldAutoScroll(2, 5)).toBe(false);
  });
});
