/**
 * @jest-environment jsdom
 */

/**
 * The badge-poll counter flush is the beacon that 401'd on every /emails visit
 * in the post-merge E2E run: it POSTed /api/analytics with no Authorization
 * header. It now goes through sendTelemetry (which carries the token), and when
 * there is no session it keeps its counters for the next window instead of
 * discarding them.
 */
const mockSendTelemetry = jest.fn();
const mockFetchWithRefresh = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: unknown[]) => mockFetchWithRefresh(...a),
  sendTelemetry: (...a: unknown[]) => mockSendTelemetry(...a),
}));

import { coalescedFetchWithRefresh, __resetCoalescedFetchForTests } from "../coalesced-fetch";

const rawFetch = jest.fn();
global.fetch = rawFetch as unknown as typeof fetch;

function reply() {
  return { status: 200, ok: true, json: async () => ({ count: 0 }) } as unknown as Response;
}

beforeEach(() => {
  __resetCoalescedFetchForTests();
  mockSendTelemetry.mockReset();
  mockFetchWithRefresh.mockReset();
  mockFetchWithRefresh.mockResolvedValue(reply());
  rawFetch.mockReset();
  process.env.NEXT_PUBLIC_INSTINCT_BADGE_OPTIMIZE = "true";
});

afterEach(() => {
  delete process.env.NEXT_PUBLIC_INSTINCT_BADGE_OPTIMIZE;
});

it("flushes the counters through sendTelemetry, never a tokenless raw fetch", async () => {
  mockSendTelemetry.mockReturnValue(true);
  await coalescedFetchWithRefresh("/api/ms/chats/unread-count");
  expect(mockSendTelemetry).toHaveBeenCalledWith(
    "system.badge_poll_optimized",
    expect.objectContaining({ requests_served: 1, network_calls: 1, requests_saved: 0 }),
  );
  expect(rawFetch).not.toHaveBeenCalled();
});

it("keeps the counters when there is no session, and sends them once there is", async () => {
  mockSendTelemetry.mockReturnValueOnce(false);
  await coalescedFetchWithRefresh("/api/ms/chats/unread-count");
  mockSendTelemetry.mockReturnValueOnce(true);
  await coalescedFetchWithRefresh("/api/microsoft/messages/unread-count");
  expect(mockSendTelemetry).toHaveBeenCalledTimes(2);
  expect(mockSendTelemetry.mock.calls[1][1]).toEqual(
    expect.objectContaining({ requests_served: 2, network_calls: 2 }),
  );
});
