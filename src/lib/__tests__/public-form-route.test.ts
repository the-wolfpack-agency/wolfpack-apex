/**
 * /api/public/forms/[siteId]/submit route tests.
 *
 * Mocks @/lib/site-forms so the route logic is exercised in isolation —
 * status mapping, CORS headers, body parsing, IP hashing. The full
 * submit-flow branching is covered separately in site-forms.test.ts.
 */

const mockSubmit = jest.fn();
const mockGetSite = jest.fn();
const mockListVerified = jest.fn();

jest.mock("@/lib/site-forms", () => {
  const actual = jest.requireActual("@/lib/site-forms");
  return {
    ...actual,
    submitForm: (...args: unknown[]) => mockSubmit(...args),
    defaultGetSite: (...args: unknown[]) => mockGetSite(...args),
    defaultListVerifiedDomains: (...args: unknown[]) => mockListVerified(...args),
  };
});

import { NextRequest } from "next/server";
import { POST, OPTIONS } from "@/app/api/public/forms/[siteId]/submit/route";

function req(
  method: string,
  body?: unknown,
  opts: {
    origin?: string;
    xff?: string;
    contentType?: string;
    raw?: string;
  } = {},
): NextRequest {
  const headers: Record<string, string> = {
    "content-type": opts.contentType ?? "application/json",
  };
  if (opts.origin !== undefined) headers["origin"] = opts.origin;
  if (opts.xff) headers["x-forwarded-for"] = opts.xff;
  const url = "http://test/api/public/forms/site_1/submit";
  const bodyStr =
    method === "GET" || method === "OPTIONS"
      ? undefined
      : opts.raw ?? (body === undefined ? undefined : JSON.stringify(body));
  // NextRequest's RequestInit is a superset of the DOM one; cast via
  // `unknown` to dodge the structural mismatch. Runtime shape matches.
  const init = {
    method,
    headers,
    ...(bodyStr === undefined ? {} : { body: bodyStr }),
  } as unknown as ConstructorParameters<typeof NextRequest>[1];
  return new NextRequest(url, init);
}

const params = Promise.resolve({ siteId: "site_1" });

beforeEach(() => {
  jest.clearAllMocks();
  mockGetSite.mockResolvedValue({
    id: "site_1",
    client_slug: "acme",
    display_name: "Acme",
    preview_url: "https://wolfpack-acme.vercel.app",
    brief: { client: "acme", product: { name: "Acme" }, pages: [] },
  });
  mockListVerified.mockResolvedValue([]);
});

