/** A resolver that never answers must not hang the scan guard (2026-10-26 CI timeout). */
jest.mock("node:dns/promises", () => ({ lookup: jest.fn(() => new Promise(() => {})) }));
import { assertScannableUrl, DNS_TIMEOUT_MS } from "@/lib/platform-scan/ssrf-guard";

it("gives up on a hung DNS lookup after DNS_TIMEOUT_MS, treated like any resolver failure (no throw)", async () => {
  jest.useFakeTimers();
  const p = assertScannableUrl("https://slow-resolver.example/");
  jest.advanceTimersByTime(DNS_TIMEOUT_MS + 1);
  await expect(p).resolves.toBeUndefined();
  jest.useRealTimers();
});

it("still blocks a private IP literal without any lookup", async () => {
  await expect(assertScannableUrl("http://10.0.0.5/")).rejects.toThrow(/private IP literal/);
});
