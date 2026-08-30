/**
 * What can we actually see in this Microsoft tenant?
 *
 * WHY THIS EXISTS. It is the first question of every engagement and it has
 * always been answered by asking somebody, waiting, and being told a scope was
 * granted that turns out not to be. A token knows exactly what it can do: the
 * permissions live in its own `roles` claim, and every endpoint answers 200,
 * 403 or 404 without ambiguity.
 *
 * It also answers the Copilot question the playbook now asks a client to
 * answer by hand. If Reports.Read.All happens to be granted, the usage report
 * is one call away and nobody needs to export a CSV.
 *
 * READ ONLY, AND NARROW ON PURPOSE. Every call is a GET, and the Copilot
 * surface it probes is the USAGE report, which carries counts and dates and no
 * prompt text. It deliberately does NOT probe getAllEnterpriseInteractions,
 * which returns full prompts and replies: we do not ask clients for that, so
 * this must not quietly check whether we could take it.
 *
 * Usage:
 *   MS_CLIENT_ID=... MS_CLIENT_SECRET=... MS_TENANT_ID=... \
 *     npx tsx scripts/graph-capability-probe.ts
 *
 * Prints nothing secret. Token claims are summarised, never dumped.
 */

/* Makes this file a module rather than a global script, so its type names do
   not collide with another script's. Without it, tsc treats every top-level
   const in scripts/ as sharing one scope. */
export {};

const TENANT = process.env.MS_TENANT_ID;
const CLIENT_ID = process.env.MS_CLIENT_ID;
const CLIENT_SECRET = process.env.MS_CLIENT_SECRET;

interface Probe {
  name: string;
  url: string;
  /** The permission Microsoft documents for this call. */
  needs: string;
  /** What a 200 would tell us that we could not otherwise know. */
  worth: string;
}

/**
 * Ordered so the cheap, high-value reads come first.
 *
 * Each is a real question somebody asks during onboarding, not an API tour.
 */
const PROBES: Probe[] = [
  {
    name: "Copilot licences in the tenant",
    url: "https://graph.microsoft.com/v1.0/subscribedSkus",
    needs: "Organization.Read.All (or Directory.Read.All)",
    worth: "whether Copilot is licensed at all, before asking anybody about usage",
  },
  {
    name: "Copilot usage, last 7 days",
    url: "https://graph.microsoft.com/v1.0/copilot/reports/getMicrosoft365CopilotUsageUserDetail(period='D7',version='v2')",
    needs: "Reports.Read.All",
    worth: "prompts submitted and active days per person, with no prompt text",
  },
  {
    name: "Service usage, are people in the tenant at all",
    url: "https://graph.microsoft.com/v1.0/reports/getOffice365ActiveUserDetail(period='D7')",
    needs: "Reports.Read.All",
    worth: "which M365 surfaces are actually used, the denominator for adoption",
  },
  {
    name: "SharePoint sites",
    url: "https://graph.microsoft.com/v1.0/sites?search=*&$top=1",
    needs: "Sites.Read.All",
    worth: "whether a library can be reached without a per-user grant",
  },
  {
    name: "Directory, people and roles",
    url: "https://graph.microsoft.com/v1.0/users?$top=1&$select=id",
    needs: "User.Read.All",
    worth: "the roster Phase 1 scopes retrieval against",
  },
];

interface TokenClaims {
  roles?: string[];
  appid?: string;
  tid?: string;
}

/** Reads the token's own claims. No verification: we minted it a line ago. */
function claimsOf(jwt: string): TokenClaims {
  try {
    const payload = jwt.split(".")[1];
    return JSON.parse(Buffer.from(payload, "base64").toString("utf8")) as TokenClaims;
  } catch {
    return {};
  }
}

async function getToken(): Promise<string | null> {
  const res = await fetch(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID!,
      client_secret: CLIENT_SECRET!,
      scope: "https://graph.microsoft.com/.default",
      grant_type: "client_credentials",
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error(`\nCould not get a token: HTTP ${res.status}`);
    /* The message names the misconfiguration; it carries no secret. */
    console.error(detail.slice(0, 300));
    return null;
  }
  return ((await res.json()) as { access_token?: string }).access_token ?? null;
}

(async () => {
  if (!TENANT || !CLIENT_ID || !CLIENT_SECRET) {
    console.error("Needs MS_TENANT_ID, MS_CLIENT_ID and MS_CLIENT_SECRET.");
    console.error("They live in Vercel production; `vercel env pull` returns [SENSITIVE] for them,");
    console.error("so they have to be supplied directly for a local run.");
    process.exit(2);
  }

  const token = await getToken();
  if (!token) process.exit(1);

  const claims = claimsOf(token);
  const granted = (claims.roles ?? []).sort();
  console.log(`\nApp-only token for tenant ${claims.tid ?? "?"}`);
  console.log(
    granted.length > 0
      ? `Application permissions granted (${granted.length}):\n  ${granted.join("\n  ")}`
      : "Application permissions granted: NONE.\n  This app is delegated-only, so every probe below will refuse.",
  );

  console.log("\nWhat this tenant will actually answer:\n");
  let reachable = 0;
  for (const p of PROBES) {
    let line: string;
    try {
      const res = await fetch(p.url, { headers: { authorization: `Bearer ${token}` } });
      if (res.ok) {
        reachable += 1;
        line = "YES    ";
      } else if (res.status === 403) {
        line = "no 403 ";
      } else if (res.status === 404) {
        /* 404 on a report usually means the feature is not licensed rather
           than that the URL is wrong, and the two are worth telling apart. */
        line = "no 404 ";
      } else {
        line = `no ${res.status} `;
      }
    } catch (err) {
      line = "error  ";
      void err;
    }
    console.log(`  ${line} ${p.name}`);
    console.log(`          needs ${p.needs}`);
    console.log(`          gives ${p.worth}\n`);
  }

  console.log(`${reachable} of ${PROBES.length} reachable with the permissions this app holds today.`);
  if (reachable === 0) {
    console.log(
      "\nThat is the expected answer for a delegated-only app, and it is not a fault.\n" +
        "It means anything above has to be granted deliberately, which is the\n" +
        "conversation the playbook says to have rather than assume.",
    );
  }
  process.exit(0);
})().catch((err) => {
  console.error("probe failed:", (err as Error).message.slice(0, 200));
  process.exit(1);
});
