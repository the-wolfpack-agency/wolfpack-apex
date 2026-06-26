/**
 * Tests for authenticated session establishment.
 *
 * The login network call is mocked via an injected fetch. Covers the happy path
 * (200 + Set-Cookie → name=value pair), a custom cookie name, and every failure
 * mode that must degrade to null (401, network throw, no matching cookie). All
 * paths assert the function never throws.
 */

import { establishSession, establishOAuthPasswordSession } from "../session";

const BASE = "https://target.example.com";
const LOGIN = "/api/auth/login";

/** Build a minimal Response-like object with a Headers carrying Set-Cookie(s). */
function res(status: number, setCookies: string[] = []): Response {
  const headers = new Headers();
  for (const c of setCookies) headers.append("set-cookie", c);
  return { status, headers } as Response;
}

const baseInput = {
  baseUrl: BASE,
  loginPath: LOGIN,
  username: "ops@example.com",
  password: "hunter2",
};

it("returns name=value for a 200 login whose set-cookie names the session cookie", async () => {
  const fetchImpl = jest.fn().mockResolvedValue(res(200, ["session=abc; HttpOnly; Path=/"]));
  const out = await establishSession({ ...baseInput, fetchImpl: fetchImpl as unknown as typeof fetch });
  expect(out).toEqual({ cookie: "session=abc" });
});

it("sends email + password as JSON to baseUrl+loginPath", async () => {
  const fetchImpl = jest.fn().mockResolvedValue(res(200, ["session=abc; Path=/"]));
  await establishSession({ ...baseInput, fetchImpl: fetchImpl as unknown as typeof fetch });
  expect(fetchImpl).toHaveBeenCalledWith(
    `${BASE}${LOGIN}`,
    expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ "Content-Type": "application/json" }),
      body: JSON.stringify({ email: "ops@example.com", password: "hunter2" }),
    }),
  );
});

