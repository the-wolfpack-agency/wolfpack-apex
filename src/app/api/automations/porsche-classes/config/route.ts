/**
 * GET / PUT /api/automations/porsche-classes/config — operator-managed
 * configuration for the porsche-classes automation.
 *
 * The wizard at /automations/porsche-classes/setup is the only consumer.
 * Two payloads are stored (see config-repo.ts):
 *
 *   - 'inbox_filters'  → which sender / subject patterns ingest
 *   - 'sharepoint'     → where to drop generated class summaries
 *
 * GET returns the current config plus computed status flags so the
 * wizard can render the green/yellow/red indicators in one round trip:
 *
 *   {
 *     inbox_filters: {sender_match, subject_match},
 *     sharepoint: {site_id, drive_id, path} | null,
 *     status: {
 *       graph_connected: boolean,
 *       inbox_filter_set: boolean,
 *       sharepoint_set: boolean,
 *     }
 *   }
 *
 * PUT accepts an optional partial body. Either field can be omitted —
 * we only write what the operator changed in this turn:
 *
 *   { inbox_filters?, sharepoint? }
 *
 * The `sharepoint` field accepts EITHER a fully-resolved triple OR a
 * raw "share this folder" URL — when only `url` is provided we parse +
 * call Graph to resolve site_id + drive_id. The wizard sends a URL by
 * default; the typed shape is documented for future programmatic
 * callers + tests.
 *
 * Auth:
 *   GET — automations.view
 *   PUT — automations.run (no automations.manage capability exists yet
 *         per src/lib/auth/capabilities.ts; .run is the closest write
 *         capability + is already granted to the program owner role).
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { getAutomation } from "@/lib/automations/registry";
import {
  getInboxFilters,
  getSharepointConfig,
  setInboxFilters,
  setSharepointConfig,
  type InboxFiltersConfig,
  type SharepointConfig,
} from "@/lib/automations/porsche-classes/config-repo";
import {
  parseSharepointFolderUrl,
  resolveSiteAndDrive,
} from "@/lib/sharepoint/url-parser";
import { getValidToken } from "@/lib/microsoft-graph";
import { trackEvent } from "@/lib/analytics";

const AUTOMATION_ID = "porsche-classes";

interface ConfigResponse {
  inbox_filters: InboxFiltersConfig;
  sharepoint: SharepointConfig | null;
  status: {
    graph_connected: boolean;
    inbox_filter_set: boolean;
    sharepoint_set: boolean;
  };
}

/* ------------------------------------------------------------------ */
/* GET — read current config + status                                 */
/* ------------------------------------------------------------------ */

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = await requireCapability(req, "automations.view");
  if (!auth.ok) return auth.response;

  /* Sanity check the automation registry is wired. A 404 here would
     indicate a deploy-time bug, not user error. */
  if (!getAutomation(AUTOMATION_ID)) {
    return NextResponse.json(
      { error: "porsche-classes automation not registered" },
      { status: 500 },
    );
  }

  /* Run the four reads in parallel — they're independent and the
     wizard is interactive. Each helper soft-fails to a sensible
     default on its own so a DB outage doesn't blank the page. */
  const [filters, sharepoint, msToken] = await Promise.all([
    getInboxFilters(),
    getSharepointConfig(),
    getValidToken(auth.user.id),
  ]);

  const status = {
    graph_connected: msToken !== null,
    inbox_filter_set:
      (filters.sender_match.length ?? 0) > 0 ||
      (filters.subject_match.length ?? 0) > 0,
    sharepoint_set: sharepoint !== null,
  };

  trackEvent("automations.config_viewed", auth.user.id, auth.user.role, {
    automation_id: AUTOMATION_ID,
  });

  const body: ConfigResponse = {
    inbox_filters: filters,
    sharepoint,
    status,
  };
  return NextResponse.json(body);
}

/* ------------------------------------------------------------------ */
/* PUT — partial update                                                */
/* ------------------------------------------------------------------ */

interface PutBodyInboxFilters {
  sender_match?: unknown;
  subject_match?: unknown;
}

interface PutBodySharepointResolved {
  site_id?: unknown;
  drive_id?: unknown;
  path?: unknown;
}

interface PutBodySharepointUrl {
  url?: unknown;
}

interface PutBody {
  inbox_filters?: PutBodyInboxFilters;
  sharepoint?: PutBodySharepointResolved & PutBodySharepointUrl;
}

function asStringArray(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== "string") return null;
    out.push(item);
  }
  return out;
}

