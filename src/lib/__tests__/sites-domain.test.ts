/**
 * sites-domain.ts — Vercel Domains API wrapper tests.
 *
 * Mocks the injected `fetchImpl` so we never touch the real Vercel API.
 * Covers every branch described in the spec:
 *   - add success
 *   - add invalid-shape domain (regex gate)
 *   - add → 409 domain_already_in_use
 *   - add → 401 unauthorized
 *   - status verified vs pending
 *   - status 404 → null
 *   - remove success
 *   - remove 404 idempotent
 *   - 429 rate limit bubbles up as "rate_limited"
 *   - network error classified as "network"
 *   - isValidDomain edge cases
 */

import {
  addDomainToProject,
  getDomainStatus,
  removeDomainFromProject,
  isValidDomain,
  classifyVercelError,
  httpStatusForCode,
  VercelDomainError,
} from "@/lib/sites-domain";

function mkResponse(
  status: number,
  body: unknown = {},
  opts: { contentType?: string } = {},
): Response {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({
      "content-type": opts.contentType ?? "application/json",
    }),
    json: async () => (typeof body === "string" ? {} : body),
    text: async () => text,
  } as unknown as Response;
}

const BASE = {
  projectId: "prj_123",
  teamId: "team_abc",
  token: "tok_xyz",
};

describe("isValidDomain", () => {
  it.each([
    ["acme.com", true],
    ["www.acme.com", true],
    ["site-alpha.co.uk", true],
    ["a.b.c.io", true],
    ["x.ai", true],
  ])("accepts %s", (input, expected) => {
    expect(isValidDomain(input)).toBe(expected);
  });

  it.each([
    ["", false],
    ["localhost", false],
    ["192.168.0.1", false],
    ["a.b", false], // TLD must be ≥2 alpha chars
    ["-acme.com", false],
    ["acme-.com", false],
    [".acme.com", false],
    ["acme..com", false],
    [`${"a".repeat(254)}.com`, false],
    [null, false],
    [undefined, false],
    [42, false],
  ])("rejects %s", (input, expected) => {
    expect(isValidDomain(input)).toBe(expected);
  });

  it("accepts uppercase input (normalized to lowercase before regex)", () => {
    // DNS is case-insensitive; we lowercase before the regex check so
    // humans pasting `ACME.com` from a deck don't get a 400.
    expect(isValidDomain("ACME.com")).toBe(true);
  });
});

describe("classifyVercelError", () => {
  it("maps 401 → unauthorized", () => {
    expect(classifyVercelError(401, "")).toBe("unauthorized");
  });
  it("maps 403 → unauthorized", () => {
    expect(classifyVercelError(403, "")).toBe("unauthorized");
  });
  it("maps 429 → rate_limited", () => {
    expect(classifyVercelError(429, "")).toBe("rate_limited");
  });
  it("maps 409 → domain_in_use", () => {
    expect(classifyVercelError(409, "")).toBe("domain_in_use");
  });
  it("detects domain_already_in_use body → domain_in_use", () => {
    expect(
      classifyVercelError(400, '{"error":{"code":"domain_already_in_use"}}'),
    ).toBe("domain_in_use");
  });
  it("detects invalid_domain body → domain_invalid", () => {
    expect(classifyVercelError(400, '{"error":{"code":"invalid_domain"}}')).toBe(
      "domain_invalid",
    );
  });
  it("defaults unknown for 5xx", () => {
    expect(classifyVercelError(500, "")).toBe("unknown");
  });
});

describe("httpStatusForCode", () => {
  it("maps domain_invalid → 400", () => {
    expect(httpStatusForCode("domain_invalid")).toBe(400);
  });
  it("maps domain_in_use → 409", () => {
    expect(httpStatusForCode("domain_in_use")).toBe(409);
  });
  it("maps rate_limited → 429", () => {
    expect(httpStatusForCode("rate_limited")).toBe(429);
  });
  it("maps unauthorized → 502", () => {
    // Upstream unauthorized → Bad Gateway (we don't leak the 401).
    expect(httpStatusForCode("unauthorized")).toBe(502);
  });
});

