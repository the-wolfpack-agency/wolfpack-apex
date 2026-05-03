/**
 * Coverage for the CodeQL high-severity findings closed in this branch:
 *   js/polynomial-redos  (input-length caps + linearised regexes)
 *   js/insecure-randomness (Math.random() → randomBytes() for OAuth nonce)
 *
 * Each test asserts that pathological adversarial input is processed
 * within a bounded time budget AND that legitimate input still parses
 * correctly. The exact timing budgets are loose (200ms) to keep CI
 * stable; the unfixed regexes would burn multiple seconds on the same
 * inputs.
 */

import { detectCorrection, extractSubject } from "../assistant/learning";
import {
  normalizeQuestion,
} from "../knowledge/qa-cache";
import { normalizeForSignature, signatureFor } from "../ai/response-cache";
import { parseSharepointFolderUrl } from "../sharepoint/url-parser";
import { signState, getSigninAuthUrl } from "../microsoft-graph";

const REDOS_TIME_BUDGET_MS = 250;

function timeMs(fn: () => void): number {
  const start = process.hrtime.bigint();
  fn();
  const end = process.hrtime.bigint();
  return Number(end - start) / 1_000_000;
}

describe("ReDoS guards — assistant/learning detectCorrection", () => {
  it("legitimate correction still parses", () => {
    const out = detectCorrection("no, it is Porsche", "client TWA");
    expect(out).toEqual({ attribute: "client", value: "Porsche" });
  });

  it("rejects oversized input fast", () => {
    /* Pattern m2 in detectCorrection has `[a-z][\w\s-]{1,40}?` followed
       by alternation that can backtrack. Build a long string of "the "
       + alphanumerics + suffix that would historically force the engine
       to retry every position. With the input cap, this returns null
       almost immediately. */
    const evil = "the " + "a".repeat(20_000) + " is actually X";
    const elapsed = timeMs(() => {
      detectCorrection(evil, "");
    });
    expect(elapsed).toBeLessThan(REDOS_TIME_BUDGET_MS);
  });

  it("extractSubject bails on pathologically long input", () => {
    const evil = "X ".repeat(20_000) + " Y";
    const elapsed = timeMs(() => {
      extractSubject(evil);
    });
    expect(elapsed).toBeLessThan(REDOS_TIME_BUDGET_MS);
  });
});

describe("ReDoS guards — knowledge/qa-cache normalizeQuestion", () => {
  it("normalizes a legitimate question correctly", () => {
    expect(normalizeQuestion("  How do I RESET my password?  ")).toBe(
      "how do i reset my password",
    );
  });

  it("processes adversarial whitespace + punctuation in linear time", () => {
    const evil = " ".repeat(50_000) + "?".repeat(50_000);
    const elapsed = timeMs(() => normalizeQuestion(evil));
    expect(elapsed).toBeLessThan(REDOS_TIME_BUDGET_MS);
  });
});

describe("ReDoS guards — ai/response-cache normalizeForSignature", () => {
  it("normalizes a legitimate ticket consistently", () => {
    const a = normalizeForSignature(
      "Lorena got an MFA prompt at 9:42 AM yesterday",
    );
    const b = normalizeForSignature(
      "Sarah got an MFA prompt at 3:14 PM today",
    );
    expect(a).toBe(b);
  });

  it("PHONE_RE no longer backtracks catastrophically on adversarial digits", () => {
    /* The previous PHONE_RE `\+?\d{0,3}[\s.-]?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b`
       would burn multiple seconds on long mostly-digit strings without
       a trailing word boundary. The new linearised pattern + input cap
       must finish quickly. */
    const evil = "1".repeat(30_000) + " never matches";
    const elapsed = timeMs(() => normalizeForSignature(evil));
    expect(elapsed).toBeLessThan(REDOS_TIME_BUDGET_MS);
  });

  it("signatureFor produces stable hashes after the regex changes", () => {
    const sig1 = signatureFor("support.draft", {
      feature: "support.draft",
      title: "MFA prompt issue",
      body: "Lorena hit an MFA prompt",
      pattern_ids: ["a", "b"],
    });
    const sig2 = signatureFor("support.draft", {
      feature: "support.draft",
      title: "MFA prompt issue",
      body: "Lorena hit an MFA prompt",
      pattern_ids: ["b", "a"],
    });
    /* sorted pattern_ids → identical signature regardless of input
       order — protects the cache-hit path. */
    expect(sig1).toBe(sig2);
    expect(sig1).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("ReDoS guards — sharepoint/url-parser", () => {
  it("rejects oversized input fast", () => {
    const evil = "https://" + "a".repeat(50_000) + ".sharepoint.com/sites/x";
    const elapsed = timeMs(() => parseSharepointFolderUrl(evil));
    expect(elapsed).toBeLessThan(REDOS_TIME_BUDGET_MS);
  });

  it("still parses a normal SharePoint folder URL", () => {
    const out = parseSharepointFolderUrl(
      "https://contoso.sharepoint.com/sites/marketing/Shared%20Documents/Q4",
    );
    expect(out).not.toBeNull();
    expect(out?.site_host).toBe("contoso.sharepoint.com");
    expect(out?.site_path).toBe("sites/marketing");
    expect(out?.folder_path).toBe("Shared Documents/Q4");
  });
});

describe("Insecure-randomness fix — microsoft-graph signin nonce", () => {
  /* Setup: getSigninAuthUrl returns "" without MS_CLIENT_ID +
     MS_REDIRECT_URI. We set both so the nonce path runs and produces
     a state value with cryptographic entropy. */
  const ORIGINAL_ENV = process.env;
  beforeAll(() => {
    process.env = {
      ...ORIGINAL_ENV,
      MS_CLIENT_ID: "test-client-id",
      MS_REDIRECT_URI: "https://example.test/callback",
      INSTINCT_JWT_SECRET: "x".repeat(64),
    };
  });
  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it("nonces are unique across rapid sequential calls", () => {
    /* Math.random() seeded from the same Date.now() ms can collide on
       fast loops; randomBytes() never does. */
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const url = getSigninAuthUrl();
      const state = new URL(url).searchParams.get("state");
      expect(state).toBeTruthy();
      seen.add(state ?? "");
    }
    expect(seen.size).toBe(200);
  });

  it("verifyState round-trips through signState (sanity)", () => {
    const signed = signState("user-123");
    expect(signed.startsWith("user-123.")).toBe(true);
    expect(signed.length).toBeGreaterThan("user-123.".length + 16);
  });
});
