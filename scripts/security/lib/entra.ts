/**
 * Pure rules for the Entra app-registration audit.
 *
 * WHY THESE FOUR. On 2026-10-24 we deleted "Wolfpack Instinct (unused)": an app
 * nobody used, holding tenant-wide Mail.Read, with secrets that still worked.
 * Nothing had flagged it, because each half of the risk looked harmless alone.
 * An unused app is clutter; a broad permission on a used app is a decision.
 * An unused app WITH a live secret AND a broad permission is a key to every
 * mailbox lying in a drawer. These rules exist so that combination, and the
 * slower ways an app drifts toward it, are seen monthly instead of by luck.
 *
 *   (a) live credential, no sign-in for 90 days     -> high
 *   (b) tenant-wide application permission on a sensitive Graph scope -> high
 *   (c) credential lifetime over 12 months           -> medium
 *   (d) credential expiring within 30 days           -> medium
 */
import type { Finding } from "./report";

export const MICROSOFT_GRAPH_APP_ID = "00000003-0000-0000-c000-000000000000";

export const SENSITIVE_GRAPH_APP_ROLES = [
  "Mail.Read",
  "Mail.ReadWrite",
  "Mail.Send",
  "Files.Read.All",
  "Files.ReadWrite.All",
  "Sites.Read.All",
  "Sites.ReadWrite.All",
  "User.Read.All",
  "Directory.ReadWrite.All",
] as const;

export const UNUSED_DAYS = 90;
export const MAX_LIFETIME_DAYS = 366; // 12 months, with a day of grace for portal rounding
export const EXPIRY_WARNING_DAYS = 30;

const DAY = 86400_000;

export interface Credential {
  keyId: string;
  displayName?: string | null;
  startDateTime?: string | null;
  endDateTime?: string | null;
}

export interface AppRegistration {
  id: string;
  appId: string;
  displayName: string;
  createdDateTime?: string | null;
  passwordCredentials: Credential[];
  keyCredentials: Credential[];
}

export interface SignInActivityRecord {
  appId: string;
  lastSignInActivity?: { lastSignInDateTime?: string | null } | null;
  delegatedClientSignInActivity?: { lastSignInDateTime?: string | null } | null;
  applicationAuthenticationClientSignInActivity?: { lastSignInDateTime?: string | null } | null;
}

/** A granted app role resolved to its name on the resource it belongs to. */
export interface GrantedAppRole {
  resourceAppId: string;
  resourceDisplayName: string;
  value: string;
}

export interface AppAuditInput {
  app: AppRegistration;
  hasServicePrincipal: boolean;
  grantedAppRoles: GrantedAppRole[];
  signIn: SignInActivityRecord | null;
  /** False when the sign-in report could not be read; rule (a) then cannot run. */
  signInDataAvailable: boolean;
  now: Date;
}

/**
 * When the app last used its credential. Client activity is the app signing in
 * as itself (app-only or on behalf of a user), which is what a secret or
 * certificate is for. Resource activity (others calling this app's API) does
 * not use this app's credential, so it does not count as "in use".
 */
export function lastCredentialUse(r: SignInActivityRecord | null): Date | null {
  if (!r) return null;
  const times = [
    r.applicationAuthenticationClientSignInActivity?.lastSignInDateTime,
    r.delegatedClientSignInActivity?.lastSignInDateTime,
  ]
    .filter((t): t is string => !!t)
    .map((t) => new Date(t))
    .filter((d) => !Number.isNaN(d.getTime()));
  if (!times.length) return null;
  return new Date(Math.max(...times.map((d) => d.getTime())));
}

export const SIGN_IN_REPORT_STALE_DAYS = 7;

/**
 * Is the sign-in activity report current? Measured 2026-10-24: in a tenant
 * without an Entra ID P1 or P2 license the beta report still answers 200 with
 * records, but the newest entry was 2026-03-03, frozen when premium sign-in
 * logging stopped. Read as live, that report would call every app "unused".
 * A report whose newest sign-in anywhere is older than a week is not evidence
 * of anything, so rule (a) is not evaluated against it.
 */
export function signInReportFreshness(records: SignInActivityRecord[], now: Date): { fresh: boolean; newest: Date | null } {
  let newest: number | null = null;
  for (const r of records) {
    const t = r.lastSignInActivity?.lastSignInDateTime;
    const ms = t ? new Date(t).getTime() : NaN;
    if (!Number.isNaN(ms) && (newest === null || ms > newest)) newest = ms;
  }
  if (newest === null) return { fresh: false, newest: null };
  return { fresh: (now.getTime() - newest) / DAY <= SIGN_IN_REPORT_STALE_DAYS, newest: new Date(newest) };
}

function credentialLabel(kind: "secret" | "certificate", c: Credential): string {
  return `${kind} ${c.displayName ? `"${c.displayName}" ` : ""}(${c.keyId.slice(0, 8)})`;
}

