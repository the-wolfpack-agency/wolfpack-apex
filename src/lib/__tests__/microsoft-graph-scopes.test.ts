/**
 * Guardrail: the Microsoft Graph scope list in microsoft-graph.ts is
 * used in a DELEGATED OAuth authorization-code flow. Application-only
 * permissions (used by daemon apps with client-credentials tokens)
 * cannot appear here — Azure returns AADSTS650053 "scope doesn't exist
 * on the resource" the moment a user tries to consent.
 *
 * 2026-04-21 incident: OnlineMeetings.ReadWrite.All (app-only) shipped
 * in the delegated list and blocked every Microsoft 365 connect with
 * invalid_client. Regression.
 */
import { readFileSync } from "fs";
import { join } from "path";

const SRC = readFileSync(
  join(process.cwd(), "src/lib/microsoft-graph.ts"),
  "utf8",
);

function extractScopes(src: string): string[] {
  const m = src.match(/MS_SCOPES:\s*string\[\]\s*=\s*\[([\s\S]*?)\];/);
  if (!m) throw new Error("MS_SCOPES array not found in microsoft-graph.ts");
  return Array.from(m[1].matchAll(/"([^"]+)"/g)).map((x) => x[1]);
}

describe("microsoft-graph scope list — delegated OAuth compatibility", () => {
  const scopes = extractScopes(SRC);

  it("is non-empty and contains offline_access (needed for refresh tokens)", () => {
    expect(scopes.length).toBeGreaterThan(0);
    expect(scopes).toContain("offline_access");
  });

  // These scope names exist ONLY as application-only permissions on
  // Microsoft Graph. Requesting them in a delegated flow produces
  // AADSTS650053 and blocks all users.
  const APP_ONLY_FORBIDDEN = [
    "OnlineMeetings.ReadWrite.All",
    "OnlineMeetings.Read.All",
    // If you need any of these, swap to the delegated equivalent
    // (without .All) or use a separate client-credentials app.
  ];

  it.each(APP_ONLY_FORBIDDEN)(
    "does not request the app-only scope %s",
    (forbidden) => {
      expect(scopes).not.toContain(forbidden);
    },
  );

  it("uses the delegated OnlineMeetings.ReadWrite (no .All) if meetings are needed", () => {
    if (scopes.some((s) => s.startsWith("OnlineMeetings"))) {
      expect(scopes).toContain("OnlineMeetings.ReadWrite");
    }
  });
});
