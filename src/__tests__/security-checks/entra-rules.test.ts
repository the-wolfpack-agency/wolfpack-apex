import {
  MICROSOFT_GRAPH_APP_ID,
  auditApp,
  lastCredentialUse,
  resolveAppRoles,
  signInReportFreshness,
  type AppAuditInput,
  type AppRegistration,
} from "../../../scripts/security/lib/entra";

const NOW = new Date("2026-10-24T00:00:00Z");

function app(over: Partial<AppRegistration> = {}): AppRegistration {
  return {
    id: "obj-1",
    appId: "11111111-2222-3333-4444-555555555555",
    displayName: "Test App",
    passwordCredentials: [{ keyId: "aaaaaaaa-0000", displayName: "s1", startDateTime: "2026-06-01T00:00:00Z", endDateTime: "2027-05-01T00:00:00Z" }],
    keyCredentials: [],
    ...over,
  };
}

function input(over: Partial<AppAuditInput> = {}): AppAuditInput {
  return {
    app: app(),
    hasServicePrincipal: true,
    grantedAppRoles: [],
    signIn: { appId: "x", applicationAuthenticationClientSignInActivity: { lastSignInDateTime: "2026-10-20T00:00:00Z" } },
    signInDataAvailable: true,
    now: NOW,
    ...over,
  };
}

const rules = (i: AppAuditInput) => auditApp(i).map((f) => f.rule);

describe("auditApp", () => {
  it("is clean for a used app with a short-lived credential and no sensitive roles", () => {
    expect(auditApp(input())).toEqual([]);
  });

  it("(a) flags a live credential with no client sign-in for 90 days, or none ever", () => {
    expect(rules(input({ signIn: { appId: "x", applicationAuthenticationClientSignInActivity: { lastSignInDateTime: "2026-07-01T00:00:00Z" } } }))).toEqual([
      "entra.unused-live-credential",
    ]);
    expect(rules(input({ signIn: null }))).toEqual(["entra.unused-live-credential"]);
  });

  it("(a) does not flag when sign-in data is unavailable or the credential is expired", () => {
    expect(rules(input({ signIn: null, signInDataAvailable: false }))).toEqual([]);
    const expired = app({ passwordCredentials: [{ keyId: "k", startDateTime: "2025-01-01T00:00:00Z", endDateTime: "2025-06-01T00:00:00Z" }] });
    expect(rules(input({ app: expired, signIn: null }))).toEqual([]);
  });

  it("(a) ignores resource-side activity: being called is not using the credential", () => {
    const signIn = { appId: "x", lastSignInActivity: { lastSignInDateTime: "2026-10-23T00:00:00Z" } };
    expect(lastCredentialUse(signIn)).toBeNull();
    expect(rules(input({ signIn }))).toEqual(["entra.unused-live-credential"]);
  });

  it("(b) flags tenant-wide Mail.Send on Microsoft Graph but not on another resource, nor a safe role", () => {
    const f = auditApp(
      input({
        grantedAppRoles: [
          { resourceAppId: MICROSOFT_GRAPH_APP_ID, resourceDisplayName: "Microsoft Graph", value: "Mail.Send" },
          { resourceAppId: MICROSOFT_GRAPH_APP_ID, resourceDisplayName: "Microsoft Graph", value: "User.Read" },
          { resourceAppId: "other", resourceDisplayName: "Other API", value: "Mail.Read" },
        ],
      }),
    );
    expect(f.map((x) => x.rule)).toEqual(["entra.tenant-wide-sensitive-permission"]);
    expect(f[0].detail).toContain("Mail.Send");
    expect(f[0].detail).not.toContain("User.Read,");
    expect(f[0].detail).toContain("Exchange");
  });

  it("(c) flags a credential valid for more than 12 months", () => {
    const longLived = app({ passwordCredentials: [{ keyId: "k", startDateTime: "2026-07-27T00:00:00Z", endDateTime: "2028-07-26T00:00:00Z" }] });
    expect(rules(input({ app: longLived }))).toEqual(["entra.credential-lifetime-over-12-months"]);
  });

  it("(d) flags a credential expiring within 30 days, but not one already expired", () => {
    const soon = app({
      passwordCredentials: [
        { keyId: "k1", startDateTime: "2026-01-01T00:00:00Z", endDateTime: "2026-11-10T00:00:00Z" },
        { keyId: "k2", startDateTime: "2025-01-01T00:00:00Z", endDateTime: "2025-12-01T00:00:00Z" },
      ],
    });
    expect(rules(input({ app: soon }))).toEqual(["entra.credential-expiring"]);
  });

  it("covers certificates as well as secrets", () => {
    const cert = app({ passwordCredentials: [], keyCredentials: [{ keyId: "c", startDateTime: "2026-01-01T00:00:00Z", endDateTime: "2029-01-01T00:00:00Z" }] });
    const f = auditApp(input({ app: cert }));
    expect(f[0].detail).toMatch(/^certificate/);
  });
});

describe("signInReportFreshness", () => {
  it("treats a report whose newest sign-in is weeks old as stale (no-premium tenant, measured 2026-10-24)", () => {
    const stale = signInReportFreshness([{ appId: "a", lastSignInActivity: { lastSignInDateTime: "2026-03-03T11:14:42Z" } }], NOW);
    expect(stale.fresh).toBe(false);
    expect(stale.newest?.toISOString().slice(0, 10)).toBe("2026-03-03");
    expect(signInReportFreshness([], NOW).fresh).toBe(false);
    expect(signInReportFreshness([{ appId: "a", lastSignInActivity: { lastSignInDateTime: "2026-10-23T00:00:00Z" } }], NOW).fresh).toBe(true);
  });
});

describe("resolveAppRoles", () => {
  it("maps assignment GUIDs to role names on the resource and drops unknown ones", () => {
    const resources = new Map([
      ["graph-sp", { appId: MICROSOFT_GRAPH_APP_ID, displayName: "Microsoft Graph", appRoles: [{ id: "role-1", value: "Mail.Send" }] }],
    ]);
    expect(
      resolveAppRoles(
        [
          { appRoleId: "role-1", resourceId: "graph-sp" },
          { appRoleId: "missing", resourceId: "graph-sp" },
          { appRoleId: "role-1", resourceId: "unknown-sp" },
        ],
        resources,
      ),
    ).toEqual([{ resourceAppId: MICROSOFT_GRAPH_APP_ID, resourceDisplayName: "Microsoft Graph", value: "Mail.Send" }]);
  });
});
