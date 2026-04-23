/**
 * Unit tests for src/lib/ms-graph-presence.ts — batching, POST shape,
 * availability normalization, 401 → scope_missing analytics.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

export {};

const mockTrack = jest.fn();
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: any[]) => mockTrack(...a),
}));

const fetchMock = jest.fn();
beforeAll(() => {
  (global as any).fetch = fetchMock;
});
beforeEach(() => {
  fetchMock.mockReset();
  mockTrack.mockReset();
});

import {
  getPresence,
  getOwnPresence,
  chunkUserIds,
  PRESENCE_BATCH_MAX,
} from "@/lib/ms-graph-presence";

function okJson(data: any) {
  return {
    ok: true,
    status: 200,
    json: async () => data,
    text: async () => JSON.stringify(data),
  };
}
function errResp(status: number) {
  return {
    ok: false,
    status,
    json: async () => ({}),
    text: async () => "",
  };
}

describe("chunkUserIds", () => {
  it("returns [] for empty input", () => {
    expect(chunkUserIds([])).toEqual([]);
  });
  it("returns a single chunk under size", () => {
    expect(chunkUserIds(["a", "b"], 10)).toEqual([["a", "b"]]);
  });
  it("splits into chunks of exact size", () => {
    const ids = ["a", "b", "c", "d", "e"];
    expect(chunkUserIds(ids, 2)).toEqual([["a", "b"], ["c", "d"], ["e"]]);
  });
  it("respects PRESENCE_BATCH_MAX default", () => {
    const ids = Array.from({ length: PRESENCE_BATCH_MAX + 1 }, (_, i) => `u${i}`);
    const chunks = chunkUserIds(ids);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(PRESENCE_BATCH_MAX);
    expect(chunks[1]).toHaveLength(1);
  });
});

describe("getPresence", () => {
  it("POSTs to getPresencesByUserId with {ids} body and normalizes response", async () => {
    fetchMock.mockResolvedValueOnce(
      okJson({
        value: [
          { id: "u1", availability: "Available", activity: "Available" },
          { id: "u2", availability: "BusyIdle", activity: "InAMeeting" },
        ],
      }),
    );

    const map = await getPresence("TOKEN", ["u1", "u2", "u1"], "caller");

    expect(map.size).toBe(2);
    expect(map.get("u1")?.availability).toBe("Available");
    expect(map.get("u2")?.availability).toBe("Busy"); // BusyIdle → Busy
    expect(map.get("u2")?.activity).toBe("InAMeeting");

    const call = fetchMock.mock.calls[0];
    const url = call[0] as string;
    const init = call[1] as any;
    expect(url).toBe("https://graph.microsoft.com/v1.0/communications/getPresencesByUserId");
    expect(init.method).toBe("POST");
    const parsed = JSON.parse(init.body);
    expect(parsed.ids).toEqual(["u1", "u2"]); // de-duped
    expect(init.headers.Authorization).toBe("Bearer TOKEN");
    expect(init.headers["Content-Type"]).toBe("application/json");

    expect(mockTrack).toHaveBeenCalledWith(
      "ms_presence.batch_fetched",
      "caller",
      "system",
      { count: 2 },
    );
  });

  it("chunks batches at PRESENCE_BATCH_MAX and makes multiple POSTs", async () => {
    const ids = Array.from({ length: PRESENCE_BATCH_MAX + 5 }, (_, i) => `u${i}`);
    fetchMock.mockResolvedValue(okJson({ value: [] }));

    await getPresence("T", ids, "c");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse((fetchMock.mock.calls[0] as any)[1].body);
    const secondBody = JSON.parse((fetchMock.mock.calls[1] as any)[1].body);
    expect(firstBody.ids).toHaveLength(PRESENCE_BATCH_MAX);
    expect(secondBody.ids).toHaveLength(5);
  });

  it("returns empty Map and emits scope_missing on 401", async () => {
    fetchMock.mockResolvedValueOnce(errResp(401));
    const map = await getPresence("T", ["u1"], "caller");
    expect(map.size).toBe(0);
    expect(mockTrack).toHaveBeenCalledWith(
      "ms_presence.scope_missing",
      "caller",
      "system",
      {},
    );
  });

  it("returns empty Map on 403 too", async () => {
    fetchMock.mockResolvedValueOnce(errResp(403));
    const map = await getPresence("T", ["u1"], "caller");
    expect(map.size).toBe(0);
    expect(mockTrack).toHaveBeenCalledWith(
      "ms_presence.scope_missing",
      "caller",
      "system",
      {},
    );
  });

  it("ignores empty input without firing Graph", async () => {
    const map = await getPresence("T", [], "c");
    expect(map.size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockTrack).toHaveBeenCalledWith(
      "ms_presence.batch_fetched",
      "c",
      "system",
      { count: 0 },
    );
  });
});

describe("getOwnPresence", () => {
  it("returns normalized presence on 200", async () => {
    fetchMock.mockResolvedValueOnce(
      okJson({ id: "me", availability: "Away", activity: "Away" }),
    );
    const p = await getOwnPresence("T", "me");
    expect(p).toEqual({ userId: "me", availability: "Away", activity: "Away" });
  });
  it("returns null on 401 and fires scope_missing", async () => {
    fetchMock.mockResolvedValueOnce(errResp(401));
    const p = await getOwnPresence("T", "me");
    expect(p).toBeNull();
    expect(mockTrack).toHaveBeenCalledWith(
      "ms_presence.scope_missing",
      "me",
      "system",
      {},
    );
  });
});
