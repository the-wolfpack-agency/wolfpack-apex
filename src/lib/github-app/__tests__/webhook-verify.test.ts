/**
 * GitHub App webhook signature verification. Real HMAC-SHA256, no mocks: proves
 * a valid signature passes, a tampered body / wrong secret / wrong-length header
 * fails, and a missing secret or missing header fails closed.
 */
import { createHmac } from "node:crypto";
import { verifyWebhookSignature } from "@/lib/github-app/webhook-verify";

const SECRET = "test-webhook-secret";
const sign = (body: string, secret = SECRET) =>
  "sha256=" + createHmac("sha256", secret).update(body, "utf8").digest("hex");

describe("verifyWebhookSignature", () => {
  const body = JSON.stringify({ action: "opened", n: 1 });

  it("accepts a correct signature", () => {
    expect(verifyWebhookSignature(body, sign(body), SECRET)).toBe(true);
  });

  it("rejects a tampered body", () => {
    const sig = sign(body);
    expect(verifyWebhookSignature(body + " ", sig, SECRET)).toBe(false);
  });

  it("rejects a signature made with the wrong secret", () => {
    expect(verifyWebhookSignature(body, sign(body, "other"), SECRET)).toBe(false);
  });

  it("fails closed with no secret configured", () => {
    expect(verifyWebhookSignature(body, sign(body), undefined)).toBe(false);
  });

  it("fails closed with no signature header", () => {
    expect(verifyWebhookSignature(body, null, SECRET)).toBe(false);
  });

  it("rejects a wrong-length header without throwing", () => {
    expect(verifyWebhookSignature(body, "sha256=deadbeef", SECRET)).toBe(false);
  });
});
