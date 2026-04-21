"use client";

import { useEffect, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { fetchWithRefresh, jsonHeaders } from "@/lib/client-auth";

/**
 * Surfaces ?ms=* / ?qbo=* query params that the OAuth callbacks set when
 * Microsoft / QuickBooks redirects back. Without this, Azure's error
 * (e.g. AADSTS65001 admin-consent required for .All scopes) is silently
 * swallowed and the user sees a normal dashboard with no reason their
 * connect button didn't work.
 *
 * Fires analytics so learning/ops can see real connection-failure rates
 * per provider + error_code in production, not only in server logs.
 */
export default function IntegrationStatusBanner() {
  const sp = useSearchParams();
  const router = useRouter();
  const [dismissed, setDismissed] = useState(false);

  const ms = sp?.get("ms") ?? null;
  const qbo = sp?.get("qbo") ?? null;
  const detail = sp?.get("detail") ?? null;
  const errorCode = sp?.get("error_code") ?? null;

  useEffect(() => {
    if (!ms && !qbo) return;
    const provider = ms ? "microsoft" : "quickbooks";
    const status = ms ?? qbo ?? "";
    fetchWithRefresh("/api/analytics", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        event: `system.integration_${status === "connected" ? "connected" : "connect_failed"}`,
        metadata: {
          provider,
          status,
          error_code: errorCode ?? null,
          detail: detail ?? null,
        },
      }),
    }).catch(() => {});
  }, [ms, qbo, detail, errorCode]);

  if (dismissed) return null;
  if (!ms && !qbo) return null;

  const provider = ms ? "Microsoft 365" : "QuickBooks";
  const status = ms ?? qbo;
  const isSuccess = status === "connected";
  const isDenied = status === "denied";

  const title = isSuccess
    ? `${provider} connected`
    : isDenied
    ? `${provider} declined access`
    : `${provider} connection error`;

  // Hint copy for the most common admin-consent failures. Exact AADSTS
  // codes come from the Azure error_description.
  const hint = (() => {
    if (isSuccess) return null;
    if (errorCode === "consent_required" || (detail && /AADSTS65001/.test(detail))) {
      return "This app requests tenant-wide scopes (.All) that require a Microsoft 365 Global Admin to grant consent once. Ask your admin to visit the app consent URL, or reduce the requested scopes in src/lib/microsoft-graph.ts.";
    }
    if (detail && /AADSTS50011/.test(detail)) {
      return "Azure says the redirect URI doesn't match. Check that MS_REDIRECT_URI in Vercel matches what is registered in the Azure app — no trailing whitespace, exact host.";
    }
    if (detail && /AADSTS90094/.test(detail)) {
      return "Azure says admin permissions are required. A Global Admin needs to consent on behalf of the tenant.";
    }
    return "Retry from Settings → Integrations. If it keeps failing, check the server logs for the full Azure error description.";
  })();

  function close() {
    setDismissed(true);
    // Strip the ms/qbo/detail/error_code params so a refresh doesn't
    // re-show the banner.
    if (typeof window !== "undefined") {
      const u = new URL(window.location.href);
      ["ms", "qbo", "detail", "error_code", "account", "company"].forEach((k) =>
        u.searchParams.delete(k),
      );
      router.replace(u.pathname + (u.search ? u.search : ""));
    }
  }

  const bg = isSuccess ? "rgba(34, 197, 94, 0.08)" : "rgba(245, 158, 11, 0.08)";
  const border = isSuccess ? "rgba(34, 197, 94, 0.35)" : "rgba(245, 158, 11, 0.35)";
  const fg = isSuccess ? "rgb(74, 222, 128)" : "rgb(251, 191, 36)";

  return (
    <div
      data-testid="integration-status-banner"
      role="status"
      style={{
        padding: "1rem 1.25rem",
        background: bg,
        border: `1px solid ${border}`,
        borderRadius: "10px",
        display: "flex",
        gap: 16,
        alignItems: "flex-start",
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: fg }}>{title}</div>
        {detail ? (
          <div
            style={{
              fontSize: 12,
              marginTop: 4,
              color: "var(--wp-text-dim)",
              overflowWrap: "anywhere",
            }}
          >
            {errorCode ? (
              <>
                <strong style={{ color: "var(--wp-text)" }}>{errorCode}</strong>{" "}
                —{" "}
              </>
            ) : null}
            {detail}
          </div>
        ) : null}
        {hint ? (
          <div
            style={{
              fontSize: 12,
              marginTop: 6,
              color: "var(--wp-text-dim)",
            }}
          >
            {hint}
          </div>
        ) : null}
      </div>
      <button
        type="button"
        data-testid="integration-status-banner-dismiss"
        aria-label="Dismiss"
        onClick={close}
        style={{
          background: "transparent",
          border: "none",
          color: "var(--wp-text-dim)",
          cursor: "pointer",
          fontSize: 18,
          lineHeight: 1,
          padding: 4,
        }}
      >
        ×
      </button>
    </div>
  );
}
