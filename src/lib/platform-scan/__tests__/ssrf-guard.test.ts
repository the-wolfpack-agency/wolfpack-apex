/**
 * ssrf-guard.test.ts — the scanner must refuse internal/loopback/metadata
 * targets so an admin-configured connector baseUrl cannot turn into SSRF.
 */
import {
  assertScannableUrl,
  SsrfBlockedError,
  isPrivateIp,
  isPrivateIPv6,
} from "@/lib/platform-scan/ssrf-guard";

describe("isPrivateIp", () => {
  it.each([
    "127.0.0.1",
    "10.0.0.5",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254", // cloud metadata
    "100.64.0.1", // CGNAT
    "::1",
    "fc00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
  ])("flags %s as private", (ip) => {
    expect(isPrivateIp(ip)).toBe(true);
  });

  it.each(["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700:4700::1111"])(
    "treats %s as public",
    (ip) => {
      expect(isPrivateIp(ip)).toBe(false);
    },
  );
});

describe("assertScannableUrl", () => {
  it("blocks a private IP literal", async () => {
    await expect(assertScannableUrl("http://169.254.169.254/latest/meta-data/")).rejects.toBeInstanceOf(SsrfBlockedError);
    await expect(assertScannableUrl("http://127.0.0.1:8080/")).rejects.toBeInstanceOf(SsrfBlockedError);
    await expect(assertScannableUrl("http://10.1.2.3/")).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it("blocks internal hostnames", async () => {
    await expect(assertScannableUrl("http://localhost/")).rejects.toBeInstanceOf(SsrfBlockedError);
    await expect(assertScannableUrl("http://metadata.google.internal/")).rejects.toBeInstanceOf(SsrfBlockedError);
    await expect(assertScannableUrl("http://db.internal/")).rejects.toBeInstanceOf(SsrfBlockedError);
    await expect(assertScannableUrl("http://printer.local/")).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it("blocks non-http(s) schemes", async () => {
    await expect(assertScannableUrl("file:///etc/passwd")).rejects.toBeInstanceOf(SsrfBlockedError);
    await expect(assertScannableUrl("gopher://x/")).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it("rejects an unparseable URL", async () => {
    await expect(assertScannableUrl("not a url")).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it("blocks an IPv6 literal, which URL.hostname wraps in brackets", async () => {
    // The regression this pins: URL.hostname returns "[::1]", not "::1", and
    // net.isIP does not recognize the bracketed form. Every IPv6 literal —
    // loopback, unspecified, unique-local, link-local — passed straight through
    // this guard until 2026-08-02. isPrivateIPv6 already stripped brackets, but
    // isPrivateIp gated on net.isIPv6 first, so that stripping never ran.
    for (const url of [
      "http://[::1]/",
      "http://[::]/",
      "http://[fc00::1]/",
      "http://[fd12:3456::1]/",
      "http://[fe80::1]/",
      "http://[::ffff:127.0.0.1]/",
      "http://[::ffff:169.254.169.254]/",
    ]) {
      await expect(assertScannableUrl(url)).rejects.toBeInstanceOf(SsrfBlockedError);
    }
  });

  it("blocks an IPv4-mapped address in the HEX form URL.hostname produces", async () => {
    // The second half of the same bug. URL.hostname normalizes
    // "::ffff:169.254.169.254" to "::ffff:a9fe:a9fe", so the dotted-quad branch
    // never fired and the AWS metadata endpoint was reachable this way.
    expect(isPrivateIPv6("::ffff:a9fe:a9fe")).toBe(true); // 169.254.169.254
    expect(isPrivateIPv6("::ffff:7f00:1")).toBe(true); // 127.0.0.1
    expect(isPrivateIPv6("::ffff:a00:1")).toBe(true); // 10.0.0.1
    expect(isPrivateIPv6("::ffff:c0a8:1")).toBe(true); // 192.168.0.1
    // A public address in the same form is still allowed.
    expect(isPrivateIPv6("::ffff:0808:0808")).toBe(false); // 8.8.8.8
  });

  it("still allows a public IPv6 literal", async () => {
    // Blocking every IPv6 address would be a different bug. Google public DNS.
    await expect(assertScannableUrl("http://[2001:4860:4860::8888]/")).resolves.toBeUndefined();
  });

  it("allows a normal public https target", async () => {
    // DNS for a real public host resolves to a public IP; should not throw.
    await expect(assertScannableUrl("https://example.com/")).resolves.toBeUndefined();
  });
});
