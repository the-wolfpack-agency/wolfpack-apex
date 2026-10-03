/** resolveWorkspace - the tenant chokepoint. Present wins; absent falls back to a
 *  configured default (single-tenant safe); strict mode fails CLOSED. */
import { resolveWorkspace, WorkspaceRequiredError } from "../workspace";

describe("resolveWorkspace", () => {
  afterEach(() => { delete process.env.REQUIRE_EXPLICIT_WORKSPACE; delete process.env.FACTORY_DEFAULT_WORKSPACE; });

  it("returns the user's workspace when present (the common path)", () => {
    expect(resolveWorkspace("ws_acme")).toBe("ws_acme");
  });
  it("falls back to 'default' when absent and strict mode is OFF (single-tenant safe)", () => {
    expect(resolveWorkspace(null)).toBe("default");
    expect(resolveWorkspace(undefined)).toBe("default");
    expect(resolveWorkspace("")).toBe("default");
  });
  it("honors a configured default workspace", () => {
    process.env.FACTORY_DEFAULT_WORKSPACE = "ws_primary";
    expect(resolveWorkspace(null)).toBe("ws_primary");
  });
  it("FAILS CLOSED when a workspace is absent and strict isolation is enabled", () => {
    process.env.REQUIRE_EXPLICIT_WORKSPACE = "true";
    expect(() => resolveWorkspace(null)).toThrow(WorkspaceRequiredError);
  });
  it("a present workspace is never affected by strict mode", () => {
    process.env.REQUIRE_EXPLICIT_WORKSPACE = "true";
    expect(resolveWorkspace("ws_acme")).toBe("ws_acme");
  });
});
