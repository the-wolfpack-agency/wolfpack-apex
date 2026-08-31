/**
 * A local default must not survive into a deployed function.
 *
 * From a real production alert: repeated ECONNREFUSED to 127.0.0.1 for
 * /dms/wolfpack-auto/inventory-search. In a serverless function 127.0.0.1 is
 * the function itself, so the tool dialled its own container and reported the
 * resulting network error to the operator — telling them the driver was down
 * when the truth was that nobody had configured one.
 */
import { isDeployed, isLoopbackUrl, resolveServiceUrl } from "../local-default";

const DEPLOYED = { VERCEL: "1" } as unknown as NodeJS.ProcessEnv;
const LOCAL = {} as unknown as NodeJS.ProcessEnv;

describe("isLoopbackUrl", () => {
  it.each([
    "http://localhost:3000",
    "http://127.0.0.1:7421",
    "http://127.1.2.3:80",
    "http://[::1]:7421",
    "http://0.0.0.0:8080",
    "https://LOCALHOST:443",
  ])("recognizes %s as this machine", (url) => {
    expect(isLoopbackUrl(url)).toBe(true);
  });

  it.each(["https://driver.internal.example.com", "https://example.com", "http://10.0.0.5:7421"])(
    "does not flag %s",
    (url) => {
      // 10.x is private but NOT loopback. It is a plausible real driver address
      // inside a VPC, and refusing it would break a legitimate deployment.
      expect(isLoopbackUrl(url)).toBe(false);
    },
  );

  it("returns false for something that is not a URL rather than throwing", () => {
    expect(isLoopbackUrl("not a url")).toBe(false);
    expect(isLoopbackUrl("")).toBe(false);
  });
});

describe("isDeployed", () => {
  it("is decided by a POSITIVE marker, not by NODE_ENV being unset", () => {
    // The negative form treats an unset environment as production and would
    // break every developer machine the day someone forgot to export NODE_ENV.
    expect(isDeployed(LOCAL)).toBe(false);
    expect(isDeployed(DEPLOYED)).toBe(true);
    expect(isDeployed({ AWS_LAMBDA_FUNCTION_NAME: "fn" } as unknown as NodeJS.ProcessEnv)).toBe(true);
  });
});

describe("resolveServiceUrl", () => {
  it("refuses a loopback default in a deployed function, and names the variable", () => {
    // "Unavailable" sends someone digging. The variable name is the fix.
    const r = resolveServiceUrl("DMS_DRIVER_URL", "http://127.0.0.1:7421", DEPLOYED);
    expect(r.configured).toBe(false);
    if (!r.configured) {
      expect(r.missingVar).toBe("DMS_DRIVER_URL");
      expect(r.reason).toMatch(/points at this machine/);
    }
  });

  it("uses the local default when NOT deployed, which is the whole point of having one", () => {
    const r = resolveServiceUrl("DMS_DRIVER_URL", "http://127.0.0.1:7421", LOCAL);
    expect(r).toEqual({ configured: true, url: "http://127.0.0.1:7421" });
  });

  it("prefers a configured value everywhere", () => {
    const env = { ...DEPLOYED, DMS_DRIVER_URL: "https://driver.example.com" } as unknown as NodeJS.ProcessEnv;
    expect(resolveServiceUrl("DMS_DRIVER_URL", "http://127.0.0.1:7421", env)).toEqual({
      configured: true,
      url: "https://driver.example.com",
    });
  });

  it("allows a NON-loopback default in a deployed function", () => {
    // The rule is about dialling this machine, not about defaults in general.
    const r = resolveServiceUrl("SOME_URL", "https://shared.example.com", DEPLOYED);
    expect(r).toEqual({ configured: true, url: "https://shared.example.com" });
  });

  it("treats an empty or whitespace variable as unset", () => {
    // An env var set to "" is the shape a half-finished deployment leaves, and
    // it would otherwise resolve to an empty base URL and build nonsense paths.
    const env = { ...DEPLOYED, DMS_DRIVER_URL: "   " } as unknown as NodeJS.ProcessEnv;
    expect(resolveServiceUrl("DMS_DRIVER_URL", "http://127.0.0.1:7421", env).configured).toBe(false);
  });

  it("strips a trailing slash, so callers can concatenate a path safely", () => {
    const env = { ...DEPLOYED, DMS_DRIVER_URL: "https://driver.example.com/" } as unknown as NodeJS.ProcessEnv;
    const r = resolveServiceUrl("DMS_DRIVER_URL", "http://127.0.0.1:7421", env);
    expect(r.configured && r.url).toBe("https://driver.example.com");
  });
});
