/**
 * Chunker unit tests — pure function, no DB / no network.
 */
import { chunkText, MIN_CHUNK_TOKENS, TARGET_TOKENS } from "../chunker";

describe("chunkText", () => {
  it("returns [] on empty input", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText("   ")).toEqual([]);
  });

  it("returns a single chunk for short text", () => {
    const chunks = chunkText("This is a short document.");
    expect(chunks).toHaveLength(1);
    expect(chunks[0].idx).toBe(0);
    expect(chunks[0].content).toContain("short document");
    expect(chunks[0].token_estimate).toBeGreaterThan(0);
  });

  it("preserves paragraph boundaries", () => {
    const text = "First paragraph.\n\nSecond paragraph.\n\nThird paragraph.";
    const chunks = chunkText(text, { targetTokens: 1000 });
    // Short text all fits in one chunk; paragraphs preserved by \n\n
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toContain("First paragraph");
    expect(chunks[0].content).toContain("Third paragraph");
  });

  it("splits when paragraphs exceed target size", () => {
    const para = "This is a long sentence that contains many words repeated. ".repeat(30);
    const text = `${para}\n\n${para}\n\n${para}`;
    const chunks = chunkText(text, { targetTokens: 100 });
    expect(chunks.length).toBeGreaterThan(1);
    // Every chunk must have a sensible token estimate
    for (const c of chunks) {
      expect(c.token_estimate).toBeGreaterThan(0);
    }
  });

  it("indexes chunks sequentially starting at 0", () => {
    const para = "Long paragraph. ".repeat(60);
    const text = `${para}\n\n${para}\n\n${para}\n\n${para}`;
    const chunks = chunkText(text, { targetTokens: 80 });
    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i].idx).toBe(i);
    }
  });

  it("hard-windows a single sentence larger than target", () => {
    const giant = "x".repeat(5000); // no sentence breaks at all
    const chunks = chunkText(giant, { targetTokens: 100 });
    expect(chunks.length).toBeGreaterThan(1);
    // No chunk content should exceed 3x target-char-limit (defense)
    for (const c of chunks) {
      expect(c.content.length).toBeLessThan(3 * 350 + 100);
    }
  });

  it("drops trivially small trailing chunks when others exist", () => {
    // Large first paragraph, then a tiny fragment — fragment should not
    // emit its own chunk because the test threshold is MIN_CHUNK_TOKENS/2.
    const big = "Sentence. ".repeat(200);
    const tiny = "ok.";
    const chunks = chunkText(`${big}\n\n${tiny}`, { targetTokens: 200 });
    // All chunks must be above half-min threshold OR be the first chunk
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].token_estimate * 2).toBeGreaterThan(MIN_CHUNK_TOKENS);
    }
  });

  it("respects custom target/overlap sizes", () => {
    const text = "Paragraph one.\n\nParagraph two.\n\nParagraph three.\n\nParagraph four.";
    const big = chunkText(text, { targetTokens: 1000 });
    const tight = chunkText(text, { targetTokens: 10 });
    // Tight target yields more chunks than loose target.
    expect(tight.length).toBeGreaterThanOrEqual(big.length);
  });

  it("token_estimate is monotonic with content length", () => {
    const short = chunkText("short text")[0];
    const long = chunkText("a lot more text " + "words ".repeat(50))[0];
    expect(long.token_estimate).toBeGreaterThan(short.token_estimate);
  });

  it("default target is TARGET_TOKENS constant", () => {
    // Just an existence check — if a future refactor moves the default
    // elsewhere, the constant should still be exported for callers.
    expect(TARGET_TOKENS).toBeGreaterThan(0);
    expect(MIN_CHUNK_TOKENS).toBeGreaterThan(0);
  });
});
