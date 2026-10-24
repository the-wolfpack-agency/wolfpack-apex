/**
 * Monthly audit of every Entra app registration that holds a credential.
 *
 *   npm run security:entra-audit
 *   npm run security:entra-audit -- --out /tmp/sec --fail-on high
 *
 * For each app with a client secret or certificate: is it still used, what
 * tenant-wide Microsoft Graph application permissions does it hold, how long
 * do its credentials live, and do any expire soon. Rules and reasons are in
 * scripts/security/lib/entra.ts.
 *
 * READ-ONLY: Graph GETs only. Needs a Graph token with Application.Read.All
 * and AuditLog.Read.All (sign-in activity, beta report). Locally that is
 * `az login` as a user who can read them; in Actions it is azure/login with
 * GitHub OIDC (AZURE_CLIENT_ID + AZURE_TENANT_ID secrets). Without a token the
 * check reports SKIPPED and exits 0.
 */
import { apiGet, getToken, graphList } from "./lib/azure";
import {
  SENSITIVE_GRAPH_APP_ROLES,
  UNUSED_DAYS,
  auditApp,
  resolveAppRoles,
  signInReportFreshness,
  type AppRegistration,
  type AppRoleAssignment,
  type AppRoleDefinition,
  type SignInActivityRecord,
} from "./lib/entra";
import { emitReport, mapPool, newReport, parseCliOptions } from "./lib/report";

const GRAPH = "https://graph.microsoft.com";
const opts = parseCliOptions(process.argv.slice(2), "scripts/security/out");

interface ServicePrincipal {
  id: string;
  appId: string;
  displayName: string;
}

