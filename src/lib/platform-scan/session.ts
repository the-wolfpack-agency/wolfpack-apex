/**
 * Authenticated session establishment for platform-scan.
 *
 * Some target surfaces only reveal their real behavior once you are logged in:
 * an admin journey, a write API, a gated dashboard. To exercise those, the scan
 * needs a session cookie. `establishSession` performs a username/password login
 * against the target and extracts the session cookie from the `Set-Cookie`
 * response, returning a ready-to-send `name=value` pair for a `Cookie:` request
 * header.
 *
 * Beyond's login endpoint takes `{ email, password }`, so the stored username is
 * sent as `email`. This is a credential-bearing network call against an EXTERNAL
 * target, so it degrades gracefully in every failure mode: a non-2xx response, a
 * missing/mismatched cookie, a network error, or a timeout all yield `null`. It
 * NEVER throws — a failed login simply means the authenticated checks are
 * skipped, not that the whole scan aborts.
 */

/** Default cookie name a session lives under when the caller doesn't specify. */
const DEFAULT_SESSION_COOKIE = "session";

/** Login request timeout. */
const DEFAULT_LOGIN_TIMEOUT_MS = 8000;

/**
 * Input for an OAuth 2.0 Resource Owner Password Credentials token exchange,
 * the Salesforce-style flow where an agent trades a client credential pair plus
 * a user's username/password for a bearer token and an instance URL to operate
 * against.
 */
export interface EstablishOAuthPasswordSessionInput {
  /** Token-endpoint origin, e.g. "https://test.salesforce.com". */
  baseUrl: string;
  /** Token-endpoint path, e.g. "/services/oauth2/token". */
  loginPath: string;
  clientId: string;
  clientSecret: string;
  username: string;
  password: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Token request timeout. Default 8000ms. */
  timeoutMs?: number;
}

export interface EstablishSessionInput {
  baseUrl: string;
  loginPath: string;
  username: string;
  password: string;
  /** Name of the cookie that carries the session. Default "session". */
  sessionCookieName?: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Login request timeout. Default 8000ms. */
  timeoutMs?: number;
}

/**
 * Input for a NextAuth.js / Auth.js Credentials provider login. These apps
 * don't take a simple JSON `{ email, password }` POST; they require a two-step
 * CSRF-protected flow: fetch a CSRF token (which also sets a CSRF cookie), then
 * POST the credentials as a urlencoded form (carrying that CSRF cookie + token)
 * to the credentials callback, which on success sets a session-token cookie.
 */
export interface EstablishNextAuthSessionInput {
  /** Target origin, e.g. "https://app.example.com". */
  baseUrl: string;
  /** Credentials callback path. Default "/api/auth/callback/credentials". */
  loginPath?: string;
  /** CSRF token path. Default "/api/auth/csrf". */
  csrfPath?: string;
  username: string;
  password: string;
  /** Unused by the NextAuth flow (the session cookie name is fixed by the
   *  framework and matched by pattern), accepted for call-site symmetry with
   *  the other establishers. */
  sessionCookieName?: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Login request timeout. Default 8000ms. */
  timeoutMs?: number;
}

/** NextAuth/Auth.js CSRF cookie name across versions + prefixes. */
const NEXTAUTH_CSRF_COOKIE = /^(__Host-|__Secure-)?(next-auth|authjs)\.csrf-token$/;
/** NextAuth/Auth.js session-token cookie name across versions + prefixes. */
const NEXTAUTH_SESSION_COOKIE = /^(__Secure-)?(next-auth|authjs)\.session-token$/;

const DEFAULT_NEXTAUTH_CSRF_PATH = "/api/auth/csrf";
const DEFAULT_NEXTAUTH_LOGIN_PATH = "/api/auth/callback/credentials";

/**
 * Pull the first `name=value` pair off a list of raw Set-Cookie strings whose
 * cookie name matches a pattern. Mirrors extractCookiePair but matches by
 * regex (NextAuth cookie names vary by version / Secure prefix). Returns the
 * matched `{ name, pair }` or null.
 */
function extractCookieByPattern(
  setCookies: string[],
  pattern: RegExp,
): { name: string; pair: string } | null {
  for (const raw of setCookies) {
    if (!raw) continue;
    for (const part of raw.split(/,(?=\s*[^;,\s]+=)/)) {
      const first = part.split(";")[0]?.trim();
      if (!first) continue;
      const eq = first.indexOf("=");
      if (eq <= 0) continue;
      const cookieName = first.slice(0, eq).trim();
      if (!pattern.test(cookieName)) continue;
      const cookieValue = first.slice(eq + 1).trim();
      return { name: cookieName, pair: `${cookieName}=${cookieValue}` };
    }
  }
  return null;
}

