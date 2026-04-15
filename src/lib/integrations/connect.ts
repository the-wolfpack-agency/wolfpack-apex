import { authHeaders } from "@/lib/client-auth";

export async function startMicrosoftConnect(
  opts?: { returnTo?: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await fetch("/api/microsoft?action=auth-url", {
      headers: authHeaders(),
    });
    const data = await res.json();
    if (data.authUrl) {
      let url = data.authUrl as string;
      if (opts?.returnTo) {
        url += (url.includes("?") ? "&" : "?") + "returnTo=" + encodeURIComponent(opts.returnTo);
      }
      window.location.href = url;
      return { ok: true };
    }
    return {
      ok: false,
      error: "Microsoft 365 integration is not configured yet. Contact the CTO to set up the connection.",
    };
  } catch {
    return { ok: false, error: "Unable to start connection. Please try again." };
  }
}

export async function startQuickbooksConnect(
  opts?: { returnTo?: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await fetch("/api/quickbooks?action=auth-url", {
      headers: authHeaders(),
    });
    const data = await res.json();
    if (data.authUrl) {
      let url = data.authUrl as string;
      if (opts?.returnTo) {
        url += (url.includes("?") ? "&" : "?") + "returnTo=" + encodeURIComponent(opts.returnTo);
      }
      window.location.href = url;
      return { ok: true };
    }
    return { ok: false, error: "QuickBooks integration is not configured." };
  } catch {
    return { ok: false, error: "Unable to start connection. Please try again." };
  }
}

export async function connectPlaud(
  plaudConfigured: boolean,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!plaudConfigured) {
    return {
      ok: false,
      error: "Plaud is not configured yet. The CTO needs to add PLAUD_API_KEY and PLAUD_WEBHOOK_SECRET to the production environment first.",
    };
  }
  try {
    const res = await fetch("/api/integrations/plaud", {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ action: "connect" }),
    });
    if (res.ok) return { ok: true };
    const body = await res.json().catch(() => ({}));
    return { ok: false, error: (body as { error?: string }).error || "Unable to connect Plaud." };
  } catch {
    return { ok: false, error: "Unable to connect Plaud. Please try again." };
  }
}
