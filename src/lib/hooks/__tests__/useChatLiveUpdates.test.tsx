/**
 * @jest-environment jsdom
 *
 * useChatLiveUpdates — composition of useAdaptivePoll + BroadcastChannel.
 *
 * What this suite locks:
 *   - the poll callback fires through onRefresh("poll") on the adaptive
 *     timer
 *   - the BroadcastChannel handler triggers onRefresh("broadcast") and
 *     onBroadcastReceived(lagMs) only when the broadcast's latestMessageId
 *     differs from the local view's
 *   - broadcastSent() posts the right payload to other tabs
 *   - the hook is a no-op when conversationId is null
 *   - cleanup closes the channel on unmount
 *   - the hook never broadcasts back to its OWN subscription (no echo)
 */

import "@testing-library/jest-dom";
import { renderHook, act } from "@testing-library/react";

/* Mock useAdaptivePoll so the suite can synchronously fire the poll
 * callback without setting up fake timers + visibility events. */
const mockUseAdaptivePoll = jest.fn();
jest.mock("@/lib/hooks/useAdaptivePoll", () => ({
  useAdaptivePoll: (cb: () => void, opts: unknown) =>
    mockUseAdaptivePoll(cb, opts),
}));

import { useChatLiveUpdates } from "@/lib/hooks/useChatLiveUpdates";

interface FakeChannel {
  name: string;
  listeners: ((ev: MessageEvent<unknown>) => void)[];
  posted: unknown[];
  closed: boolean;
}

const channels: FakeChannel[] = [];

class FakeBroadcastChannel {
  static channels = channels;
  name: string;
  _self: FakeChannel;
  constructor(name: string) {
    this.name = name;
    this._self = { name, listeners: [], posted: [], closed: false };
    channels.push(this._self);
  }
  addEventListener(_type: string, fn: (ev: MessageEvent<unknown>) => void) {
    this._self.listeners.push(fn);
  }
  removeEventListener(_type: string, fn: (ev: MessageEvent<unknown>) => void) {
    this._self.listeners = this._self.listeners.filter((f) => f !== fn);
  }
  postMessage(payload: unknown) {
    this._self.posted.push(payload);
    /* Real BroadcastChannel does NOT echo to its OWN subscribers.
     * Mirror that semantic so the test catches accidental echo. */
    for (const ch of channels) {
      if (ch === this._self) continue;
      if (ch.name !== this.name) continue;
      if (ch.closed) continue;
      for (const l of ch.listeners) {
        l(new MessageEvent("message", { data: payload }));
      }
    }
  }
  close() {
    this._self.closed = true;
  }
}

beforeEach(() => {
  channels.length = 0;
  mockUseAdaptivePoll.mockReset();
  (globalThis as unknown as { BroadcastChannel: typeof BroadcastChannel }).BroadcastChannel =
    FakeBroadcastChannel as unknown as typeof BroadcastChannel;
});

afterEach(() => {
  delete (globalThis as unknown as { BroadcastChannel?: unknown }).BroadcastChannel;
});

function captureAdaptivePoll(): { fire: () => void; isStable: () => boolean } {
  expect(mockUseAdaptivePoll).toHaveBeenCalledTimes(1);
  const [cb, opts] = mockUseAdaptivePoll.mock.calls[0] as [
    () => void,
    { isStable: () => boolean },
  ];
  return { fire: cb, isStable: opts.isStable };
}

