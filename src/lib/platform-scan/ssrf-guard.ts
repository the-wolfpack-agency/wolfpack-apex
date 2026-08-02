/**
 * SSRF guard for the platform scanner.
 *
 * The scanner fetches a target baseUrl server-side. Curated manifest targets are
 * safe, but a target can also come from a workspace connector's admin-configured
 * baseUrl. Without validation, an admin (or a stolen admin token) could point a
 * connector at an internal address (cloud metadata 169.254.169.254, loopback,
 * RFC1918) and make our server fetch it, turning app-admin into infra-secret
 * access. This guard blocks non-http(s) schemes, private/loopback/link-local IP
 * literals, internal hostnames, AND public hostnames that RESOLVE to a private
 * IP (the DNS-pointing vector), before any fetch is issued.
 */
import { lookup } from "node:dns/promises";
import net from "node:net";

export class SsrfBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrfBlockedError";
  }
}

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata",
  "metadata.google.internal",
]);

export function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map((n) => Number(n));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts;
  return (
    a === 0 || // "this" network
    a === 10 || // RFC1918
    a === 127 || // loopback
    (a === 169 && b === 254) || // link-local incl. cloud metadata
    (a === 172 && b >= 16 && b <= 31) || // RFC1918
    (a === 192 && b === 168) || // RFC1918
    (a === 100 && b >= 64 && b <= 127) // CGNAT RFC6598
  );
}

export function isPrivateIPv6(ip: string): boolean {
  const x = ip.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (x === "::1" || x === "::") return true;
  // IPv4-mapped (::ffff:a.b.c.d) -> check the embedded v4.
  if (x.startsWith("::ffff:")) {
    const rest = x.slice("::ffff:".length);
    if (net.isIPv4(rest)) return isPrivateIPv4(rest);
    // ...but URL.hostname NORMALISES the dotted form to hex, so
    // "::ffff:169.254.169.254" arrives as "::ffff:a9fe:a9fe" and the check
    // above never fires. Decode the two hex groups back to a dotted quad.
    // Without this, the AWS metadata endpoint was reachable in IPv4-mapped
    // form. Found 2026-08-02 while testing redirect handling.
    const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(rest);
    if (hex) {
      const hi = parseInt(hex[1], 16);
      const lo = parseInt(hex[2], 16);
      const v4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
      return isPrivateIPv4(v4);
    }
  }
  // Unique-local (fc00::/7) and link-local (fe80::/10).
  return x.startsWith("fc") || x.startsWith("fd") || x.startsWith("fe8") || x.startsWith("fe9") || x.startsWith("fea") || x.startsWith("feb");
}

export function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) return isPrivateIPv4(ip);
  if (net.isIPv6(ip)) return isPrivateIPv6(ip);
  return false;
}

/**
 * Throws SsrfBlockedError if `raw` is not a safe public http(s) target. Resolves
 * DNS so a public hostname pointing at a private IP is still blocked. A transient
 * DNS failure is NOT treated as blocked: the subsequent fetch will fail on its
 * own, and failing closed on every resolver hiccup would break legitimate scans.
 */
export async function assertScannableUrl(raw: string): Promise<void> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new SsrfBlockedError(`invalid scan URL: ${raw}`);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    throw new SsrfBlockedError(`blocked scan scheme: ${u.protocol}`);
  }
  // URL.hostname keeps the brackets around an IPv6 literal ("[::1]"), and
  // net.isIP does not recognise that form — so every IPv6 literal, loopback and
  // link-local included, walked straight through this guard. Strip them before
  // any check. Found by a redirect test in the compliance scanner; it affected
  // every caller of this function, not just that one.
  const host = u.hostname.toLowerCase().replace(/^\[(.+)\]$/, "$1");
  if (BLOCKED_HOSTNAMES.has(host) || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new SsrfBlockedError(`blocked internal host: ${host}`);
  }
  if (net.isIP(host) && isPrivateIp(host)) {
    throw new SsrfBlockedError(`blocked private IP literal: ${host}`);
  }
  try {
    const results = await lookup(host, { all: true });
    for (const r of results) {
      if (isPrivateIp(r.address)) {
        throw new SsrfBlockedError(`host ${host} resolves to a private IP (${r.address})`);
      }
    }
  } catch (err) {
    if (err instanceof SsrfBlockedError) throw err;
    // Transient resolver failure: let the fetch fail naturally.
  }
}
