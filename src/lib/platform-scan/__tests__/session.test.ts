/**
 * Tests for authenticated session establishment.
 *
 * The login network call is mocked via an injected fetch. Covers the happy path
 * (200 + Set-Cookie → name=value pair), a custom cookie name, and every failure
 * mode that must degrade to null (401, network throw, no matching cookie). All
 * paths assert the function never throws.
 */

import { establishSession } from "../session";

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
