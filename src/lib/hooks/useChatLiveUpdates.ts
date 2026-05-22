"use client";

/**
 * useChatLiveUpdates — keep an open assistant conversation in sync with
 * the server without forcing the user to refresh.
 *
 * Composes two existing primitives + one native browser API:
 *
 *   1. `useAdaptivePoll` (existing) does the work-horse refetch on a
 *      visible/hidden/idle cadence. The hook fires the callback at
 *      30s when the tab is visible, 120s when hidden, and 180s once
 *      the conversation has been stable for 5 consecutive polls. It
 *      also re-fires immediately on tab refocus, which covers the
 *      "I switched back to the tab and missed an update" case.
 *
 *   2. `BroadcastChannel` (native) gives instant same-origin cross-
 *      tab sync. When tab A sends a message and gets a response, it
 *      broadcasts the new message ids to other tabs of the same user.
 *      Receiving tabs invalidate their cache and re-fetch immediately,
 *      so a two-tab user sees both halves of the chat in real time
 *      without waiting for the 30s poll.
 *
 *   3. `coalesced-fetch` (existing) deduplicates concurrent GETs to
 *      the same URL so a tab that broadcasts AND polls at the same
 *      instant only hits the network once.
 *
 * Analytics events fire on each sync path so the learning loop can
 * track which mechanism actually delivers updates in production. If
 * BroadcastChannel covers 95% of real-world catches, the polling
 * cadence can be relaxed further. If polling carries the load, the
 * cadence stays where it is.
 *
 * Security note: BroadcastChannel is scoped to a single browser
 * origin. Messages broadcast on one origin never leak to another.
 * The channel name embeds the conversation id, so each conversation
 * has its own isolated channel — a user with two unrelated chats
 * open in two tabs does not get cross-talk.
 */

import { useCallback, useEffect, useRef } from "react";
import { useAdaptivePoll } from "@/lib/hooks/useAdaptivePoll";

/** Identifies a single new message landing on the server. The
 *  broadcasting tab knows the id because the POST response gave it
 *  back. Receiving tabs use this to short-circuit the cache. */
export interface ChatLiveUpdateMessage {
  type: "chat.message.added";
  conversationId: string;
  /** ID of the latest message the broadcasting tab knows about.
   *  Receiving tabs compare to their last-seen id to decide whether
   *  to refetch. */
  latestMessageId: string;
  /** When the broadcasting tab saw the message land. Lets the
   *  receiver compute lag for the analytics event. */
  broadcastAtMs: number;
}

export interface UseChatLiveUpdatesOptions {
  /** The conversation currently rendered. Null/empty disables the
   *  hook entirely (no poll, no channel). */
  conversationId: string | null;
  /** ID of the latest message the local view has rendered. Used as
   *  the stability hint for useAdaptivePoll — when this is stable
   *  for 5 polls, the cadence backs off to the idle interval. */
  latestLocalMessageId: string | null;
  /** Called when a refresh should happen. Implementations should
   *  re-fetch the conversation and call `setMessages` with the
   *  result. */
  onRefresh: (reason: RefreshReason) => void;
  /** Called when a BroadcastChannel message lands from another tab.
   *  Implementations should record an analytics event with the lag
   *  measurement. Optional — the hook still functions if omitted. */
  onBroadcastReceived?: (lagMs: number) => void;
  /** Called once per poll-driven refresh. Implementations should
   *  record an analytics event. Optional. */
  onPollFired?: () => void;
}

export type RefreshReason = "poll" | "broadcast" | "manual";

/** Build a per-conversation channel name. Same convention across
 *  tabs so they actually meet. */
function channelNameFor(conversationId: string): string {
  return `instinct.chat.${conversationId}`;
}

/**
 * Hook entry point. Sets up the adaptive poll, the BroadcastChannel
 * subscription, and the unmount cleanup. Returns a `broadcastSent`
 * function the host component calls AFTER a successful POST so
 * other tabs of the same user pick up the new message instantly.
 */
