/**
 * Shared Azure Cognitive Services client.
 *
 * One credential resolver, one poll helper, one audit hook — shared
 * by vision-ocr.ts (Computer Vision READ) and form-recognizer.ts
 * (Document Intelligence prebuilt-receipt).
 *
 * Why a separate module from `microsoft-graph.ts`: Cognitive Services
 * use a per-resource subscription KEY (header `Ocp-Apim-Subscription-
 * Key`), not the OAuth bearer token Graph uses. Keeping these in
 * different modules prevents accidental key leakage into Graph calls
 * (and vice versa — Graph tokens shipped to Cognitive Services would
 * be a free-tier-busting mistake).
 *
 * Credential resolution per service falls back to a shared multi-
 * service Cognitive Services resource if the per-service env vars
 * aren't set, since the free tier lets you provision EITHER pattern.
 */

export interface AzureCreds {
  endpoint: string;
  key: string;
}

/**
 * Resolve credentials for a given service. Returns null if neither
 * service-specific nor multi-service env vars are present — callers
 * surface this as `not_configured` to the UI instead of fetching
 * with empty values.
 *
 * Per-service env vars (preferred — finer-grained provisioning):
 *   AZURE_VISION_ENDPOINT / AZURE_VISION_KEY
 *   AZURE_FORM_REC_ENDPOINT / AZURE_FORM_REC_KEY
 *
 * Multi-service fallback (used when an admin provisions one
 * Cognitive Services resource that vends every model):
 *   AZURE_COGNITIVE_ENDPOINT / AZURE_COGNITIVE_KEY
 */
export function resolveAzureCreds(
  service: "vision" | "form_recognizer",
): AzureCreds | null {
  const perServicePrefix = service === "vision" ? "AZURE_VISION" : "AZURE_FORM_REC";
  const endpoint =
    process.env[`${perServicePrefix}_ENDPOINT`] ?? process.env.AZURE_COGNITIVE_ENDPOINT ?? "";
  const key =
    process.env[`${perServicePrefix}_KEY`] ?? process.env.AZURE_COGNITIVE_KEY ?? "";
  if (!endpoint || !key) return null;
  /* Strip a trailing slash so callers can build URLs with one
     interpolation pattern without double-slash risk. */
  return { endpoint: endpoint.replace(/\/+$/, ""), key };
}

export interface AzureRequestOptions {
  /** Bytes to upload (the receipt image, page screenshot, etc.). */
  body: Buffer | Uint8Array | string;
  /** Content-Type the Azure endpoint expects (image/png, application/pdf, etc.). */
  contentType: string;
  /** Optional URL query string params appended verbatim. */
  query?: Record<string, string>;
  /** Request timeout in ms. Default 30s. */
  timeoutMs?: number;
}

export type AzureFailure =
  | { code: "not_configured"; detail: string }
  | { code: "rate_limited"; detail: string; retryAfter?: number }
  | { code: "forbidden"; detail: string }
  | { code: "bad_request"; detail: string }
  | { code: "graph_unavailable"; detail: string }
  | { code: "timeout"; detail: string }
  | { code: "polling_timeout"; detail: string }
  | { code: "internal"; detail: string };

export type AzureResult<T> =
  | { ok: true; value: T; latencyMs: number; httpStatus: number }
  | { ok: false; error: AzureFailure; latencyMs: number; httpStatus?: number };

/**
 * POST bytes to an Azure async endpoint. The Cognitive Services
 * pattern is: POST returns 202 with an Operation-Location header;
 * caller polls that URL until `status` field flips to succeeded /
 * failed. This helper kicks off the POST and returns the operation
 * URL — pollAzureOperation drives the wait.
 */