async function main(): Promise<number> {
  const report = newReport("entra-audit");
  const now = new Date();
  const { token, reason } = await getToken(GRAPH, "GRAPH_TOKEN");
  if (!token) {
    report.skipped = `No Microsoft Graph token (${reason}). Locally run \`az login\`; in Actions add the AZURE_CLIENT_ID and AZURE_TENANT_ID secrets for the read-only OIDC identity (docs/security/scheduled-checks.md).`;
    return emitReport(report, opts);
  }

  const apps = await graphList<AppRegistration>(
    `${GRAPH}/v1.0/applications?$select=id,appId,displayName,createdDateTime,passwordCredentials,keyCredentials&$top=999`,
    token,
  );
  if (!apps.ok) {
    if (apps.status === 401 || apps.status === 403) {
      report.skipped = `Graph refused to list applications (${apps.status}). The identity needs Application.Read.All (and AuditLog.Read.All for sign-in activity).`;
      return emitReport(report, opts);
    }
    process.stderr.write(`Cannot list applications: ${apps.status} ${apps.message}\n`);
    return 2;
  }
  const withCreds = apps.data.filter((a) => a.passwordCredentials.length || a.keyCredentials.length);

  const sps = await graphList<ServicePrincipal>(`${GRAPH}/v1.0/servicePrincipals?$select=id,appId,displayName&$top=999`, token);
  const spByAppId = new Map<string, ServicePrincipal>();
  if (sps.ok) for (const sp of sps.data) spByAppId.set(sp.appId, sp);
  else report.notes.push(`Could not list service principals (${sps.status}); permissions could not be resolved.`);

  const signIns = await graphList<SignInActivityRecord>(`${GRAPH}/beta/reports/servicePrincipalSignInActivities`, token);
  const signInByAppId = new Map<string, SignInActivityRecord>();
  let signInUsable = false;
  let signInState = "unavailable";
  if (signIns.ok) {
    for (const s of signIns.data) signInByAppId.set(s.appId, s);
    const fresh = signInReportFreshness(signIns.data, now);
    signInUsable = fresh.fresh;
    signInState = fresh.fresh
      ? `current (${signIns.data.length} service principals, newest ${fresh.newest?.toISOString().slice(0, 10)})`
      : `STALE (newest sign-in anywhere in the report: ${fresh.newest?.toISOString().slice(0, 10) ?? "none"})`;
    if (!fresh.fresh)
      report.notes.push(
        `The sign-in activity report is stale: its newest sign-in for ANY app is ${fresh.newest?.toISOString().slice(0, 10) ?? "absent"}, so it cannot say which apps are unused. Rule (a), unused for ${UNUSED_DAYS} days with a live credential, was NOT evaluated. Service-principal sign-in data needs an Entra ID P1 or P2 license on the tenant; until then, check each app's last use from its own logs (the consuming app's send or call history) during the monthly review.`,
      );
  } else {
    report.notes.push(
      `Sign-in activity report unavailable (${signIns.status}: ${signIns.message.slice(0, 120)}). Rule (a), unused for ${UNUSED_DAYS} days, was NOT evaluated. It needs AuditLog.Read.All and an Entra ID P1 or P2 license.`,
    );
  }

  const resourceCache = new Map<string, { appId: string; displayName: string; appRoles: AppRoleDefinition[] }>();
  const loadResource = async (id: string) => {
    if (resourceCache.has(id)) return;
    const r = await apiGet<{ appId: string; displayName: string; appRoles: AppRoleDefinition[] }>(
      `${GRAPH}/v1.0/servicePrincipals/${id}?$select=appId,displayName,appRoles`,
      token,
    );
    if (r.ok) resourceCache.set(id, r.data);
  };

  let mailSendApps = 0;
  await mapPool(withCreds, 4, async (app) => {
    const sp = spByAppId.get(app.appId);
    let assignments: AppRoleAssignment[] = [];
    if (sp) {
      const a = await graphList<AppRoleAssignment>(`${GRAPH}/v1.0/servicePrincipals/${sp.id}/appRoleAssignments`, token);
      if (a.ok) assignments = a.data;
      else report.notes.push(`${app.displayName}: could not read app role assignments (${a.status}).`);
      for (const res of new Set(assignments.map((x) => x.resourceId))) await loadResource(res);
    }
    const granted = resolveAppRoles(assignments, resourceCache);
    if (granted.some((g) => g.value === "Mail.Send")) mailSendApps += 1;
    report.findings.push(
      ...auditApp({
        app,
        hasServicePrincipal: !!sp,
        grantedAppRoles: granted,
        signIn: signInByAppId.get(app.appId) ?? null,
        signInDataAvailable: signInUsable,
        now,
      }),
    );
  });

  report.stats = {
    token_source: reason,
    app_registrations: apps.data.length,
    apps_with_credentials: withCreds.length,
    client_secrets: withCreds.reduce((n, a) => n + a.passwordCredentials.length, 0),
    certificates: withCreds.reduce((n, a) => n + a.keyCredentials.length, 0),
    sign_in_report: signInState,
    apps_with_tenant_wide_mail_send: mailSendApps,
    sensitive_scopes_checked: SENSITIVE_GRAPH_APP_ROLES.join(", "),
  };
  report.notes.push(
    "Mail scoping cannot be verified through Microsoft Graph. Exchange Online \"RBAC for Applications\" grants are a UNION with Entra grants: while an app holds the tenant-wide Entra Mail.Send listed above, an Exchange resource scope narrows nothing, and only a legacy Application Access Policy constrains the Entra grant. For each Mail.* app, in Exchange Online PowerShell run Get-ApplicationAccessPolicy, Get-ManagementRoleAssignment -RoleAssigneeType ServicePrincipal, and Test-ServicePrincipalAuthorization -Identity <appId> -Resource <a mailbox it must NOT reach>. To scope properly: assign \"Application Mail.Send\" in Exchange with a management scope, then remove the Entra grant. Source: https://learn.microsoft.com/en-us/exchange/permissions-exo/application-rbac. Steps: docs/security/monthly-review.md.",
    "Only credentials on app registrations are audited. Credentials added directly to a service principal (rare) are not listed by this check.",
    "\"Unused\" means no client sign-in (app-only or delegated) in the sign-in activity report; an app only ever called as an API resource counts as unused.",
  );
  return emitReport(report, opts);
}

main().then(
  (code) => process.exit(code),
  (e) => {
    process.stderr.write(`security:entra-audit failed: ${(e as Error).stack ?? e}\n`);
    process.exit(2);
  },
);
