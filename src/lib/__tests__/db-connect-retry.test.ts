/** @jest-environment node */
/** The connect-acquisition retry: a Neon cold wake that misses the connect
 *  timeout retries once and succeeds; a real query error is not retried (a write
 *  cannot double-apply); a persistent connect failure gives up. */
import { withConnectRetry, isConnectAcquisitionError } from "@/lib/db";

it("classifies only connect-acquisition failures as retryable", () => {
  expect(isConnectAcquisitionError(new Error("timeout exceeded when trying to connect"))).toBe(true);
  expect(isConnectAcquisitionError(new Error("connection terminated unexpectedly"))).toBe(false);
  expect(isConnectAcquisitionError(new Error("duplicate key value violates unique constraint"))).toBe(false);
});
it("retries a cold-wake connect timeout once, then succeeds", async () => {
  let n = 0;
  const run = async () => { n++; if (n === 1) throw new Error("timeout exceeded when trying to connect"); return "ok"; };
  await expect(withConnectRetry(run, 2, 1)).resolves.toBe("ok");
  expect(n).toBe(2);
});
it("does NOT retry a non-connect error", async () => {
  let n = 0;
  const run = async () => { n++; throw new Error("connection terminated unexpectedly"); };
  await expect(withConnectRetry(run, 2, 1)).rejects.toThrow(/terminated/);
  expect(n).toBe(1);
});
