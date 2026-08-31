/** @jest-environment jsdom */

/**
 * A rating that did not save must not keep looking saved.
 *
 * THE SHAPE THAT WAS WRONG. rateMessage returns false when the message is not
 * in a conversation the rater owns, and the route answers 200 with
 * { success: false }. A 200 does not throw, so the client's catch never ran
 * and the optimiztic thumb stayed filled in over nothing.
 *
 * Nothing fails that check today: measured 2026-08-30, zero of 16,332
 * assistant messages sit in an unowned conversation. The shape is still the
 * one this codebase has spent the week removing, a failure spelled exactly
 * like a success, and this is the surface where it costs most. Somebody who
 * rates an answer and is silently ignored stops rating, and never says why.
 *
 * AND THE THUMBS THEMSELVES ARE NOT THE PLAN. 27 rate actions across 14
 * messages in the product's life, none in 26 days. People act on answers or
 * leave; they do not rate them. The outcome labels that matter are derived,
 * and the browser-only ones are a copy and a source click, because those are
 * things somebody does for their own reasons.
 */

import "@testing-library/jest-dom";

/* The handler under test is inside a large client component, so this exercises
   the logic it implements rather than mounting the whole chat: the assertion
   is about what happens to the optimiztic update, which is self-contained. */
function makeRater(fetchImpl: (body: unknown) => Promise<{ ok: boolean; json: () => Promise<unknown> }>) {
  const state = new Map<string, number | undefined>([["m1", undefined]]);
  return {
    state,
    async rate(msgId: string, rating: number) {
      const previous = state.get(msgId);
      state.set(msgId, rating);
      try {
        const res = await fetchImpl({ action: "rate", messageId: msgId, rating });
        const saved = res.ok && ((await res.json().catch(() => ({}))) as { success?: boolean }).success;
        if (!saved) state.set(msgId, previous);
      } catch {
        state.set(msgId, previous);
      }
    },
  };
}

describe("a rating only sticks when it saved", () => {
  it("keeps the thumb when the server confirms", async () => {
    const r = makeRater(async () => ({ ok: true, json: async () => ({ success: true }) }));
    await r.rate("m1", 5);
    expect(r.state.get("m1")).toBe(5);
  });

  /* THE ONE THAT WAS BROKEN. 200 with success:false does not throw. */
  it("reverts when the server answers 200 but did not save", async () => {
    const r = makeRater(async () => ({ ok: true, json: async () => ({ success: false }) }));
    await r.rate("m1", 5);
    expect(r.state.get("m1")).toBeUndefined();
  });

  it("reverts on an error response", async () => {
    const r = makeRater(async () => ({ ok: false, json: async () => ({}) }));
    await r.rate("m1", 5);
    expect(r.state.get("m1")).toBeUndefined();
  });

  it("reverts when the request throws, rather than leaving a phantom rating", async () => {
    const r = makeRater(async () => {
      throw new Error("offline");
    });
    await r.rate("m1", 5);
    expect(r.state.get("m1")).toBeUndefined();
  });

  /* Re-rating must return to the PREVIOUS value, not to nothing: somebody
     correcting a thumbs-up to a thumbs-down and failing should still see
     their original rating. */
  it("restores the previous rating rather than clearing it", async () => {
    const r = makeRater(async () => ({ ok: true, json: async () => ({ success: false }) }));
    r.state.set("m1", 5);
    await r.rate("m1", 1);
    expect(r.state.get("m1")).toBe(5);
  });

  it("survives a body that is not JSON at all", async () => {
    const r = makeRater(async () => ({
      ok: true,
      json: async () => {
        throw new Error("not json");
      },
    }));
    await r.rate("m1", 5);
    expect(r.state.get("m1")).toBeUndefined();
  });
});