describe("useChatLiveUpdates — poll path", () => {
  test("fires onPollFired + onRefresh('poll') when the adaptive poll callback runs", () => {
    const onRefresh = jest.fn();
    const onPollFired = jest.fn();
    renderHook(() =>
      useChatLiveUpdates({
        conversationId: "conv-1",
        latestLocalMessageId: "m-1",
        onRefresh,
        onPollFired,
      }),
    );
    const { fire } = captureAdaptivePoll();

    act(() => fire());
    expect(onPollFired).toHaveBeenCalledTimes(1);
    expect(onRefresh).toHaveBeenCalledWith("poll");
  });

  test("the isStable hint returns true when there is a latest local message id", () => {
    renderHook(() =>
      useChatLiveUpdates({
        conversationId: "conv-1",
        latestLocalMessageId: "m-1",
        onRefresh: jest.fn(),
      }),
    );
    expect(captureAdaptivePoll().isStable()).toBe(true);
  });

  test("isStable returns false when there is no local message yet (empty conversation)", () => {
    renderHook(() =>
      useChatLiveUpdates({
        conversationId: "conv-1",
        latestLocalMessageId: null,
        onRefresh: jest.fn(),
      }),
    );
    expect(captureAdaptivePoll().isStable()).toBe(false);
  });

  test("poll callback does nothing when conversationId is null", () => {
    const onRefresh = jest.fn();
    const onPollFired = jest.fn();
    renderHook(() =>
      useChatLiveUpdates({
        conversationId: null,
        latestLocalMessageId: null,
        onRefresh,
        onPollFired,
      }),
    );
    const { fire } = captureAdaptivePoll();
    act(() => fire());
    expect(onPollFired).not.toHaveBeenCalled();
    expect(onRefresh).not.toHaveBeenCalled();
  });
});

describe("useChatLiveUpdates — broadcast path", () => {
  test("opens a per-conversation BroadcastChannel on mount", () => {
    renderHook(() =>
      useChatLiveUpdates({
        conversationId: "conv-42",
        latestLocalMessageId: null,
        onRefresh: jest.fn(),
      }),
    );
    expect(channels).toHaveLength(1);
    expect(channels[0].name).toBe("instinct.chat.conv-42");
  });

  test("does NOT open a channel when conversationId is null", () => {
    renderHook(() =>
      useChatLiveUpdates({
        conversationId: null,
        latestLocalMessageId: null,
        onRefresh: jest.fn(),
      }),
    );
    expect(channels).toHaveLength(0);
  });

  test("incoming broadcast with a NEW message id triggers onRefresh('broadcast') + onBroadcastReceived", () => {
    const onRefresh = jest.fn();
    const onBroadcastReceived = jest.fn();
    renderHook(() =>
      useChatLiveUpdates({
        conversationId: "conv-1",
        latestLocalMessageId: "m-1",
        onRefresh,
        onBroadcastReceived,
      }),
    );
    /* Simulate another tab sending a broadcast on the same channel. */
    act(() => {
      const sender = new FakeBroadcastChannel("instinct.chat.conv-1");
      sender.postMessage({
        type: "chat.message.added",
        conversationId: "conv-1",
        latestMessageId: "m-2",
        broadcastAtMs: Date.now() - 10,
      });
    });
    expect(onRefresh).toHaveBeenCalledWith("broadcast");
    expect(onBroadcastReceived).toHaveBeenCalledTimes(1);
    expect(onBroadcastReceived.mock.calls[0][0]).toBeGreaterThanOrEqual(0);
  });

  test("ignores broadcasts whose latestMessageId matches the local view (no echo loop)", () => {
    const onRefresh = jest.fn();
    renderHook(() =>
      useChatLiveUpdates({
        conversationId: "conv-1",
        latestLocalMessageId: "m-7",
        onRefresh,
      }),
    );
    act(() => {
      const sender = new FakeBroadcastChannel("instinct.chat.conv-1");
      sender.postMessage({
        type: "chat.message.added",
        conversationId: "conv-1",
        latestMessageId: "m-7",
        broadcastAtMs: Date.now(),
      });
    });
    expect(onRefresh).not.toHaveBeenCalled();
  });

  test("ignores broadcasts for a different conversation", () => {
    const onRefresh = jest.fn();
    renderHook(() =>
      useChatLiveUpdates({
        conversationId: "conv-A",
        latestLocalMessageId: "m-1",
        onRefresh,
      }),
    );
    act(() => {
      /* Another channel name → never delivered to conv-A subscriber. */
      const sender = new FakeBroadcastChannel("instinct.chat.conv-B");
      sender.postMessage({
        type: "chat.message.added",
        conversationId: "conv-B",
        latestMessageId: "m-99",
        broadcastAtMs: Date.now(),
      });
    });
    expect(onRefresh).not.toHaveBeenCalled();
  });

  test("ignores broadcasts of the wrong type (defensive)", () => {
    const onRefresh = jest.fn();
    renderHook(() =>
      useChatLiveUpdates({
        conversationId: "conv-1",
        latestLocalMessageId: "m-1",
        onRefresh,
      }),
    );
    act(() => {
      const sender = new FakeBroadcastChannel("instinct.chat.conv-1");
      sender.postMessage({ type: "not.a.real.event" });
    });
    expect(onRefresh).not.toHaveBeenCalled();
  });
});

