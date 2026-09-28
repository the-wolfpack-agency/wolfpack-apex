import { parseCookies } from "nookies";
import { describe, it, expect } from "@jest/globals";

// Mocked function to simulate a server environment
const mockServerRequest = (headers: Record<string, string | undefined>) => ({
  headers,
});

// Utility function to check if the "auth" cookie is being accessed directly
const isAuthCookieAccessedDirectly = (req: { headers: Record<string, string | undefined> }) => {
  const cookies = parseCookies({ req });
  return Object.keys(cookies).includes("auth");
};

describe("No Direct Auth Cookie Access Tests", () => {
  it("should detect direct access to the 'auth' cookie", () => {
    const req = mockServerRequest({
      cookie: "auth=secureToken; session=12345",
    });
    const result = isAuthCookieAccessedDirectly(req);
    expect(result).toBe(true); // Expected: Direct access to auth cookie is detected
  });

  it("should not detect 'auth' cookie if it is absent", () => {
    const req = mockServerRequest({
      cookie: "session=12345",
    });
    const result = isAuthCookieAccessedDirectly(req);
    expect(result).toBe(false); // Expected: No direct access to auth cookie
  });

  it("should handle requests with no cookies gracefully", () => {
    const req = mockServerRequest({});
    const result = isAuthCookieAccessedDirectly(req);
    expect(result).toBe(false); // Expected: No direct access to auth cookie
  });

  it("should handle malformed cookie headers gracefully", () => {
    const req = mockServerRequest({
      cookie: "malformed-cookie-header",
    });
    const result = isAuthCookieAccessedDirectly(req);
    expect(result).toBe(false); // Expected: No direct access to auth cookie
  });
});