/**
 * Collect every `name=value` pair from a list of raw Set-Cookie strings,
 * dropping cookie attributes (Path, HttpOnly, …). Returns them joined as a
 * single `name=value; name=value` string ready for a Cookie request header.
 */
function collectAllCookiePairs(setCookies: string[]): string {
  const pairs: string[] = [];
  for (const raw of setCookies) {
    if (!raw) continue;
    for (const part of raw.split(/,(?=\s*[^;,\s]+=)/)) {
      const first = part.split(";")[0]?.trim();
      if (!first) continue;
      const eq = first.indexOf("=");
      if (eq <= 0) continue;
      pairs.push(first);
    }
  }
  return pairs.join("; ");
}

/**
 * Pull the value of a named cookie out of a list of raw `Set-Cookie` strings.
 *
 * Each Set-Cookie looks like `name=value; HttpOnly; Path=/; ...`. We take the
 * first segment (before the first `;`), split on the FIRST `=` (values can
 * themselves contain `=`, e.g. base64), and match the name case-sensitively.
 * Returns the `name=value` pair (no attributes) ready for a Cookie header, or
 * null if no Set-Cookie names the target cookie.
 */
function extractCookiePair(setCookies: string[], name: string): string | null {
  for (const raw of setCookies) {
    if (!raw) continue;
    // A single header value may carry multiple cookies joined by ", " in some
    // runtimes; getSetCookie() splits them, but be defensive for the fallback.
    for (const part of raw.split(/,(?=\s*[^;,\s]+=)/)) {
      const first = part.split(";")[0]?.trim();
      if (!first) continue;
      const eq = first.indexOf("=");
      if (eq <= 0) continue;
      const cookieName = first.slice(0, eq).trim();
      if (cookieName !== name) continue;
      const cookieValue = first.slice(eq + 1).trim();
      return `${cookieName}=${cookieValue}`;
    }
  }
  return null;
}

/**
 * Read all raw Set-Cookie strings off a Headers, robust across runtimes. In
 * Node/undici multiple Set-Cookie headers are joined into one string by
 * `get("set-cookie")`, which corrupts cookies; `getSetCookie()` returns them
 * un-joined as an array, so prefer it when available.
 */
function readSetCookies(headers: Headers): string[] {
  const viaGetter = (headers as { getSetCookie?: () => string[] }).getSetCookie?.();
  if (viaGetter && viaGetter.length > 0) return viaGetter;
  const single = headers.get("set-cookie");
  return single ? [single] : [];
}

/**
 * Log into a target platform and return its session cookie as a `name=value`
 * pair for a Cookie request header, or null on any failure.
 */