describe("addDomainToProject", () => {
  it("happy path: returns normalized record + hits /v10 with teamId", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      mkResponse(200, {
        name: "acme.com",
        verified: false,
        verification: [
          { type: "TXT", domain: "_vercel.acme.com", value: "vc-123" },
          { type: "A", domain: "acme.com", value: "76.76.21.21" },
        ],
        createdAt: 1700000000000,
      }),
    );
    const r = await addDomainToProject({
      ...BASE,
      domain: "acme.com",
      fetchImpl,
    });
    expect(r.domain).toBe("acme.com");
    expect(r.verified).toBe(false);
    expect(r.verification).toHaveLength(2);
    const called = fetchImpl.mock.calls[0][0] as string;
    expect(called).toContain("/v10/projects/prj_123/domains");
    expect(called).toContain("teamId=team_abc");
    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ name: "acme.com" });
  });

  it("rejects invalid domain BEFORE fetch (regex gate)", async () => {
    const fetchImpl = jest.fn();
    await expect(
      addDomainToProject({ ...BASE, domain: "not a domain", fetchImpl }),
    ).rejects.toMatchObject({
      name: "VercelDomainError",
      code: "domain_invalid",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("409 domain_already_in_use maps to domain_in_use", async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(
        mkResponse(409, { error: { code: "domain_already_in_use" } }),
      );
    const err = await addDomainToProject({
      ...BASE,
      domain: "acme.com",
      fetchImpl,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(VercelDomainError);
    expect(err.code).toBe("domain_in_use");
    expect(err.status).toBe(409);
  });

  it("401 unauthorized maps to unauthorized", async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(mkResponse(401, "forbidden"));
    const err = await addDomainToProject({
      ...BASE,
      domain: "acme.com",
      fetchImpl,
    }).catch((e) => e);
    expect(err.code).toBe("unauthorized");
  });

  it("429 maps to rate_limited", async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(mkResponse(429, "rate limited"));
    const err = await addDomainToProject({
      ...BASE,
      domain: "acme.com",
      fetchImpl,
    }).catch((e) => e);
    expect(err.code).toBe("rate_limited");
  });

  it("network error classified as network", async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error("ECONNRESET"));
    const err = await addDomainToProject({
      ...BASE,
      domain: "acme.com",
      fetchImpl,
    }).catch((e) => e);
    expect(err.code).toBe("network");
    expect(err.status).toBe(0);
  });

  it("truncates long Vercel bodies to 500 chars in message", async () => {
    const huge = "x".repeat(2000);
    const fetchImpl = jest.fn().mockResolvedValue(mkResponse(500, huge));
    const err = await addDomainToProject({
      ...BASE,
      domain: "acme.com",
      fetchImpl,
    }).catch((e) => e);
    expect(err.body.length).toBeLessThanOrEqual(500);
  });

  it("URL-encodes project id", async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(mkResponse(200, { name: "acme.com", verified: true }));
    await addDomainToProject({
      projectId: "prj/weird id",
      teamId: "team_abc",
      token: "tok",
      domain: "acme.com",
      fetchImpl,
    });
    const called = fetchImpl.mock.calls[0][0] as string;
    expect(called).toContain("/v10/projects/prj%2Fweird%20id/domains");
  });
});

describe("getDomainStatus", () => {
  it("returns verified record on 200 + verified:true", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      mkResponse(200, {
        name: "acme.com",
        verified: true,
        verification: [],
        createdAt: 1700000000000,
      }),
    );
    const r = await getDomainStatus({
      ...BASE,
      domain: "acme.com",
      fetchImpl,
    });
    expect(r?.verified).toBe(true);
    const called = fetchImpl.mock.calls[0][0] as string;
    expect(called).toContain("/v9/projects/prj_123/domains/acme.com");
  });

  it("returns pending record on 200 + verified:false + verification rows", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      mkResponse(200, {
        name: "acme.com",
        verified: false,
        verification: [
          {
            type: "TXT",
            domain: "_vercel.acme.com",
            value: "vc-123",
            reason: "pending_cname",
          },
        ],
      }),
    );
    const r = await getDomainStatus({
      ...BASE,
      domain: "acme.com",
      fetchImpl,
    });
    expect(r?.verified).toBe(false);
    expect(r?.verification[0].reason).toBe("pending_cname");
  });

  it("returns null on 404", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(mkResponse(404));
    const r = await getDomainStatus({
      ...BASE,
      domain: "acme.com",
      fetchImpl,
    });
    expect(r).toBeNull();
  });

  it("rejects invalid-shape domain before fetch", async () => {
    const fetchImpl = jest.fn();
    await expect(
      getDomainStatus({ ...BASE, domain: "nope", fetchImpl }),
    ).rejects.toMatchObject({ code: "domain_invalid" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("removeDomainFromProject", () => {
  it("returns success on 200", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(mkResponse(200, {}));
    const r = await removeDomainFromProject({
      ...BASE,
      domain: "acme.com",
      fetchImpl,
    });
    expect(r.success).toBe(true);
  });

  it("returns success on 404 (idempotent)", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(mkResponse(404));
    const r = await removeDomainFromProject({
      ...BASE,
      domain: "acme.com",
      fetchImpl,
    });
    expect(r.success).toBe(true);
  });

  it("throws on 500", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(mkResponse(500, "boom"));
    await expect(
      removeDomainFromProject({ ...BASE, domain: "acme.com", fetchImpl }),
    ).rejects.toBeInstanceOf(VercelDomainError);
  });

  it("throws classified rate_limited on 429", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(mkResponse(429, "slow"));
    const err = await removeDomainFromProject({
      ...BASE,
      domain: "acme.com",
      fetchImpl,
    }).catch((e) => e);
    expect(err.code).toBe("rate_limited");
  });
});
