/**
 * App-only Graph access — getAppOnlyToken + getReadTokenForUser +
 * graphPathForReadToken. The validators that read team data (mail,
 * calendar, tasks) opt-in to app-only when INSTINCT_GRAPH_APP_ONLY=true
 * AND admin consent has been granted in Azure. Without consent or env,
 * the helpers fall back gracefully so today's delegated path keeps
 * working.
 */

 
const mockSafeQuery = jest.fn();
const mockGetSecret = jest.fn();

jest.mock("@/lib/db", () => {
  const actual = jest.requireActual("@/lib/db");
  return { ...actual, safeQuery: (...a: any[]) => mockSafeQuery(...a) };
});
jest.mock("@/lib/secrets", () => ({
  getSecretOrThrow: (k: string) => mockGetSecret(k),
}));

import {
  getAppOnlyToken,
  getReadTokenForUser,
  graphPathForReadToken,
  _resetAppTokenCacheForTests,
} from "@/lib/microsoft-graph";

const ORIG_FETCH = global.fetch;
const ORIG_ENV = { ...process.env };

beforeEach(() => {
  mockSafeQuery.mockReset();
  mockGetSecret.mockReset();
  _resetAppTokenCacheForTests();
  process.env = { ...ORIG_ENV };
});
afterEach(() => {
  global.fetch = ORIG_FETCH;
});
afterAll(() => {
  process.env = ORIG_ENV;
});

describe("graphPathForReadToken", () => {
  test("delegated → /me/{suffix}", () => {
    const path = graphPathForReadToken(
      { accessToken: "t", isAppOnly: false, userPath: null },
      "calendarview",
    );
    expect(path).toBe("/me/calendarview");
  });
  test("app-only → /users/{email}/{suffix} with email URL-encoded", () => {
    const path = graphPathForReadToken(
      { accessToken: "t", isAppOnly: true, userPath: "jorge@thewolfpack.agency" },
      "mailFolders/sentitems/messages",
    );
    expect(path).toBe(
      "/users/jorge%40thewolfpack.agency/mailFolders/sentitems/messages",
    );
  });
  test("strips leading slash from suffix", () => {
    const path = graphPathForReadToken(
      { accessToken: "t", isAppOnly: false, userPath: null },
      "/me-events",
    );
    expect(path).toBe("/me/me-events");
  });
});

describe("getAppOnlyToken", () => {
  test("returns null when MS_TENANT_ID is unset / 'common'", async () => {
    delete process.env.MS_TENANT_ID;
    expect(await getAppOnlyToken()).toBeNull();
    process.env.MS_TENANT_ID = "common";
    expect(await getAppOnlyToken()).toBeNull();
  });
  test("returns null when client creds are missing", async () => {
    process.env.MS_TENANT_ID = "tenant-guid";
    mockGetSecret.mockImplementation((k: string) => {
      if (k === "MS_CLIENT_ID") throw new Error("missing");
      return "x";
    });
    expect(await getAppOnlyToken()).toBeNull();
  });
  test("returns null when Azure 401s (admin consent not granted yet)", async () => {
    process.env.MS_TENANT_ID = "tenant-guid";
    process.env.MS_CLIENT_ID = "client-x";
    process.env.MS_CLIENT_SECRET = "secret-x";
    global.fetch = jest.fn(async () => ({
      ok: false,
      status: 401,
      text: async () => "{}",
      json: async () => ({}),
    })) as any;
    expect(await getAppOnlyToken()).toBeNull();
  });
  test("happy path: caches token, returns same on second call without re-fetching", async () => {
    process.env.MS_TENANT_ID = "tenant-guid";
    process.env.MS_CLIENT_ID = "client-x";
    process.env.MS_CLIENT_SECRET = "secret-x";
    const fetchMock = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ access_token: "app-token-1", expires_in: 3600 }),
    }));
    global.fetch = fetchMock as any;
    const t1 = await getAppOnlyToken();
    expect(t1).toBe("app-token-1");
    /* Second call within TTL hits cache; fetch shouldn't fire twice. */
    const t2 = await getAppOnlyToken();
    expect(t2).toBe("app-token-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("getReadTokenForUser", () => {
  test("flag off → falls through to delegated lookup (no app-only attempt)", async () => {
    delete process.env.INSTINCT_GRAPH_APP_ONLY;
    /* Delegated path queries instinct_ms_tokens via getValidToken;
       safeQuery returns no rows so getValidToken returns null. */
    mockSafeQuery.mockResolvedValue({ rows: [] });
    expect(await getReadTokenForUser("u1")).toBeNull();
  });

  test("flag on + app-only succeeds + email resolves → returns app-only token", async () => {
    process.env.INSTINCT_GRAPH_APP_ONLY = "true";
    process.env.MS_TENANT_ID = "tenant-guid";
    process.env.MS_CLIENT_ID = "client-x";
    process.env.MS_CLIENT_SECRET = "secret-x";
    mockSafeQuery.mockResolvedValueOnce({
      rows: [{ email: "jorge@thewolfpack.agency" }],
    });
    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ access_token: "app-token-2", expires_in: 3600 }),
    })) as any;
    const token = await getReadTokenForUser("u-jorge");
    expect(token).toEqual({
      accessToken: "app-token-2",
      isAppOnly: true,
      userPath: "jorge@thewolfpack.agency",
    });
  });

  test("flag on but Azure has no consent yet → falls back to delegated", async () => {
    process.env.INSTINCT_GRAPH_APP_ONLY = "true";
    process.env.MS_TENANT_ID = "tenant-guid";
    process.env.MS_CLIENT_ID = "client-x";
    process.env.MS_CLIENT_SECRET = "secret-x";
    /* App-only token request fails (no consent). */
    let call = 0;
    global.fetch = jest.fn(async () => {
      call++;
      if (call === 1) {
        return { ok: false, status: 403, json: async () => ({}) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    }) as any;
    /* Delegated lookup returns no rows → null. */
    mockSafeQuery.mockResolvedValue({ rows: [] });
    expect(await getReadTokenForUser("u1")).toBeNull();
  });
});
