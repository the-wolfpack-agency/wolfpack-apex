/**
 * Asserts the microsoft-graph token-refresh hot path resolves credentials
 * through the secrets wrapper (getSecretOrThrow) rather than reading
 * process.env directly. Mocks @/lib/secrets so the test does not depend
 * on real env state.
 */

 

const mockGetSecretOrThrow = jest.fn();

jest.mock("@/lib/secrets", () => ({
  getSecretOrThrow: (...args: any[]) => mockGetSecretOrThrow(...args),
}));

jest.mock("@/lib/analytics", () => ({
  trackEvent: jest.fn(),
}));

jest.mock("@/lib/db", () => ({
  query: jest.fn(),
  safeQuery: jest.fn().mockResolvedValue({ rows: [] }),
  pool: { query: jest.fn() },
}));

beforeEach(() => {
  jest.clearAllMocks();
  jest.resetModules();
  delete process.env.MS_CLIENT_ID;
  delete process.env.MS_CLIENT_SECRET;
  delete process.env.MS_REDIRECT_URI;
});

test("refreshAccessToken resolves MS credentials through getSecretOrThrow with kebab-case names", async () => {
  mockGetSecretOrThrow.mockImplementation(async (name: string) => {
    if (name === "microsoft-client-id") return "resolved-id";
    if (name === "microsoft-client-secret") return "resolved-secret";
    throw new Error(`unexpected secret: ${name}`);
  });

  const fetchMock = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      access_token: "new-access",
      refresh_token: "new-refresh",
      expires_in: 3600,
    }),
  });
  (global as any).fetch = fetchMock;

  const ms = await import("@/lib/microsoft-graph");
  ms._resetMsCredsCache();

  const result = await ms.refreshAccessToken("old-refresh-token");

  expect(mockGetSecretOrThrow).toHaveBeenCalledWith("microsoft-client-id");
  expect(mockGetSecretOrThrow).toHaveBeenCalledWith("microsoft-client-secret");

  const callBody = (fetchMock.mock.calls[0][1].body as string) || "";
  expect(callBody).toContain("client_id=resolved-id");
  expect(callBody).toContain("client_secret=resolved-secret");

  expect(result?.access_token).toBe("new-access");
});