export async function PUT(req: NextRequest): Promise<NextResponse> {
  /* automations.manage doesn't exist (verified against
     src/lib/auth/capabilities.ts); .run is the spec-mandated fallback. */
  const auth = await requireCapability(req, "automations.run");
  if (!auth.ok) return auth.response;

  let body: PutBody;
  try {
    body = (await req.json()) as PutBody;
  } catch {
    return NextResponse.json(
      { error: "Body wasn't valid JSON. Try saving again." },
      { status: 400 },
    );
  }

  const fieldsChanged: string[] = [];

  /* ---- inbox_filters ------------------------------------------------ */
  if (body.inbox_filters !== undefined) {
    const senderMatch = asStringArray(body.inbox_filters.sender_match);
    const subjectMatch = asStringArray(body.inbox_filters.subject_match);
    if (senderMatch === null || subjectMatch === null) {
      return NextResponse.json(
        {
          error:
            "Each email field must be a list of email addresses or text snippets.",
        },
        { status: 400 },
      );
    }
    try {
      await setInboxFilters(
        { sender_match: senderMatch, subject_match: subjectMatch },
        auth.user.email,
      );
      fieldsChanged.push("inbox_filters");
    } catch (err) {
      return NextResponse.json(
        {
          error: `Saving the email settings didn't work: ${(err as Error).message}`,
        },
        { status: 500 },
      );
    }
  }

  /* ---- sharepoint --------------------------------------------------- */
  if (body.sharepoint !== undefined) {
    const sp = body.sharepoint;
    let resolved: SharepointConfig | null = null;

    if (typeof sp.url === "string" && sp.url.trim().length > 0) {
      /* Operator pasted a folder URL — parse + resolve via Graph. */
      const parsed = parseSharepointFolderUrl(sp.url);
      if (!parsed) {
        return NextResponse.json(
          {
            error:
              "We couldn't read that link as a SharePoint folder. Open the folder in your browser, copy the URL, and paste it again.",
          },
          { status: 400 },
        );
      }
      const r = await resolveSiteAndDrive(auth.user.id, parsed);
      if (!r.ok) {
        const msg = explainResolveError(r.error);
        return NextResponse.json({ error: msg }, { status: 400 });
      }
      resolved = {
        site_id: r.resolved.site_id,
        drive_id: r.resolved.drive_id,
        path: r.resolved.folder_path,
      };
    } else if (
      typeof sp.site_id === "string" &&
      typeof sp.drive_id === "string" &&
      typeof sp.path === "string"
    ) {
      /* Operator (or programmatic caller) handed us the resolved triple. */
      resolved = {
        site_id: sp.site_id,
        drive_id: sp.drive_id,
        path: sp.path,
      };
    } else {
      return NextResponse.json(
        {
          error:
            "Tell us where to save summaries — paste a SharePoint folder URL.",
        },
        { status: 400 },
      );
    }

    try {
      await setSharepointConfig(resolved, auth.user.email);
      fieldsChanged.push("sharepoint");
    } catch (err) {
      return NextResponse.json(
        {
          error: `Saving the SharePoint folder didn't work: ${(err as Error).message}`,
        },
        { status: 500 },
      );
    }
  }

  if (fieldsChanged.length === 0) {
    return NextResponse.json(
      {
        error:
          "Nothing to save — provide inbox_filters or sharepoint in the request body.",
      },
      { status: 400 },
    );
  }

  trackEvent("automations.config_updated", auth.user.id, auth.user.role, {
    automation_id: AUTOMATION_ID,
    fields: fieldsChanged.join(","),
  });

  /* Read-back so the wizard can re-render with fresh status flags
     without a second round trip. */
  const [filters, sharepoint, msToken] = await Promise.all([
    getInboxFilters(),
    getSharepointConfig(),
    getValidToken(auth.user.id),
  ]);

  const responseBody: ConfigResponse = {
    inbox_filters: filters,
    sharepoint,
    status: {
      graph_connected: msToken !== null,
      inbox_filter_set:
        filters.sender_match.length > 0 || filters.subject_match.length > 0,
      sharepoint_set: sharepoint !== null,
    },
  };
  return NextResponse.json(responseBody);
}

/**
 * Translate the typed resolveSiteAndDrive error into a plain-language
 * sentence the operator can act on. The wizard surfaces this verbatim.
 */
function explainResolveError(
  err: import("@/lib/sharepoint/url-parser").ResolveError,
): string {
  switch (err.kind) {
    case "no_token":
      return "Outlook isn't connected. Connect Outlook in Step 1 and try again.";
    case "site_not_found":
      return "We couldn't find that SharePoint site. Check that the URL points to a folder you can open in your browser.";
    case "library_not_found":
      return `We couldn't find a document library called "${err.library}" in that site. Pick a folder inside the default Documents library and try again.`;
    case "drive_not_found":
      return "We couldn't find the document library for that link. Try a different folder URL.";
    case "graph_error":
      return `Microsoft returned an error (${err.status}). Try again in a moment.`;
  }
}
