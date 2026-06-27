/**
 * mintInstallationToken + resolveGithubToken.
 *
 * Covers, with a mocked fetch + a real in-process RSA test key + an injected
 * clock:
 *   - mint: successful exchange returns the token, posts to the right URL with a
 *     Bearer App-JWT, and caches the token (second call: no second fetch).
 *   - mint: cache expires after the token's expires_at (minus skew) → re-fetch.
 *   - mint: no App config / no installation / GitHub non-2xx / network throw /
 *     malformed body all return null (never throw).
 *   - resolveGithubToken fallback matrix:
 *       app + installation + success → installation token
 *       no app env                   → PAT
 *       app env but no installation   → PAT
 *       App error (GitHub 500)        → PAT
 *       no workspaceId                → PAT
 *   - never logs the private key or the token.
 */

import { generateKeyPairSync } from "node:crypto";
import {
  mintInstallationToken,
  resolveGithubToken,
  __clearTokenCache,
} from "@/lib/github-app/token";
import type { GithubInstallation } from "@/lib/github-app/storage";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const APP_CONFIG = { appId: "999", privateKeyPem: privateKey };
const FIXED = 1_700_000_000_000;

function installation(workspaceId = "ws1"): GithubInstallation {
  return {
    workspaceId,
    installationId: "42424242",
    accountLogin: "acme",
    linkedAt: new Date(FIXED).toISOString(),
    linkedBy: "u1",
  };
}

function tokenResponse(token: string, expiresAtMs: number, status = 201): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({
      token,
      expires_at: new Date(expiresAtMs).toISOString(),
    }),
  } as unknown as Response;
}

beforeEach(() => {
  __clearTokenCache();
});