describe("useChatLiveUpdates — broadcastSent", () => {
  test("broadcasts the new message id to other tabs of the same conversation", () => {
    /* Set up a SECOND subscriber on the same channel so we can
     * observe what was actually posted. */
    const receiver = new FakeBroadcastChannel("instinct.chat.conv-1");
    const incoming: unknown[] = [];
    receiver.addEventListener("message", (ev) => {
      incoming.push(ev.data);
    });

    const { result } = renderHook(() =>
      useChatLiveUpdates({
        conversationId: "conv-1",
        latestLocalMessageId: "m-1",
        onRefresh: jest.fn(),
      }),
    );

    act(() => result.current.broadcastSent("m-2"));

    expect(incoming).toHaveLength(1);
    const payload = incoming[0] as {
      type: string;
      conversationId: string;
      latestMessageId: string;
      broadcastAtMs: number;
    };
    expect(payload.type).toBe("chat.message.added");
    expect(payload.conversationId).toBe("conv-1");
    expect(payload.latestMessageId).toBe("m-2");
    expect(payload.broadcastAtMs).toBeGreaterThan(0);
  });

  test("broadcastSent does NOT echo back to its own subscriber (no loop)", () => {
    const onRefresh = jest.fn();
    const { result } = renderHook(() =>
      useChatLiveUpdates({
        conversationId: "conv-1",
        latestLocalMessageId: "m-1",
        onRefresh,
      }),
    );

    act(() => result.current.broadcastSent("m-2"));
    expect(onRefresh).not.toHaveBeenCalled();
  });

  test("broadcastSent is a no-op when conversationId is null", () => {
    const { result } = renderHook(() =>
      useChatLiveUpdates({
        conversationId: null,
        latestLocalMessageId: null,
        onRefresh: jest.fn(),
      }),
    );
    act(() => result.current.broadcastSent("m-1"));
    expect(channels).toHaveLength(0);
  });

  test("broadcastSent is a no-op when latestMessageId is empty", () => {
    const sniff = new FakeBroadcastChannel("instinct.chat.conv-1");
    const incoming: unknown[] = [];
    sniff.addEventListener("message", (ev) => incoming.push(ev.data));

    const { result } = renderHook(() =>
      useChatLiveUpdates({
        conversationId: "conv-1",
        latestLocalMessageId: "m-1",
        onRefresh: jest.fn(),
      }),
    );
    act(() => result.current.broadcastSent(""));
    expect(incoming).toHaveLength(0);
  });
});

describe("useChatLiveUpdates — lifecycle", () => {
  test("closes the channel on unmount", () => {
    const { unmount } = renderHook(() =>
      useChatLiveUpdates({
        conversationId: "conv-1",
        latestLocalMessageId: "m-1",
        onRefresh: jest.fn(),
      }),
    );
    expect(channels[0].closed).toBe(false);
    unmount();
    expect(channels[0].closed).toBe(true);
  });

  test("re-subscribes when conversationId changes", () => {
    const { rerender } = renderHook(
      (props: { conversationId: string }) =>
        useChatLiveUpdates({
          conversationId: props.conversationId,
          latestLocalMessageId: "m-1",
          onRefresh: jest.fn(),
        }),
      { initialProps: { conversationId: "conv-A" } },
    );
    expect(channels.filter((c) => !c.closed)).toHaveLength(1);
    expect(channels[0].name).toBe("instinct.chat.conv-A");

    rerender({ conversationId: "conv-B" });
    const open = channels.filter((c) => !c.closed);
    expect(open).toHaveLength(1);
    expect(open[0].name).toBe("instinct.chat.conv-B");
  });

  test("does not crash when BroadcastChannel is unavailable (older browser)", () => {
    delete (globalThis as unknown as { BroadcastChannel?: unknown }).BroadcastChannel;
    expect(() => {
      renderHook(() =>
        useChatLiveUpdates({
          conversationId: "conv-1",
          latestLocalMessageId: "m-1",
          onRefresh: jest.fn(),
        }),
      );
    }).not.toThrow();
  });
});