describe("POST /api/public/forms/[siteId]/submit", () => {
  it("200 + submissionId on ok", async () => {
    mockSubmit.mockResolvedValueOnce({
      ok: true,
      reason: "ok",
      submissionId: "sub_123",
    });
    const res = await POST(
      req("POST", { name: "Jane", email: "j@x.com", message: "hi" }, {
        origin: "https://wolfpack-acme.vercel.app",
      }),
      { params },
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.submissionId).toBe("sub_123");
  });

  it("403 on origin_not_allowed", async () => {
    mockSubmit.mockResolvedValueOnce({
      ok: false,
      reason: "origin_not_allowed",
    });
    const res = await POST(
      req("POST", { name: "x" }, { origin: "https://evil.com" }),
      { params },
    );
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe("origin_not_allowed");
  });

  it("429 + Retry-After header on rate_limited", async () => {
    mockSubmit.mockResolvedValueOnce({
      ok: false,
      reason: "rate_limited",
      retryAfterSec: 90,
    });
    const res = await POST(
      req("POST", { name: "x" }, { origin: "https://wolfpack-acme.vercel.app" }),
      { params },
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("90");
  });

  it("400 on missing_required_field", async () => {
    mockSubmit.mockResolvedValueOnce({
      ok: false,
      reason: "missing_required_field",
    });
    const res = await POST(
      req("POST", { name: "x" }, { origin: "https://wolfpack-acme.vercel.app" }),
      { params },
    );
    expect(res.status).toBe(400);
  });

  it("400 on unexpected_field", async () => {
    mockSubmit.mockResolvedValueOnce({
      ok: false,
      reason: "unexpected_field",
    });
    const res = await POST(
      req("POST", { foo: "bar" }, { origin: "https://wolfpack-acme.vercel.app" }),
      { params },
    );
    expect(res.status).toBe(400);
  });

  it("413 on too_many_fields", async () => {
    mockSubmit.mockResolvedValueOnce({ ok: false, reason: "too_many_fields" });
    const res = await POST(
      req("POST", { x: "y" }, { origin: "https://wolfpack-acme.vercel.app" }),
      { params },
    );
    expect(res.status).toBe(413);
  });

  it("404 on site_not_found", async () => {
    mockSubmit.mockResolvedValueOnce({ ok: false, reason: "site_not_found" });
    const res = await POST(
      req("POST", { x: "y" }, { origin: "https://wolfpack-acme.vercel.app" }),
      { params },
    );
    expect(res.status).toBe(404);
  });

  it("409 on no_contact_form", async () => {
    mockSubmit.mockResolvedValueOnce({ ok: false, reason: "no_contact_form" });
    const res = await POST(
      req("POST", { x: "y" }, { origin: "https://wolfpack-acme.vercel.app" }),
      { params },
    );
    expect(res.status).toBe(409);
  });

  it("503 on no_recipient", async () => {
    mockSubmit.mockResolvedValueOnce({ ok: false, reason: "no_recipient" });
    const res = await POST(
      req("POST", { x: "y" }, { origin: "https://wolfpack-acme.vercel.app" }),
      { params },
    );
    expect(res.status).toBe(503);
  });

  it("200 + decoy body on honeypot_tripped (don't tip off the bot)", async () => {
    mockSubmit.mockResolvedValueOnce({
      ok: true,
      reason: "honeypot_tripped",
      spamScore: 100,
    });
    const res = await POST(
      req(
        "POST",
        { name: "Jane", _hp_website: "bot" },
        { origin: "https://wolfpack-acme.vercel.app" },
      ),
      { params },
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    // Body must NOT reveal honeypot — no `submissionId`, no `reason`.
    expect(json.submissionId).toBeUndefined();
  });

  it("parses application/x-www-form-urlencoded body", async () => {
    mockSubmit.mockResolvedValueOnce({
      ok: true,
      reason: "ok",
      submissionId: "sub_u",
    });
    await POST(
      req(
        "POST",
        undefined,
        {
          origin: "https://wolfpack-acme.vercel.app",
          contentType: "application/x-www-form-urlencoded",
          raw: "name=Jane&email=j%40x.com&message=hello",
        },
      ),
      { params },
    );
    const call = mockSubmit.mock.calls[0][0];
    expect(call.payload.name).toBe("Jane");
    expect(call.payload.email).toBe("j@x.com");
    expect(call.payload.message).toBe("hello");
  });

  it("hashes IP via X-Forwarded-For + salt, never passes raw IP", async () => {
    mockSubmit.mockResolvedValueOnce({
      ok: true,
      reason: "ok",
      submissionId: "sub_i",
    });
    process.env.INSTINCT_IP_HASH_SALT = "test-salt";
    await POST(
      req(
        "POST",
        { name: "Jane", email: "j@x.com", message: "hi" },
        {
          origin: "https://wolfpack-acme.vercel.app",
          xff: "203.0.113.5, 10.0.0.1",
        },
      ),
      { params },
    );
    const call = mockSubmit.mock.calls[0][0];
    expect(call.ipHash).toMatch(/^[a-f0-9]{64}$/);
    // Raw IP should NOT appear anywhere in the forwarded input
    expect(JSON.stringify(call)).not.toContain("203.0.113.5");
    delete process.env.INSTINCT_IP_HASH_SALT;
  });
});

describe("OPTIONS preflight", () => {
  it("echoes Origin when it matches the allowlist", async () => {
    mockGetSite.mockResolvedValueOnce({
      id: "site_1",
      client_slug: "acme",
      display_name: "Acme",
      preview_url: "https://wolfpack-acme.vercel.app",
      brief: { client: "acme", product: { name: "Acme" }, pages: [] },
    });
    mockListVerified.mockResolvedValueOnce([]);
    const res = await OPTIONS(
      req("OPTIONS", undefined, { origin: "https://wolfpack-acme.vercel.app" }),
      { params },
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://wolfpack-acme.vercel.app",
    );
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("POST");
  });

  it("does NOT echo Origin when it's not in the allowlist", async () => {
    mockGetSite.mockResolvedValueOnce({
      id: "site_1",
      client_slug: "acme",
      display_name: "Acme",
      preview_url: "https://wolfpack-acme.vercel.app",
      brief: { client: "acme", product: { name: "Acme" }, pages: [] },
    });
    mockListVerified.mockResolvedValueOnce([]);
    const res = await OPTIONS(
      req("OPTIONS", undefined, { origin: "https://evil.example.com" }),
      { params },
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("echoes Origin for verified custom domain", async () => {
    mockGetSite.mockResolvedValueOnce({
      id: "site_1",
      client_slug: "acme",
      display_name: "Acme",
      preview_url: null,
      brief: { client: "acme", product: { name: "Acme" }, pages: [] },
    });
    mockListVerified.mockResolvedValueOnce(["acme.com"]);
    const res = await OPTIONS(
      req("OPTIONS", undefined, { origin: "https://acme.com" }),
      { params },
    );
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://acme.com",
    );
  });
});
