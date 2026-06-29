/**
 * internalFetch - the shared server-side self-call transport.
 *
 * Pins the behavior every call site (forms/execute forwardJson + chat-list,
 * agents/tasks/executor operation call) now depends on:
 *   - adds the Vercel deployment-protection bypass headers ONLY when
 *     VERCEL_AUTOMATION_BYPASS_SECRET is set (absent -> unchanged behavior),
 *   - retries ONCE on a THROWN fetch then succeeds (transient undici blip),
 *   - does NOT retry a non-2xx response (that is a real answer, returned as-is),
 *   - on a final throw raises a DIAGNOSABLE error naming the origin + path,
 *   - forwards the caller's Authorization header VERBATIM,
 *   - builds the absolute URL from resolveInternalOrigin (or an override).
 *
 * The transport is injected (fetchImpl) so we never touch the real network.
 */

import { internalFetch } from "@/lib/http/internal-fetch";

const SAVED = {
  VERCEL_AUTOMATION_BYPASS_SECRET: process.env.VERCEL_AUTOMATION_BYPASS_SECRET,
  NEXT_PUBLIC_BASE_URL: process.env.NEXT_PUBLIC_BASE_URL,
  VERCEL_PROJECT_PRODUCTION_URL: process.env.VERCEL_PROJECT_PRODUCTION_URL,
  VERCEL_BRANCH_URL: process.env.VERCEL_BRANCH_URL,
  VERCEL_URL: process.env.VERCEL_URL,
  NODE_ENV: process.env.NODE_ENV,
};

const ORIGIN = "https://internal.example";

function ok(status = 200): Response {
  return new Response(JSON.stringify({ ok: true }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Read the headers the transport actually received as a plain lookup. */
function headersOf(init: RequestInit | undefined): Record<string, string> {
  return (init?.headers ?? {}) as Record<string, string>;
}

beforeEach(() => {
  delete process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  delete process.env.NEXT_PUBLIC_BASE_URL;
  delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
  delete process.env.VERCEL_BRANCH_URL;
  delete process.env.VERCEL_URL;
});

afterAll(() => {
  for (const [k, v] of Object.entries(SAVED)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("URL resolution", () => {
  test("builds the absolute URL from the originOverride + path", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(ok());
    await internalFetch("/api/tasks", { originOverride: ORIGIN, fetchImpl });
    expect(fetchImpl.mock.calls[0][0]).toBe(`${ORIGIN}/api/tasks`);
  });

  test("falls back to resolveInternalOrigin (NEXT_PUBLIC_BASE_URL) when no override", async () => {
    process.env.NEXT_PUBLIC_BASE_URL = "https://canonical.example";
    const fetchImpl = jest.fn().mockResolvedValue(ok());
    await internalFetch("/api/x", { fetchImpl });
    expect(fetchImpl.mock.calls[0][0]).toBe("https://canonical.example/api/x");
  });

  test("strips a trailing slash on the override so the URL is never doubled", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(ok());
    await internalFetch("/api/x", { originOverride: "https://internal.example/", fetchImpl });
    expect(fetchImpl.mock.calls[0][0]).toBe("https://internal.example/api/x");
  });
});

describe("Vercel deployment-protection bypass headers", () => {
  test("ADDS the bypass headers when VERCEL_AUTOMATION_BYPASS_SECRET is set", async () => {
    process.env.VERCEL_AUTOMATION_BYPASS_SECRET = "s3cr3t";
    const fetchImpl = jest.fn().mockResolvedValue(ok());
    await internalFetch("/api/x", { originOverride: ORIGIN, fetchImpl });
    const h = headersOf(fetchImpl.mock.calls[0][1]);
    expect(h["x-vercel-protection-bypass"]).toBe("s3cr3t");
    expect(h["x-vercel-set-bypass-cookie"]).toBe("true");
  });

  test("OMITS the bypass headers when the secret is unset (behavior unchanged)", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(ok());
    await internalFetch("/api/x", { originOverride: ORIGIN, fetchImpl });
    const h = headersOf(fetchImpl.mock.calls[0][1]);
    expect(h["x-vercel-protection-bypass"]).toBeUndefined();
    expect(h["x-vercel-set-bypass-cookie"]).toBeUndefined();
  });
});

describe("Authorization forwarding (security)", () => {
  test("forwards the caller's Authorization header verbatim", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(ok());
    await internalFetch("/api/x", {
      originOverride: ORIGIN,
      fetchImpl,
      init: { headers: { Authorization: "Bearer abc.def.ghi", "Content-Type": "application/json" } },
    });
    const h = headersOf(fetchImpl.mock.calls[0][1]);
    expect(h.Authorization).toBe("Bearer abc.def.ghi");
    expect(h["Content-Type"]).toBe("application/json");
  });

  test("a caller header is never overridden by the bypass merge", async () => {
    process.env.VERCEL_AUTOMATION_BYPASS_SECRET = "s3cr3t";
    const fetchImpl = jest.fn().mockResolvedValue(ok());
    await internalFetch("/api/x", {
      originOverride: ORIGIN,
      fetchImpl,
      init: { headers: { "x-vercel-protection-bypass": "caller-wins" } },
    });
    const h = headersOf(fetchImpl.mock.calls[0][1]);
    expect(h["x-vercel-protection-bypass"]).toBe("caller-wins");
  });
});

describe("retry on a THROWN fetch", () => {
  test("retries ONCE on a thrown fetch, then succeeds", async () => {
    const fetchImpl = jest
      .fn()
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockResolvedValueOnce(ok());
    const res = await internalFetch("/api/x", { originOverride: ORIGIN, fetchImpl });
    expect(res.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test("does NOT retry a non-2xx response (a real answer, returned as-is)", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(ok(403));
    const res = await internalFetch("/api/x", { originOverride: ORIGIN, fetchImpl });
    expect(res.status).toBe(403);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("diagnosable final error", () => {
  test("on a persistent throw, the error names the resolved origin + path + cause", async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(
      internalFetch("/api/tasks", { originOverride: ORIGIN, fetchImpl }),
    ).rejects.toThrow(`Failed to reach internal API at ${ORIGIN}/api/tasks: ECONNREFUSED`);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test("the diagnosable error never contains a forwarded bearer token", async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error("boom"));
    let caught: Error | undefined;
    try {
      await internalFetch("/api/x", {
        originOverride: ORIGIN,
        fetchImpl,
        init: { headers: { Authorization: "Bearer super-secret-token" } },
      });
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeDefined();
    expect(caught?.message).not.toMatch(/super-secret-token/);
  });
});
