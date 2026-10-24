/**
 * Read-only Azure and Microsoft Graph access for the scheduled checks.
 *
 * Tokens come from the az CLI, which is signed in locally by the operator and
 * in Actions by azure/login with GitHub OIDC (no stored secret). A token
 * passed in GRAPH_TOKEN / ARM_TOKEN wins, for runners that mint their own.
 *
 * Never throws: every call returns a typed result, because "this API needs a
 * permission we do not have" is an answer the report must carry, not a crash.
 */
import { execFile } from "node:child_process";

export type ApiResult<T> = { ok: true; data: T } | { ok: false; status: number | null; message: string };

export function az(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile("az", args, { maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err ? 1 : 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") || (err ? err.message : "") });
    });
  });
}

/** Access token for a resource, or null with the reason. */
export async function getToken(resource: string, envVar: string): Promise<{ token: string | null; reason: string }> {
  const fromEnv = process.env[envVar];
  if (fromEnv) return { token: fromEnv, reason: `${envVar}` };
  const r = await az(["account", "get-access-token", "--resource", resource, "--query", "accessToken", "-o", "tsv"]);
  if (r.code !== 0 || !r.stdout.trim()) {
    return { token: null, reason: (r.stderr || "az returned no token").trim().split("\n")[0].slice(0, 200) };
  }
  return { token: r.stdout.trim(), reason: "az CLI" };
}

async function request<T>(url: string, token: string, init: { method?: string; body?: unknown } = {}): Promise<ApiResult<T>> {
  for (let attempt = 0; attempt < 4; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: init.method ?? "GET",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      });
    } catch (e) {
      if (attempt === 3) return { ok: false, status: null, message: (e as Error).message };
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      continue;
    }
    if (res.ok) {
      try {
        return { ok: true, data: (await res.json()) as T };
      } catch {
        return { ok: false, status: res.status, message: "response was not JSON" };
      }
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      const wait = Number(res.headers.get("retry-after") ?? res.headers.get("x-ms-ratelimit-microsoft.costmanagement-entity-retry-after") ?? 0);
      await new Promise((r) => setTimeout(r, Math.min(Math.max(wait, attempt + 1), 60) * 1000));
      continue;
    }
    const text = await res.text().catch(() => "");
    return { ok: false, status: res.status, message: text.slice(0, 300) };
  }
  return { ok: false, status: null, message: "retries exhausted" };
}

export function apiGet<T>(url: string, token: string): Promise<ApiResult<T>> {
  return request<T>(url, token);
}

/** POST to a read-only query endpoint (Cost Management query). */
export function apiQuery<T>(url: string, token: string, body: unknown): Promise<ApiResult<T>> {
  return request<T>(url, token, { method: "POST", body });
}

/** Follow @odata.nextLink until the collection is complete. */
export async function graphList<T>(url: string, token: string): Promise<ApiResult<T[]>> {
  const out: T[] = [];
  let next: string | undefined = url;
  while (next) {
    const r: ApiResult<{ value: T[]; "@odata.nextLink"?: string }> = await apiGet(next, token);
    if (!r.ok) return r;
    out.push(...(r.data.value ?? []));
    next = r.data["@odata.nextLink"];
  }
  return { ok: true, data: out };
}
