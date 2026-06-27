/**
 * ssrf-guard.test.ts — the scanner must refuse internal/loopback/metadata
 * targets so an admin-configured connector baseUrl cannot turn into SSRF.
 */
import {
  assertScannableUrl,
  SsrfBlockedError,
  isPrivateIp,
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

  it("allows a normal public https target", async () => {
    // DNS for a real public host resolves to a public IP; should not throw.
    await expect(assertScannableUrl("https://example.com/")).resolves.toBeUndefined();
  });
});
