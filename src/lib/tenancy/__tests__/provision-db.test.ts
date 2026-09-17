/**
 * Provisioning provider selection - pure, no network. Proves cloud provisioning
 * is DARK by default: the manual provider returns pending and makes no call, and
 * neon is selected only when explicitly enabled with a key.
 */
import { activeProvider, provisioningEnabled } from "../provision-db";

describe("activeProvider / provisioningEnabled", () => {
  it("defaults to the manual provider (no cloud call, pending)", async () => {
    const p = activeProvider({} as NodeJS.ProcessEnv);
    expect(p.id).toBe("manual");
    expect(await p.create("t-abcd", "Acme")).toEqual({ pending: true });
    expect(provisioningEnabled({} as NodeJS.ProcessEnv)).toBe(false);
  });

  it("selects neon ONLY when OGIAM_DB_PROVIDER=neon", () => {
    expect(activeProvider({ OGIAM_DB_PROVIDER: "neon", NEON_API_KEY: "k" } as unknown as NodeJS.ProcessEnv).id).toBe("neon");
    expect(activeProvider({ OGIAM_DB_PROVIDER: "manual" } as unknown as NodeJS.ProcessEnv).id).toBe("manual");
  });

  it("provisioningEnabled needs BOTH the provider flag and a key", () => {
    expect(provisioningEnabled({ OGIAM_DB_PROVIDER: "neon" } as unknown as NodeJS.ProcessEnv)).toBe(false);
    expect(provisioningEnabled({ NEON_API_KEY: "k" } as unknown as NodeJS.ProcessEnv)).toBe(false);
    expect(provisioningEnabled({ OGIAM_DB_PROVIDER: "neon", NEON_API_KEY: "k" } as unknown as NodeJS.ProcessEnv)).toBe(true);
  });

  it("neon provider returns pending (no throw) when the key is absent, even if selected", async () => {
    const saved = process.env.NEON_API_KEY;
    delete process.env.NEON_API_KEY;
    try {
      const p = activeProvider({ OGIAM_DB_PROVIDER: "neon" } as unknown as NodeJS.ProcessEnv);
      const out = await p.create("t-abcd", "Acme");
      expect(out.pending).toBe(true);
      expect(out.connectionString).toBeUndefined();
    } finally {
      if (saved === undefined) delete process.env.NEON_API_KEY;
      else process.env.NEON_API_KEY = saved;
    }
  });
});