describe("mintInstallationToken", () => {
  it("exchanges the App JWT for an installation token at the right URL", async () => {
    const fetchImpl = jest.fn(async () =>
      tokenResponse("ghs_install_tok", FIXED + 3600_000),
    );
    const tok = await mintInstallationToken("ws1", {
      appConfig: APP_CONFIG,
      loadInstallation: async () => installation(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => FIXED,
    });
    expect(tok).toBe("ghs_install_tok");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      { method: string; headers: Record<string, string> },
    ];
    expect(url).toBe("https://api.github.com/app/installations/42424242/access_tokens");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toMatch(/^Bearer .+\..+\..+$/); // App JWT
  });

  it("caches the token: a second call within TTL does not re-fetch", async () => {
    const fetchImpl = jest.fn(async () =>
      tokenResponse("tok_cached", FIXED + 3600_000),
    );
    const deps = {
      appConfig: APP_CONFIG,
      loadInstallation: async () => installation(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => FIXED,
    };
    const a = await mintInstallationToken("ws1", deps);
    const b = await mintInstallationToken("ws1", deps);
    expect(a).toBe("tok_cached");
    expect(b).toBe("tok_cached");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("re-fetches after the cached token expires (minus skew)", async () => {
    let mintCount = 0;
    const fetchImpl = jest.fn(async () => {
      mintCount += 1;
      return tokenResponse(`tok_${mintCount}`, FIXED + 3600_000);
    });
    const first = await mintInstallationToken("ws1", {
      appConfig: APP_CONFIG,
      loadInstallation: async () => installation(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => FIXED,
    });
    expect(first).toBe("tok_1");
    // Advance the clock past expiry (1h + skew).
    const later = FIXED + 3600_000 + 120_000;
    const second = await mintInstallationToken("ws1", {
      appConfig: APP_CONFIG,
      loadInstallation: async () => installation(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => later,
    });
    expect(second).toBe("tok_2");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("returns null when the App is not configured", async () => {
    const fetchImpl = jest.fn();
    const tok = await mintInstallationToken("ws1", {
      appConfig: null,
      loadInstallation: async () => installation(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => FIXED,
    });
    expect(tok).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns null when the workspace has no installation", async () => {
    const fetchImpl = jest.fn();
    const tok = await mintInstallationToken("ws1", {
      appConfig: APP_CONFIG,
      loadInstallation: async () => null,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => FIXED,
    });
    expect(tok).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns null on a GitHub non-2xx response", async () => {
    const fetchImpl = jest.fn(async () =>
      ({ ok: false, status: 403, json: async () => ({}) }) as unknown as Response,
    );
    const tok = await mintInstallationToken("ws1", {
      appConfig: APP_CONFIG,
      loadInstallation: async () => installation(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => FIXED,
    });
    expect(tok).toBeNull();
  });

  it("returns null when fetch throws", async () => {
    const fetchImpl = jest.fn(async () => {
      throw new Error("network down");
    });
    const tok = await mintInstallationToken("ws1", {
      appConfig: APP_CONFIG,
      loadInstallation: async () => installation(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => FIXED,
    });
    expect(tok).toBeNull();
  });

  it("returns null on a malformed body (no token field)", async () => {
    const fetchImpl = jest.fn(async () =>
      ({ ok: true, status: 201, json: async () => ({ nope: true }) }) as unknown as Response,
    );
    const tok = await mintInstallationToken("ws1", {
      appConfig: APP_CONFIG,
      loadInstallation: async () => installation(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => FIXED,
    });
    expect(tok).toBeNull();
  });
});

describe("resolveGithubToken fallback matrix", () => {
  const origPat = process.env.GITHUB_TOKEN_WOLFPACK_AGENCY;
  afterEach(() => {
    if (origPat === undefined) delete process.env.GITHUB_TOKEN_WOLFPACK_AGENCY;
    else process.env.GITHUB_TOKEN_WOLFPACK_AGENCY = origPat;
    __clearTokenCache();
  });

  it("app + installation + success → installation token", async () => {
    process.env.GITHUB_TOKEN_WOLFPACK_AGENCY = "pat-xxx";
    const fetchImpl = jest.fn(async () =>
      tokenResponse("ghs_scoped", FIXED + 3600_000),
    );
    const tok = await resolveGithubToken("ws1", {
      appConfig: APP_CONFIG,
      loadInstallation: async () => installation(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => FIXED,
    });
    expect(tok).toBe("ghs_scoped");
  });

  it("no app env → PAT", async () => {
    process.env.GITHUB_TOKEN_WOLFPACK_AGENCY = "pat-fallback";
    const tok = await resolveGithubToken("ws1", {
      appConfig: null,
      loadInstallation: async () => installation(),
      now: () => FIXED,
    });
    expect(tok).toBe("pat-fallback");
  });

  it("app env but no installation → PAT", async () => {
    process.env.GITHUB_TOKEN_WOLFPACK_AGENCY = "pat-fallback";
    const tok = await resolveGithubToken("ws1", {
      appConfig: APP_CONFIG,
      loadInstallation: async () => null,
      now: () => FIXED,
    });
    expect(tok).toBe("pat-fallback");
  });

  it("App error (GitHub 500) → PAT", async () => {
    process.env.GITHUB_TOKEN_WOLFPACK_AGENCY = "pat-fallback";
    const fetchImpl = jest.fn(async () =>
      ({ ok: false, status: 500, json: async () => ({}) }) as unknown as Response,
    );
    const tok = await resolveGithubToken("ws1", {
      appConfig: APP_CONFIG,
      loadInstallation: async () => installation(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => FIXED,
    });
    expect(tok).toBe("pat-fallback");
  });

  it("no workspaceId → PAT (no App work attempted)", async () => {
    process.env.GITHUB_TOKEN_WOLFPACK_AGENCY = "pat-fallback";
    const loadInstallation = jest.fn(async () => installation());
    const tok = await resolveGithubToken(null, {
      appConfig: APP_CONFIG,
      loadInstallation: loadInstallation as unknown as (
        w: string,
      ) => Promise<GithubInstallation | null>,
      now: () => FIXED,
    });
    expect(tok).toBe("pat-fallback");
    expect(loadInstallation).not.toHaveBeenCalled();
  });

  it("never logs the private key or the minted token", async () => {
    process.env.GITHUB_TOKEN_WOLFPACK_AGENCY = "pat-xxx";
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const log = jest.spyOn(console, "log").mockImplementation(() => {});
    const fetchImpl = jest.fn(async () =>
      tokenResponse("ghs_secret_tok", FIXED + 3600_000),
    );
    await resolveGithubToken("ws1", {
      appConfig: APP_CONFIG,
      loadInstallation: async () => installation(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => FIXED,
    });
    const all = [...warn.mock.calls, ...log.mock.calls].flat().join(" ");
    expect(all).not.toContain("ghs_secret_tok");
    expect(all).not.toContain("BEGIN PRIVATE KEY");
    warn.mockRestore();
    log.mockRestore();
  });
});
