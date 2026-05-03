/**
 * Tests for src/lib/automations/dedup.ts — canonical artifact dedup-key
 * computation. These cover the four cases the spec calls out:
 *
 *   1. Same internet_message_id → same dedup_key (DUP)
 *   2. Different internet_message_id, same subject + sender → different
 *      dedup_keys (NOT DUP)
 *   3. Missing internet_message_id, same body → same dedup_key (DUP)
 *   4. Missing internet_message_id, different body → different dedup_keys
 *      (NOT DUP)
 *
 * Plus shape-level guarantees:
 *   - normalizeInternetMessageId strips angle brackets + lowercases
 *   - strategy field reports which path produced the key
 *   - non-string inputs (null/undefined) don't crash
 */

import {
  computeDedupKey,
  normalizeInternetMessageId,
} from "@/lib/automations/dedup";

describe("normalizeInternetMessageId", () => {
  it("strips a single pair of angle brackets", () => {
    expect(normalizeInternetMessageId("<abc@host>")).toBe("abc@host");
  });

  it("strips repeated angle brackets and trims whitespace", () => {
    expect(normalizeInternetMessageId("  <<<abc@host>>>  ")).toBe("abc@host");
  });

  it("lowercases the result", () => {
    expect(normalizeInternetMessageId("ABC@HOST.com")).toBe("abc@host.com");
  });

  it("returns null for falsy / empty inputs", () => {
    expect(normalizeInternetMessageId(null)).toBeNull();
    expect(normalizeInternetMessageId(undefined)).toBeNull();
    expect(normalizeInternetMessageId("")).toBeNull();
    expect(normalizeInternetMessageId("   ")).toBeNull();
    expect(normalizeInternetMessageId("<>")).toBeNull();
  });
});

describe("computeDedupKey — internet_message_id path (PRIMARY)", () => {
  it("same internet_message_id ⇒ same dedup_key (DUP)", () => {
    const a = computeDedupKey({
      internet_message_id: "<abc@host>",
      subject: "Daily report",
      from: "noreply@porsche.example",
      received_iso: "2026-05-01T10:00:00Z",
      bytes: Buffer.from("body-A"),
    });
    const b = computeDedupKey({
      internet_message_id: "abc@host", // bracketless variant
      subject: "Daily report",
      from: "noreply@porsche.example",
      received_iso: "2026-05-01T10:00:00Z",
      bytes: Buffer.from("body-A-different-but-same-imid"),
    });
    expect(a.dedup_key).toBe(b.dedup_key);
    expect(a.strategy).toBe("internet_message_id");
    expect(a.dedup_key.startsWith("imid:")).toBe(true);
    expect(a.internet_message_id).toBe("abc@host");
  });

  it("different internet_message_id, same subject ⇒ DIFFERENT dedup_keys (NOT DUP)", () => {
    const a = computeDedupKey({
      internet_message_id: "<msg-1@host>",
      subject: "Weekly digest",
      from: "reports@porsche.example",
      received_iso: "2026-05-01T10:00:00Z",
      bytes: Buffer.from("payload"),
    });
    const b = computeDedupKey({
      internet_message_id: "<msg-2@host>",
      subject: "Weekly digest",
      from: "reports@porsche.example",
      received_iso: "2026-05-01T10:00:00Z",
      bytes: Buffer.from("payload"),
    });
    expect(a.dedup_key).not.toBe(b.dedup_key);
    expect(a.strategy).toBe("internet_message_id");
    expect(b.strategy).toBe("internet_message_id");
  });
});

describe("computeDedupKey — fallback hash path (SECONDARY)", () => {
  it("missing internet_message_id, same body ⇒ same dedup_key (DUP)", () => {
    const a = computeDedupKey({
      internet_message_id: null,
      subject: "Daily roster",
      from: "ops@porsche.example",
      received_iso: "2026-05-01T10:00:00Z",
      bytes: Buffer.from("identical body bytes here"),
    });
    const b = computeDedupKey({
      internet_message_id: null,
      subject: "Daily roster",
      from: "ops@porsche.example",
      received_iso: "2026-05-01T10:00:00Z",
      bytes: Buffer.from("identical body bytes here"),
    });
    expect(a.dedup_key).toBe(b.dedup_key);
    expect(a.strategy).toBe("fallback_hash");
    expect(a.dedup_key.startsWith("fb:")).toBe(true);
    expect(a.internet_message_id).toBeNull();
  });

  it("missing internet_message_id, DIFFERENT body ⇒ different dedup_keys (NOT DUP)", () => {
    /* Same subject + sender + received_iso, different body slices —
       this is the case where the legacy (subject+sender) dedup would
       have collided two genuinely-different messages. The new fallback
       hashes the first 512 body bytes, so different rosters hash to
       different keys. */
    const a = computeDedupKey({
      internet_message_id: null,
      subject: "Daily roster",
      from: "ops@porsche.example",
      received_iso: "2026-05-01T10:00:00Z",
      bytes: Buffer.from("monday roster — alice, bob, carol"),
    });
    const b = computeDedupKey({
      internet_message_id: null,
      subject: "Daily roster",
      from: "ops@porsche.example",
      received_iso: "2026-05-01T10:00:00Z",
      bytes: Buffer.from("tuesday roster — dave, eve, frank"),
    });
    expect(a.dedup_key).not.toBe(b.dedup_key);
    expect(a.strategy).toBe("fallback_hash");
  });

  it("missing internet_message_id, same body within first 512 bytes but different tail ⇒ DUP", () => {
    /* The fallback hashes only the first 512 bytes of the body — past
       that we treat the messages as equivalent. This is by design: it
       avoids false-positive NOT-DUP for very-large attachments where
       trivial trailing differences (e.g. a regenerated PDF with a new
       UUID in the trailer) shouldn't split the dedup key. */
    const head = Buffer.from("x".repeat(512));
    const a = computeDedupKey({
      internet_message_id: null,
      subject: "X",
      from: "y",
      received_iso: "2026-05-01T10:00:00Z",
      bytes: Buffer.concat([head, Buffer.from("tail-A")]),
    });
    const b = computeDedupKey({
      internet_message_id: null,
      subject: "X",
      from: "y",
      received_iso: "2026-05-01T10:00:00Z",
      bytes: Buffer.concat([head, Buffer.from("tail-B-different")]),
    });
    expect(a.dedup_key).toBe(b.dedup_key);
  });
});

describe("computeDedupKey — robustness", () => {
  it("does not crash on null/undefined inputs", () => {
    const k = computeDedupKey({
      internet_message_id: null,
      subject: null,
      from: null,
      received_iso: null,
      bytes: null,
    });
    expect(k.dedup_key).toMatch(/^fb:[0-9a-f]{64}$/);
    expect(k.strategy).toBe("fallback_hash");
  });

  it("normalizes from-address case-insensitively in the fallback", () => {
    const a = computeDedupKey({
      internet_message_id: null,
      subject: "S",
      from: "Foo@Bar.com",
      received_iso: "2026-05-01T10:00:00Z",
      bytes: Buffer.from("body"),
    });
    const b = computeDedupKey({
      internet_message_id: null,
      subject: "S",
      from: "foo@bar.com",
      received_iso: "2026-05-01T10:00:00Z",
      bytes: Buffer.from("body"),
    });
    expect(a.dedup_key).toBe(b.dedup_key);
  });
});
