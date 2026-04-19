/**
 * /share/[token] — PUBLIC unauthenticated preview + approval page.
 *
 * Outside the (dashboard) route group so no auth shell is mounted. The
 * signed token is the credential. On first hit we:
 *   1. Verify the token (signature + DB row + expiry). Invalid → clean
 *      "link expired" 404-style screen.
 *   2. Fetch the site's display_name + preview_url via the server-side
 *      `getSiteProject` so this page ships zero client-side JWT flow.
 *   3. Render: banner, full-bleed iframe of the deployed preview,
 *      sticky bottom bar with Approve / Request changes / comment +
 *      optional reviewer name + email inputs.
 *
 * noindex:
 *   - <meta robots> tag inline (belt)
 *   - x-robots-tag header on the public approval POST (suspenders)
 *   A reviewer's link must NEVER show up in Google.
 *
 * Analytics: `site.share_link_accessed` is fired from the public
 * approval POST (server side) — we don't need a browser-side event
 * because the server sees the request. Keeps the secret + the token
 * blob out of any analytics payload.
 */

import { getShareSecret, loadActiveTokenRow, verifyShareToken, touchShareTokenAccess } from "@/lib/share-tokens";
import { getSiteProject } from "@/lib/sites";
import { trackEvent } from "@/lib/analytics";
import ShareApprovalPanel from "./ShareApprovalPanel";

export const dynamic = "force-dynamic";
// Per-token metadata — keep the tab title generic so a shoulder-surfer
// can't infer the client name from the browser tab.
export const metadata = {
  title: "Preview for your review",
  robots: { index: false, follow: false },
};

export default async function SharePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const secret = getShareSecret();
  const verified = verifyShareToken(token, secret);

  if (!verified.ok) {
    return <InvalidShareLink reason={verified.reason} />;
  }
  const row = await loadActiveTokenRow(verified.claims.nonce);
  if (!row || row.site_id !== verified.claims.siteId) {
    return <InvalidShareLink reason="revoked_or_unknown" />;
  }

  const project = await getSiteProject(verified.claims.siteId);
  if (!project) {
    return <InvalidShareLink reason="site_missing" />;
  }

  // Fire the access event server-side — don't make the browser emit
  // analytics with the token blob in its request URL.
  try {
    await touchShareTokenAccess(row.id);
  } catch {
    /* best-effort */
  }
  trackEvent("site.share_link_accessed", "public", "client", {
    site_id: project.id,
    token_nonce: row.nonce,
    access_count: row.access_count + 1,
  });

  const previewUrl = project.preview_url;

  return (
    <div
      data-testid="share-page-root"
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        background: "#0a0a0a",
        color: "#f0f0f0",
        fontFamily:
          "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
      }}
    >
      {/* Belt: meta robots inline as well as the page metadata export */}
      <meta name="robots" content="noindex, nofollow" />
      <header
        data-testid="share-banner"
        style={{
          padding: "12px 20px",
          background: "linear-gradient(180deg, #151515 0%, #0a0a0a 100%)",
          borderBottom: "1px solid #222",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: "8px",
        }}
      >
        <div>
          <div style={{ fontSize: 12, color: "#888", letterSpacing: "0.05em" }}>
            PREVIEW SHARED FOR YOUR REVIEW
          </div>
          <div style={{ fontSize: 18, fontWeight: 600 }}>
            {project.display_name}
          </div>
        </div>
        <div style={{ fontSize: 12, color: "#888" }}>
          powered by Wolfpack Instinct
        </div>
      </header>

      <main
        style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}
      >
        {previewUrl ? (
          <iframe
            data-testid="share-preview-iframe"
            src={previewUrl}
            title={`${project.display_name} preview`}
            style={{
              flex: 1,
              width: "100%",
              border: "none",
              background: "#fff",
              minHeight: "60vh",
            }}
          />
        ) : (
          <div
            data-testid="share-no-preview"
            style={{
              flex: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: "40px 20px",
              textAlign: "center",
              color: "#888",
            }}
          >
            <div>
              <div style={{ fontSize: 16, marginBottom: 8 }}>
                Preview is not ready yet.
              </div>
              <div style={{ fontSize: 13 }}>
                Your designer will let you know once the first deploy
                lands, then refresh this page.
              </div>
            </div>
          </div>
        )}
      </main>

      <ShareApprovalPanel token={token} />
    </div>
  );
}

function InvalidShareLink({ reason }: { reason: string }) {
  return (
    <div
      data-testid="share-invalid-root"
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#0a0a0a",
        color: "#f0f0f0",
        fontFamily:
          "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
        padding: 20,
      }}
    >
      <meta name="robots" content="noindex, nofollow" />
      <div style={{ maxWidth: 420, textAlign: "center" }}>
        <div
          style={{ fontSize: 12, color: "#888", letterSpacing: "0.05em", marginBottom: 8 }}
        >
          WOLFPACK INSTINCT
        </div>
        <h1 style={{ fontSize: 24, fontWeight: 600, marginBottom: 12 }}>
          This share link is no longer active
        </h1>
        <p style={{ color: "#aaa", lineHeight: 1.5 }}>
          Contact the person who sent you this link for a new preview
          URL. For your protection, share links expire and can be
          revoked at any time.
        </p>
        <div
          data-testid="share-invalid-reason"
          style={{ marginTop: 16, fontSize: 11, color: "#555" }}
        >
          reason: {reason}
        </div>
      </div>
    </div>
  );
}