export async function postAzure(
  creds: AzureCreds,
  path: string,
  opts: AzureRequestOptions,
): Promise<AzureResult<{ operationLocation: string }>> {
  const t0 = Date.now();
  const qs = opts.query
    ? "?" + new URLSearchParams(opts.query).toString()
    : "";
  const url = `${creds.endpoint}/${path}${qs}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30_000);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Ocp-Apim-Subscription-Key": creds.key,
        "Content-Type": opts.contentType,
      },
      body: opts.body as BodyInit,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const msg = (err as Error).message ?? "fetch failed";
    if (msg.includes("aborted")) {
      return { ok: false, error: { code: "timeout", detail: `Azure request timed out after ${opts.timeoutMs ?? 30_000}ms` }, latencyMs: Date.now() - t0 };
    }
    return { ok: false, error: { code: "graph_unavailable", detail: msg }, latencyMs: Date.now() - t0 };
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 401 || res.status === 403) {
    return { ok: false, error: { code: "forbidden", detail: `Azure ${res.status} — subscription key invalid or quota exhausted` }, latencyMs: Date.now() - t0, httpStatus: res.status };
  }
  if (res.status === 429) {
    const retryAfter = Number(res.headers.get("retry-after") ?? "60");
    return { ok: false, error: { code: "rate_limited", detail: "Azure 429", retryAfter }, latencyMs: Date.now() - t0, httpStatus: 429 };
  }
  if (res.status === 400) {
    const detail = (await res.text().catch(() => "")).slice(0, 400);
    return { ok: false, error: { code: "bad_request", detail: `Azure 400: ${detail}` }, latencyMs: Date.now() - t0, httpStatus: 400 };
  }
  if (!res.ok) {
    return { ok: false, error: { code: "graph_unavailable", detail: `Azure HTTP ${res.status}` }, latencyMs: Date.now() - t0, httpStatus: res.status };
  }

  const operationLocation = res.headers.get("operation-location") ?? res.headers.get("Operation-Location") ?? "";
  if (!operationLocation) {
    return { ok: false, error: { code: "internal", detail: "Azure 202 without Operation-Location header" }, latencyMs: Date.now() - t0, httpStatus: res.status };
  }
  return { ok: true, value: { operationLocation }, latencyMs: Date.now() - t0, httpStatus: res.status };
}

/**
 * Poll a Cognitive Services operation URL until it terminates. Caps
 * at `maxAttempts` * `intervalMs` total wait so a hung server can't
 * block a request handler forever.
 */
export async function pollAzureOperation<T>(
  creds: AzureCreds,
  operationLocation: string,
  opts: { intervalMs?: number; maxAttempts?: number; timeoutMs?: number } = {},
): Promise<AzureResult<T>> {
  const interval = opts.intervalMs ?? 750;
  const maxAttempts = opts.maxAttempts ?? 30; // ~22s @ 750ms
  const t0 = Date.now();

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, interval));
    let res: Response;
    try {
      res = await fetch(operationLocation, {
        headers: { "Ocp-Apim-Subscription-Key": creds.key, Accept: "application/json" },
        signal: opts.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined,
      });
    } catch (err) {
      return { ok: false, error: { code: "graph_unavailable", detail: (err as Error).message }, latencyMs: Date.now() - t0 };
    }
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("retry-after") ?? "60");
      return { ok: false, error: { code: "rate_limited", detail: "Azure poll 429", retryAfter }, latencyMs: Date.now() - t0, httpStatus: 429 };
    }
    if (!res.ok) {
      return { ok: false, error: { code: "graph_unavailable", detail: `Azure poll HTTP ${res.status}` }, latencyMs: Date.now() - t0, httpStatus: res.status };
    }
    const body = (await res.json().catch(() => ({}))) as { status?: string } & T;
    const status = String(body.status ?? "").toLowerCase();
    if (status === "succeeded") {
      return { ok: true, value: body as T, latencyMs: Date.now() - t0, httpStatus: res.status };
    }
    if (status === "failed") {
      return { ok: false, error: { code: "internal", detail: "Azure operation status=failed" }, latencyMs: Date.now() - t0, httpStatus: res.status };
    }
    /* statuses: notStarted, running — keep polling */
  }
  return { ok: false, error: { code: "polling_timeout", detail: `Azure operation didn't complete after ${maxAttempts * interval}ms` }, latencyMs: Date.now() - t0 };
}
