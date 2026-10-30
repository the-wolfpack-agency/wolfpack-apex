/** @jest-environment node */
import { _resetCanaryCache, canaryEndpoint, canaryUsernameFrom, reportSignInAttempt, checkCanarySignIn, isCanaryUsername, mintCanarySignIn } from "@/lib/forcefield-web/canary-signin";

const env = { FORCEFIELD_INGEST_URL: "https://hub.example/api/site-analytics/ingest", SITE_ANALYTICS_INGEST_TOKEN: "site-token" } as unknown as NodeJS.ProcessEnv;
beforeEach(() => { _resetCanaryCache(); jest.restoreAllMocks(); });

it("the endpoints come from the ingest URL's origin", () => {
  expect(canaryEndpoint("check", env)).toBe("https://hub.example/api/forcefield/canary/check");
  expect(canaryEndpoint("mint", {} as never)).toBeNull();
});

it("a real username is never sent anywhere", async () => {
  const f = jest.spyOn(global, "fetch");
  expect(await checkCanarySignIn({ site: "s", username: "dealer@porsche.example" }, env)).toBe(false);
  expect(await checkCanarySignIn({ site: "s", username: undefined }, env)).toBe(false);
  expect(f).not.toHaveBeenCalled();
  expect(isCanaryUsername("svc_sync_abcdef")).toBe(true);
});

it("a canary-shaped username is checked with the site token; the answer is Instinct's", async () => {
  const f = jest.spyOn(global, "fetch").mockResolvedValue(new Response(JSON.stringify({ ok: true, canary: true })));
  expect(await checkCanarySignIn({ site: "s", username: "svc_sync_abcdef", path: "/admin/login", fp: "f", sig: "g" }, env)).toBe(true);
  const [url, init] = f.mock.calls[0];
  expect(url).toBe("https://hub.example/api/forcefield/canary/check");
  expect((init as RequestInit).headers).toMatchObject({ "x-ingest-token": "site-token" });
  expect(JSON.parse(String((init as RequestInit).body))).toEqual({ site: "s", username: "svc_sync_abcdef", path: "/admin/login", fp: "f", sig: "g" });
});

it("Instinct unreachable: not a canary, and no bait (never throws)", async () => {
  jest.spyOn(global, "fetch").mockRejectedValue(new Error("down"));
  expect(await checkCanarySignIn({ site: "s", username: "svc_sync_abcdef" }, env)).toBe(false);
  expect(await mintCanarySignIn({ site: "s", decoy: "/_ff/x", sig: "g" }, env)).toBeNull();
});

it("mint is cached per site, decoy and session", async () => {
  const f = jest.spyOn(global, "fetch").mockResolvedValue(new Response(JSON.stringify({ ok: true, username: "svc_sync_abcdef", password: "p" })));
  const a = await mintCanarySignIn({ site: "s", decoy: "/_ff/x", sig: "g" }, env);
  const b = await mintCanarySignIn({ site: "s", decoy: "/_ff/x", sig: "g" }, env);
  expect(a).toEqual({ username: "svc_sync_abcdef", password: "p" });
  expect(b).toEqual(a);
  expect(f).toHaveBeenCalledTimes(1);
});

describe("canaryUsernameFrom (the raw sign-in field)", () => {
  it("finds the canary typed bare or with a domain added, in any case", () => {
    expect(canaryUsernameFrom("svc_backup_k7q2m4")).toBe("svc_backup_k7q2m4");
    expect(canaryUsernameFrom("svc_backup_k7q2m4@dealer.example")).toBe("svc_backup_k7q2m4");
    expect(canaryUsernameFrom("  SVC_Backup_K7Q2M4  ")).toBe("svc_backup_k7q2m4");
  });
  it("is null for real identifiers and non-strings", () => {
    for (const v of ["alice@example.com", "svc_backup@x.com", "x@svc_backup_k7q2m4", "@svc_backup_k7q2m4", "svc_backup_k7q2m4x", "", null, 42, undefined]) {
      expect(canaryUsernameFrom(v)).toBeNull();
    }
  });
});

describe("reportSignInAttempt (a site's sign-in route)", () => {
  const req = (h: Record<string, string>) => ({ headers: new Headers(h), nextUrl: { pathname: "/api/admin/auth/login" } });
  it("reports a canary typed into an email field, with this request's session and operator keys", async () => {
    const f = jest.spyOn(global, "fetch").mockResolvedValue(new Response(JSON.stringify({ ok: true, canary: true })));
    expect(await reportSignInAttempt("wwp", req({ "user-agent": "curl/8.4.0", accept: "*/*" }), "svc_backup_k7q2m4@dealer.example", env)).toBe(true);
    const sent = JSON.parse(String((f.mock.calls[0][1] as RequestInit).body));
    expect(sent).toMatchObject({ site: "wwp", username: "svc_backup_k7q2m4", path: "/api/admin/auth/login" });
    expect(sent.fp).toMatch(/^[0-9a-f]{8}:/);
    expect(sent.sig).toEqual(expect.any(String));
    expect(sent).not.toHaveProperty("password");
  });
  it("a real email never leaves the site", async () => {
    const f = jest.spyOn(global, "fetch");
    expect(await reportSignInAttempt("wwp", req({}), "dealer@porsche.example", env)).toBe(false);
    expect(await reportSignInAttempt("wwp", req({}), undefined, env)).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });
});
