/** @jest-environment node */
import { CANARY_LOGIN_RE, canaryPassword, findCanaryLogin, mintCanaryLogin, newCanaryUsername, parseSeed, seedKey } from "@/lib/forcefield/canary-login";

jest.mock("@/lib/db", () => ({ query: jest.fn(), safeQuery: jest.fn() }));

describe("canary logins: plausible, unguessable, traceable to their origin", () => {
  it("usernames have the canary shape and are not repeated", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const u = newCanaryUsername();
      expect(u).toMatch(CANARY_LOGIN_RE);
      seen.add(u);
    }
    expect(seen.size).toBeGreaterThan(195);
  });

  it("real usernames never match the shape", () => {
    for (const u of ["admin", "alice@example.com", "svc_backup", "svc_backup_K7Q2M9", "svc_backup_k7q2m40", "svc_backup_k7q2m1"]) expect(u).not.toMatch(CANARY_LOGIN_RE);
  });

  it("the password is stable per canary and differs between canaries", () => {
    const env = { INSTINCT_SECRET_KEY: "k".repeat(32) } as unknown as NodeJS.ProcessEnv;
    expect(canaryPassword("id-1", env)).toBe(canaryPassword("id-1", env));
    expect(canaryPassword("id-1", env)).not.toBe(canaryPassword("id-2", env));
    expect(canaryPassword("id-1", env)).toHaveLength(20);
  });

  it("without the server key the password is still unguessable: never derived from a fixed string", () => {
    const none = {} as NodeJS.ProcessEnv;
    const { createHmac } = jest.requireActual<typeof import("node:crypto")>("node:crypto");
    const fromLiteral = (k: string) => createHmac("sha256", k).update("canary-login:id-1").digest("base64url").slice(0, 20);
    expect(canaryPassword("id-1", none)).toBe(canaryPassword("id-1", none)); // stable within the instance
    for (const k of ["", "forcefield-canary", "secret", "changeme"]) expect(canaryPassword("id-1", none)).not.toBe(fromLiteral(k));
    expect(canaryPassword("id-1", none)).not.toBe(canaryPassword("id-1", { INSTINCT_SECRET_KEY: "k".repeat(32) } as never));
  });

  it("the origin round-trips through seeded_in, with separators stripped from inputs", () => {
    const k = seedKey({ site: "ogiam.com", decoy: "/_ff/registry-a54504", sig: "566d7b8a" });
    expect(k).toBe("login:site=ogiam.com;decoy=/_ff/registry-a54504;sig=566d7b8a");
    expect(parseSeed(k)).toEqual({ site: "ogiam.com", decoy: "/_ff/registry-a54504", sig: "566d7b8a" });
    expect(seedKey({ site: "a;b=c", decoy: "/x y", sig: "s" })).toBe("login:site=abc;decoy=/xy;sig=s");
    expect(parseSeed("dataset:customers")).toBeNull();
  });

  it("mint inserts idempotently for the origin and returns the stored canary", async () => {
    const calls: Array<[string, unknown[]]> = [];
    const q = async (t: string, p: unknown[]) => { calls.push([t, p]); return { rows: t.startsWith("SELECT") ? [{ id: "c1", value: "svc_sync_abcdef" }] : [] }; };
    const c = await mintCanaryLogin({ site: "ogiam.com", decoy: "/_ff/x", sig: "s1" }, { q, workspaceId: "ws", username: () => "svc_deploy_zzzzzz", env: { INSTINCT_SECRET_KEY: "k" } as never });
    expect(c).toEqual({ username: "svc_sync_abcdef", password: canaryPassword("c1", { INSTINCT_SECRET_KEY: "k" } as never) });
    expect(calls[0][0]).toMatch(/ON CONFLICT \(workspace_id, seeded_in\) WHERE kind = 'login' DO NOTHING/);
    expect(calls[0][1]).toEqual(["ws", "svc_deploy_zzzzzz", "login:site=ogiam.com;decoy=/_ff/x;sig=s1"]);
    expect(await mintCanaryLogin({ site: "s", decoy: "/x", sig: "s" }, { q: async () => { throw new Error("db"); } })).toBeNull();
  });

  it("find: no query at all for a username without the shape; a stored one comes back with its origin", async () => {
    const q = jest.fn(async () => ({ rows: [{ id: "c1", workspace_id: "ws", value: "svc_sync_abcdef", seeded_in: "login:site=ogiam.com;decoy=/_ff/x;sig=s1" }] }));
    expect(await findCanaryLogin("admin", q)).toBeNull();
    expect(q).not.toHaveBeenCalled();
    expect(await findCanaryLogin("svc_sync_abcdef", q)).toEqual({ id: "c1", workspaceId: "ws", username: "svc_sync_abcdef", seededIn: "login:site=ogiam.com;decoy=/_ff/x;sig=s1", origin: { site: "ogiam.com", decoy: "/_ff/x", sig: "s1" } });
  });
});