function day(s: string | null | undefined): string {
  return s ? s.slice(0, 10) : "?";
}

export function auditApp(input: AppAuditInput): Finding[] {
  const { app, now } = input;
  const out: Finding[] = [];
  const subject = `${app.displayName} (${app.appId})`;
  const portal = `https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationMenuBlade/~/Credentials/appId/${app.appId}`;
  const creds = [
    ...app.passwordCredentials.map((c) => ({ kind: "secret" as const, c })),
    ...app.keyCredentials.map((c) => ({ kind: "certificate" as const, c })),
  ];
  const live = creds.filter(({ c }) => c.endDateTime && new Date(c.endDateTime).getTime() > now.getTime());

  // (a) unused with a live credential
  if (live.length && input.signInDataAvailable) {
    const last = lastCredentialUse(input.signIn);
    const idleDays = last ? Math.floor((now.getTime() - last.getTime()) / DAY) : null;
    if (idleDays === null || idleDays >= UNUSED_DAYS) {
      out.push({
        severity: "high",
        rule: "entra.unused-live-credential",
        subject,
        detail: `${live.length} credential(s) still valid but the app has ${last ? `not signed in for ${idleDays} days (last ${last.toISOString().slice(0, 10)})` : "no recorded sign-in"}${input.hasServicePrincipal ? "" : " and no service principal in this tenant"}. Remove the credential, or the app, if nothing needs it.`,
        source: portal,
      });
    }
  }

  // (b) tenant-wide application permissions on sensitive Graph scopes
  const sensitive = input.grantedAppRoles.filter(
    (g) => g.resourceAppId === MICROSOFT_GRAPH_APP_ID && (SENSITIVE_GRAPH_APP_ROLES as readonly string[]).includes(g.value),
  );
  if (sensitive.length) {
    const names = [...new Set(sensitive.map((s) => s.value))].sort();
    out.push({
      severity: "high",
      rule: "entra.tenant-wide-sensitive-permission",
      subject,
      detail: `Holds tenant-wide Microsoft Graph application permission(s) ${names.join(", ")}${live.length ? ` with ${live.length} live credential(s)` : ""}. Application permissions reach every mailbox, file or user in the tenant unless separately scoped.${names.some((n) => n.startsWith("Mail.")) ? " An Exchange RBAC for Applications scope cannot narrow a tenant-wide Entra grant (the two are a union); only an Application Access Policy can, and that must be checked in Exchange (see notes)." : ""}`,
      source: `https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationMenuBlade/~/CallAnAPI/appId/${app.appId}`,
    });
  }

  for (const { kind, c } of creds) {
    const start = c.startDateTime ? new Date(c.startDateTime) : null;
    const end = c.endDateTime ? new Date(c.endDateTime) : null;
    if (!end) continue;
    // (c) lifetime over 12 months
    if (start && (end.getTime() - start.getTime()) / DAY > MAX_LIFETIME_DAYS && end.getTime() > now.getTime()) {
      out.push({
        severity: "medium",
        rule: "entra.credential-lifetime-over-12-months",
        subject,
        detail: `${credentialLabel(kind, c)} is valid from ${day(c.startDateTime)} to ${day(c.endDateTime)} (${Math.round((end.getTime() - start.getTime()) / DAY)} days). Replace it with one of 12 months or less, put the new one in use, then remove this one.`,
        source: portal,
      });
    }
    // (d) expiring within 30 days
    const left = (end.getTime() - now.getTime()) / DAY;
    if (left > 0 && left <= EXPIRY_WARNING_DAYS) {
      out.push({
        severity: "medium",
        rule: "entra.credential-expiring",
        subject,
        detail: `${credentialLabel(kind, c)} expires ${day(c.endDateTime)} (${Math.ceil(left)} days). If the app is in use, rotate before then: add the new credential, deploy it, confirm sign-ins, then remove the old one.`,
        source: portal,
      });
    }
  }
  return out;
}

export interface AppRoleDefinition {
  id: string;
  value: string | null;
}

export interface AppRoleAssignment {
  appRoleId: string;
  resourceId: string;
  resourceDisplayName?: string;
}

/** Resolve assignment GUIDs to role names using each resource's appRoles. */
export function resolveAppRoles(
  assignments: AppRoleAssignment[],
  resources: Map<string, { appId: string; displayName: string; appRoles: AppRoleDefinition[] }>,
): GrantedAppRole[] {
  const out: GrantedAppRole[] = [];
  for (const a of assignments) {
    const res = resources.get(a.resourceId);
    if (!res) continue;
    const role = res.appRoles.find((r) => r.id === a.appRoleId);
    if (!role?.value) continue;
    out.push({ resourceAppId: res.appId, resourceDisplayName: res.displayName, value: role.value });
  }
  return out;
}