it("honors a custom sessionCookieName", async () => {
  const fetchImpl = jest
    .fn()
    .mockResolvedValue(res(200, ["foo=1; Path=/", "wp_sess=xyz789; HttpOnly; Secure"]));
  const out = await establishSession({
    ...baseInput,
    sessionCookieName: "wp_sess",
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  expect(out).toEqual({ cookie: "wp_sess=xyz789" });
});

it("picks the right cookie when multiple Set-Cookie headers are returned", async () => {
  const fetchImpl = jest
    .fn()
    .mockResolvedValue(res(200, ["csrf=tok; Path=/", "session=deadbeef; HttpOnly", "other=z"]));
  const out = await establishSession({ ...baseInput, fetchImpl: fetchImpl as unknown as typeof fetch });
  expect(out).toEqual({ cookie: "session=deadbeef" });
});

it("returns null on a 401 (bad credentials)", async () => {
  const fetchImpl = jest.fn().mockResolvedValue(res(401, ["session=should-not-be-used"]));
  const out = await establishSession({ ...baseInput, fetchImpl: fetchImpl as unknown as typeof fetch });
  expect(out).toBeNull();
});

it("returns null on a network throw (never throws)", async () => {
  const fetchImpl = jest.fn().mockRejectedValue(new Error("ECONNREFUSED"));
  const out = await establishSession({ ...baseInput, fetchImpl: fetchImpl as unknown as typeof fetch });
  expect(out).toBeNull();
});

it("returns null on a 200 with no matching cookie", async () => {
  const fetchImpl = jest.fn().mockResolvedValue(res(200, ["unrelated=1; Path=/"]));
  const out = await establishSession({ ...baseInput, fetchImpl: fetchImpl as unknown as typeof fetch });
  expect(out).toBeNull();
});

it("returns null on a 200 with no Set-Cookie at all", async () => {
  const fetchImpl = jest.fn().mockResolvedValue(res(200, []));
  const out = await establishSession({ ...baseInput, fetchImpl: fetchImpl as unknown as typeof fetch });
  expect(out).toBeNull();
});

/**
 * Tests for the OAuth 2.0 Resource Owner Password token exchange. The token
 * endpoint is mocked via an injected fetch. Covers the happy path (200 →
 * bearer header + instance URL), the instance_url fallback, and every failure
 * mode that must degrade to null (400 invalid_grant, network throw, missing
 * access_token). All paths assert the function never throws.
 */

const OAUTH_BASE = "https://test.salesforce.com";
const OAUTH_PATH = "/services/oauth2/token";

/** Build a Response-like object that returns the given JSON body. */
function jsonRes(status: number, body: unknown): Response {
  return {
    status,
    json: async () => body,
  } as unknown as Response;
}

const oauthInput = {
  baseUrl: OAUTH_BASE,
  loginPath: OAUTH_PATH,
  clientId: "3MVG9client",
  clientSecret: "secret-shhh",
  username: "agent@example.com",
  password: "hunter2",
};

it("returns bearer header + instance URL for a 200 token response", async () => {
  const fetchImpl = jest.fn().mockResolvedValue(
    jsonRes(200, {
      access_token: "00Dxx!AR",
      instance_url: "https://myorg.my.salesforce.com",
    }),
  );
  const out = await establishOAuthPasswordSession({
    ...oauthInput,
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  expect(out).toEqual({
    authHeader: "Bearer 00Dxx!AR",
    instanceUrl: "https://myorg.my.salesforce.com",
  });
});

it("POSTs a form-urlencoded grant_type=password body to baseUrl+loginPath", async () => {
  const fetchImpl = jest
    .fn()
    .mockResolvedValue(jsonRes(200, { access_token: "tok", instance_url: "https://i.example.com" }));
  await establishOAuthPasswordSession({
    ...oauthInput,
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  expect(fetchImpl).toHaveBeenCalledWith(
    `${OAUTH_BASE}${OAUTH_PATH}`,
    expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({
        "Content-Type": "application/x-www-form-urlencoded",
      }),
    }),
  );
  const sentBody = (fetchImpl.mock.calls[0][1] as { body: string }).body;
  const params = new URLSearchParams(sentBody);
  expect(params.get("grant_type")).toBe("password");
  expect(params.get("client_id")).toBe("3MVG9client");
  expect(params.get("username")).toBe("agent@example.com");
});

it("falls back instanceUrl to baseUrl when instance_url is absent", async () => {
  const fetchImpl = jest.fn().mockResolvedValue(jsonRes(200, { access_token: "tok-only" }));
  const out = await establishOAuthPasswordSession({
    ...oauthInput,
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  expect(out).toEqual({ authHeader: "Bearer tok-only", instanceUrl: OAUTH_BASE });
});

it("returns null on a 400 invalid_grant (bad credentials)", async () => {
  const fetchImpl = jest.fn().mockResolvedValue(
    jsonRes(400, { error: "invalid_grant", error_description: "authentication failure" }),
  );
  const out = await establishOAuthPasswordSession({
    ...oauthInput,
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  expect(out).toBeNull();
});

it("returns null on a network throw (never throws)", async () => {
  const fetchImpl = jest.fn().mockRejectedValue(new Error("ECONNREFUSED"));
  const out = await establishOAuthPasswordSession({
    ...oauthInput,
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  expect(out).toBeNull();
});

it("returns null on a 200 missing access_token", async () => {
  const fetchImpl = jest
    .fn()
    .mockResolvedValue(jsonRes(200, { instance_url: "https://myorg.my.salesforce.com" }));
  const out = await establishOAuthPasswordSession({
    ...oauthInput,
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  expect(out).toBeNull();
});

it("returns null on an invalid JSON body (json() throws)", async () => {
  const fetchImpl = jest.fn().mockResolvedValue({
    status: 200,
    json: async () => {
      throw new SyntaxError("Unexpected token < in JSON");
    },
  } as unknown as Response);
  const out = await establishOAuthPasswordSession({
    ...oauthInput,
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  expect(out).toBeNull();
});