export function useChatLiveUpdates(
  opts: UseChatLiveUpdatesOptions,
): {
  /** Call after the host component appends a new message that came
   *  from THIS tab's own POST. Broadcasts to other tabs of the same
   *  origin so they pick up the new message without waiting for a
   *  poll cycle. No-op when conversationId is null or when
   *  BroadcastChannel is unsupported. */
  broadcastSent: (latestMessageId: string) => void;
} {
  const { conversationId, latestLocalMessageId } = opts;
  const optsRef = useRef(opts);
  useEffect(() => {
    optsRef.current = opts;
  }, [opts]);

  const channelRef = useRef<BroadcastChannel | null>(null);

  /* The stability hint and poll callback both close over the latest
   * opts via the ref above, so neither changes identity per render. */
  const isStable = useCallback((): boolean => {
    return Boolean(optsRef.current.latestLocalMessageId);
  }, []);
  const pollCallback = useCallback((): void => {
    const o = optsRef.current;
    if (!o.conversationId) return;
    o.onPollFired?.();
    o.onRefresh("poll");
  }, []);

  /* The adaptive-poll hook itself bails out when conversationId is
   * null (the callback short-circuits), so we always mount it. */
  useAdaptivePoll(pollCallback, {
    isStable,
  });

  /* BroadcastChannel subscription — one channel per open conversation
   * so a user with two unrelated chats does not get cross-talk. */
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (typeof BroadcastChannel === "undefined") return;
    if (!conversationId) return;

    const ch = new BroadcastChannel(channelNameFor(conversationId));
    channelRef.current = ch;

    const handleMessage = (ev: MessageEvent<unknown>): void => {
      const msg = ev.data as Partial<ChatLiveUpdateMessage> | null;
      if (!msg || msg.type !== "chat.message.added") return;
      if (msg.conversationId !== conversationId) return;
      if (
        msg.latestMessageId &&
        msg.latestMessageId === optsRef.current.latestLocalMessageId
      ) {
        return;
      }
      const lagMs =
        typeof msg.broadcastAtMs === "number"
          ? Math.max(0, Date.now() - msg.broadcastAtMs)
          : 0;
      optsRef.current.onBroadcastReceived?.(lagMs);
      optsRef.current.onRefresh("broadcast");
    };

    ch.addEventListener("message", handleMessage);
    return () => {
      ch.removeEventListener("message", handleMessage);
      try {
        ch.close();
      } catch {
        /* Closing an already-closed channel throws in some browsers;
         * never surface a cleanup error. */
      }
      if (channelRef.current === ch) channelRef.current = null;
    };
  }, [conversationId]);

  /* Suppress unused warning while keeping the prop in the type for
   * callers that want to pass it for clarity. */
  void latestLocalMessageId;

  const broadcastSent = useCallback(
    (latestMessageId: string): void => {
      const cid = optsRef.current.conversationId;
      if (!cid) return;
      if (typeof BroadcastChannel === "undefined") return;
      if (!latestMessageId) return;
      /* Reuse the subscriber channel for sending. Per spec, a
       * BroadcastChannel does NOT deliver its own postMessage to its
       * own onmessage handler. This is exactly what we want: tabs of
       * the SAME user but in DIFFERENT browser tabs (each holding
       * their own channel instance) receive the broadcast, while
       * this tab's own listener does not echo. Using a separate
       * fresh-channel for sending would echo to the subscriber in
       * the same tab and cause an infinite refresh loop. */
      const channel = channelRef.current;
      if (!channel) return;
      try {
        const payload: ChatLiveUpdateMessage = {
          type: "chat.message.added",
          conversationId: cid,
          latestMessageId,
          broadcastAtMs: Date.now(),
        };
        channel.postMessage(payload);
      } catch {
        /* Broadcasting is best-effort. If the API is gated by an
         * environment we don't support, we still rely on the poll
         * layer to deliver updates within ~30s. */
      }
    },
    [],
  );

  return { broadcastSent };
}
