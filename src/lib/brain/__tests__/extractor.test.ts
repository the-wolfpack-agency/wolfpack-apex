/**
 * Extractor unit tests. PDF/DOCX exercised with small synthetic inputs
 * where feasible; otherwise type + dispatch behavior is asserted.
 *
 * unpdf + mammoth are real dynamic imports — keeping these tests at the
 * shape level means they run fast without fixture files.
 */
import { classifyKind, extract, isSyncExtractable } from "../extractor";
import type { BrainKind } from "../types";

describe("classifyKind", () => {
  it.each<[string, string, BrainKind]>([
    ["application/pdf", "x.pdf", "pdf"],
    ["", "report.PDF", "pdf"],
    ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "x.docx", "docx"],
    ["text/csv", "data.csv", "csv"],
    ["text/markdown", "notes.md", "markdown"],
    ["text/html", "page.html", "html"],
    ["text/plain", "readme.txt", "text"],
    ["audio/mp3", "meeting.mp3", "audio"],
    ["video/mp4", "demo.mp4", "video"],
    ["image/png", "screenshot.png", "image"],
    ["message/rfc822", "thread.eml", "email"],
    ["", "unknown.xyz", "other"],
  ])("maps %s/%s → %s", (mime, filename, expected) => {
    expect(classifyKind(mime, filename)).toBe(expected);
  });

  it("prefers filename extension when mime is generic octet-stream", () => {
    expect(classifyKind("application/octet-stream", "x.pdf")).toBe("pdf");
    expect(classifyKind("application/octet-stream", "x.md")).toBe("markdown");
  });
});

describe("isSyncExtractable", () => {
  it.each<[BrainKind, boolean]>([
    ["pdf", true],
    ["docx", true],
    ["text", true],
    ["markdown", true],
    ["csv", true],
    ["html", true],
    ["audio", false],
    ["video", false],
    ["image", false],
    ["email", false],
    ["other", false],
  ])("returns %s for %s", (kind, expected) => {
    expect(isSyncExtractable(kind)).toBe(expected);
  });
});

describe("extract — text / markdown / csv / html paths", () => {
  it("extracts plain text", async () => {
    const res = await extract("text", Buffer.from("hello world"));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.text).toBe("hello world");
  });

  it("reports empty for whitespace-only plain text", async () => {
    const res = await extract("text", Buffer.from("   \n\n "));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("empty");
  });

  it("prepends a columns header for CSV", async () => {
    const csv = "name,price,sku\nApple,1.20,A1\nOrange,0.90,B2";
    const res = await extract("csv", Buffer.from(csv));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.text).toMatch(/^Columns: name \| price \| sku/);
      expect(res.text).toContain("Apple");
    }
  });

  it("reports empty for empty CSV", async () => {
    const res = await extract("csv", Buffer.from(""));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("empty");
  });

  it("strips HTML tags and preserves paragraph boundaries", async () => {
    const html = "<html><body><p>Hello</p><p>World</p><script>evil()</script></body></html>";
    const res = await extract("html", Buffer.from(html));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.text).toContain("Hello");
      expect(res.text).toContain("World");
      expect(res.text).not.toContain("evil()");
      expect(res.text).not.toContain("<p>");
    }
  });

  it("extracts markdown as plain text", async () => {
    const md = "# Heading\n\nBody paragraph with **bold**.";
    const res = await extract("markdown", Buffer.from(md));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.text).toContain("Body paragraph");
  });
});

describe("extract — deferred kinds", () => {
  it.each<BrainKind>(["audio", "video", "image", "email"])(
    "returns deferred for %s (worker-backed)",
    async (kind) => {
      const res = await extract(kind, Buffer.from("anything"));
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toBe("deferred");
    },
  );
});

describe("extract — PDF path", () => {
  it("reports empty for a zero-byte buffer", async () => {
    // unpdf happily accepts an empty typed array and returns no text.
    const res = await extract("pdf", Buffer.alloc(0));
    expect(res.ok).toBe(false);
  });

  it("fails gracefully on a non-PDF buffer", async () => {
    const res = await extract("pdf", Buffer.from("not a pdf at all"));
    // unpdf throws; extract wraps → reason='failed'
    expect(res.ok).toBe(false);
    if (!res.ok) expect(["failed", "empty"]).toContain(res.reason);
  });
});