export async function establishSession(
  input: EstablishSessionInput,
): Promise<{ cookie: string } | null> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const cookieName = input.sessionCookieName ?? DEFAULT_SESSION_COOKIE;
  const timeoutMs = input.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS;
  const url = `${input.baseUrl}${input.loginPath}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: input.username, password: input.password }),
      signal: controller.signal,
      redirect: "manual",
    });

    if (res.status < 200 || res.status >= 300) return null;

    const pair = extractCookiePair(readSetCookies(res.headers), cookieName);
    return pair ? { cookie: pair } : null;
  } catch {
    // Network error, abort/timeout, or a malformed response — degrade to null.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Perform an OAuth 2.0 Resource Owner Password Credentials token exchange
 * (Salesforce-style) and return a ready-to-send bearer auth header plus the
 * instance URL the token operates against, or null on any failure.
 *
 * POSTs a `grant_type=password` form to `${baseUrl}${loginPath}` (e.g.
 * https://test.salesforce.com/services/oauth2/token) with the client credential
 * pair and the user's username/password. On a 2xx JSON body carrying an
 * `access_token`, returns `{ authHeader: "Bearer <token>", instanceUrl }` —
 * preferring the provider's `instance_url`, falling back to `baseUrl` when the
 * provider doesn't return one.
 *
 * Like `establishSession`, this is a credential-bearing call against an EXTERNAL
 * target and degrades gracefully in every failure mode: a non-2xx response
 * (Salesforce returns 400 `{ error, error_description }` on bad creds), a
 * missing `access_token`, invalid JSON, a network error, or a timeout all yield
 * `null`. It NEVER throws.
 */
export async function establishOAuthPasswordSession(
  input: EstablishOAuthPasswordSessionInput,
): Promise<{ authHeader: string; instanceUrl: string } | null> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS;
  const url = `${input.baseUrl}${input.loginPath}`;

  const body = new URLSearchParams({
    grant_type: "password",
    client_id: input.clientId,
    client_secret: input.clientSecret,
    username: input.username,
    password: input.password,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: controller.signal,
      redirect: "manual",
    });

    if (res.status < 200 || res.status >= 300) return null;

    const data = (await res.json()) as {
      access_token?: unknown;
      instance_url?: unknown;
    };

    const accessToken = data?.access_token;
    if (typeof accessToken !== "string" || accessToken.length === 0) return null;

    const instanceUrl =
      typeof data.instance_url === "string" && data.instance_url.length > 0
        ? data.instance_url
        : input.baseUrl;

    return { authHeader: `Bearer ${accessToken}`, instanceUrl };
  } catch {
    // Network error, abort/timeout, or invalid JSON - degrade to null.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Log into a NextAuth.js / Auth.js app that uses the Credentials provider and
 * return its full set of session cookies as a `name=value; name=value` string
 * for a Cookie request header, or null on any failure.
 *
 * The flow (a CSRF-protected double-submit, exactly as the framework expects):
 *   1. GET `${baseUrl}${csrfPath}` → JSON `{ csrfToken }`, and capture the CSRF
 *      cookie it sets (name matches NEXTAUTH_CSRF_COOKIE).
 *   2. POST `${baseUrl}${loginPath}` as application/x-www-form-urlencoded,
 *      replaying the CSRF cookie and sending `csrfToken`, `callbackUrl`,
 *      `json=true`, plus the credentials. Credential field names vary by
 *      provider, so the stored username is sent under BOTH `email` and
 *      `username` along with `password`.
 *   3. Success = the callback response sets a session-token cookie (name matches
 *      NEXTAUTH_SESSION_COOKIE). We return ALL the callback's Set-Cookie pairs
 *      joined, so both the session token and any refreshed CSRF cookie ride
 *      along on subsequent authenticated requests.
 *
 * Like the other establishers, this is a credential-bearing call against an
 * EXTERNAL target and degrades gracefully in every failure mode: a missing
 * csrfToken, a non-2xx callback with no session cookie, no session-token in the
 * response, a network error, or a timeout all yield `null`. It NEVER throws,
 * and it NEVER logs the credentials or the cookies.
 */
export async function establishNextAuthSession(
  input: EstablishNextAuthSessionInput,
): Promise<{ cookie: string } | null> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS;
  const csrfPath = input.csrfPath ?? DEFAULT_NEXTAUTH_CSRF_PATH;
  const loginPath = input.loginPath ?? DEFAULT_NEXTAUTH_LOGIN_PATH;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // Step 1 - CSRF token + cookie.
    const csrfRes = await fetchImpl(`${input.baseUrl}${csrfPath}`, {
      method: "GET",
      signal: controller.signal,
      redirect: "manual",
    });
    if (csrfRes.status < 200 || csrfRes.status >= 300) return null;

    const csrfData = (await csrfRes.json()) as { csrfToken?: unknown };
    const csrfToken = csrfData?.csrfToken;
    if (typeof csrfToken !== "string" || csrfToken.length === 0) return null;

    const csrfCookie = extractCookieByPattern(
      readSetCookies(csrfRes.headers),
      NEXTAUTH_CSRF_COOKIE,
    );
    if (!csrfCookie) return null;

    // Step 2 - credentials callback. Send the username under both common
    // credential field names so the flow is robust to the provider's config.
    const body = new URLSearchParams({
      csrfToken,
      callbackUrl: input.baseUrl,
      json: "true",
      email: input.username,
      username: input.username,
      password: input.password,
    });

    const callbackRes = await fetchImpl(`${input.baseUrl}${loginPath}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: csrfCookie.pair,
      },
      body: body.toString(),
      signal: controller.signal,
      redirect: "manual",
    });

    // Step 3 - success is determined by the presence of a session-token cookie,
    // not the status code (NextAuth often 302s or 200s on a successful login).
    const setCookies = readSetCookies(callbackRes.headers);
    const session = extractCookieByPattern(setCookies, NEXTAUTH_SESSION_COOKIE);
    if (!session) return null;

    return { cookie: collectAllCookiePairs(setCookies) };
  } catch {
    // Network error, abort/timeout, or invalid JSON - degrade to null.
    return null;
  } finally {
    clearTimeout(timer);
  }
}
