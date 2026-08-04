/**
 * Reading the file the user attached to THIS message.
 *
 * Guards the 2026-08-04 report: attaching a screenshot and asking "look at the
 * screen shot" answered "I cannot view screenshots or attachments directly",
 * while `ocrImage()` had been reading screenshots for brain ingest the whole
 * time. The attachment reached the server and was dropped before the model.
 */
import {
  buildAttachmentContext,
  parseDataUrl,
  MAX_CHARS_PER_ATTACHMENT,
  MAX_CHARS_TOTAL,
} from "../attachment-context";

jest.mock("@/lib/analytics", () => ({ trackEvent: jest.fn() }));

const mockOcr = jest.fn();
const mockConfigured = jest.fn(() => true);
jest.mock("@/lib/azure/vision-ocr", () => ({
  ocrImage: (...args: unknown[]) => mockOcr(...args),
  isVisionConfigured: () => mockConfigured(),
  VISION_MAX_BYTES: 3.5 * 1024 * 1024,
}));

const OPTS = { userId: "u1", userRole: "admin" };

/** A 1x1 PNG as the chat client encodes it: a base64 data URL. */
const PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

beforeEach(() => {
  jest.clearAllMocks();
  mockConfigured.mockReturnValue(true);
});

describe("parseDataUrl", () => {
  test("decodes a base64 image data URL", () => {
    const out = parseDataUrl(PNG_DATA_URL);
    expect(out?.mime).toBe("image/png");
    expect(out?.bytes.length).toBeGreaterThan(0);
  });

  test("returns null for plain text, which is not a data URL", () => {
    expect(parseDataUrl("just some notes")).toBeNull();
  });
});

describe("buildAttachmentContext", () => {
  test("no attachments produces no block", async () => {
    const ctx = await buildAttachmentContext(undefined, OPTS);
    expect(ctx.block).toBe("");
    expect(ctx.hasContent).toBe(false);
    expect(mockOcr).not.toHaveBeenCalled();
  });

  test("an image is read with Azure OCR and its text reaches the block", async () => {
    mockOcr.mockResolvedValue({ ok: true, text: "Choose a new password" });

    const ctx = await buildAttachmentContext(
      [{ name: "shot.png", type: "image/png", content: PNG_DATA_URL }],
      OPTS,
    );

    expect(mockOcr).toHaveBeenCalledTimes(1);
    expect(ctx.hasContent).toBe(true);
    expect(ctx.block).toContain("Choose a new password");
    expect(ctx.block).toContain("shot.png");
  });

  test("the block tells the model NOT to claim it cannot see attachments", async () => {
    /* The failure mode was a confident, wrong refusal. The instruction is the
       part that stops it recurring. */
    mockOcr.mockResolvedValue({ ok: true, text: "some text" });
    const ctx = await buildAttachmentContext(
      [{ name: "a.png", type: "image/png", content: PNG_DATA_URL }],
      OPTS,
    );
    expect(ctx.block).toMatch(/do not say you cannot view attachments/i);
  });

  test("the data URL's own MIME wins over a wrong browser type", async () => {
    /* Drag-and-drop from some apps reports "" or octet-stream for a PNG. */
    mockOcr.mockResolvedValue({ ok: true, text: "read anyway" });
    const ctx = await buildAttachmentContext(
      [{ name: "shot.png", type: "application/octet-stream", content: PNG_DATA_URL }],
      OPTS,
    );
    expect(mockOcr).toHaveBeenCalledTimes(1);
    expect(ctx.hasContent).toBe(true);
  });

  test("plain text is used directly, without an OCR call", async () => {
    const ctx = await buildAttachmentContext(
      [{ name: "notes.txt", type: "text/plain", content: "quarterly targets" }],
      OPTS,
    );
    expect(mockOcr).not.toHaveBeenCalled();
    expect(ctx.block).toContain("quarterly targets");
    expect(ctx.hasContent).toBe(true);
  });

  test("an OCR failure names the file and the reason rather than going silent", async () => {
    mockOcr.mockResolvedValue({ ok: false, reason: "rate_limited", detail: "429 from Azure" });

    const ctx = await buildAttachmentContext(
      [{ name: "shot.png", type: "image/png", content: PNG_DATA_URL }],
      OPTS,
    );

    expect(ctx.hasContent).toBe(false);
    expect(ctx.block).toContain("shot.png");
    expect(ctx.block).toContain("429 from Azure");
    /* Crucially it still instructs the model to say WHICH file failed, instead
       of falling back to the blanket refusal this whole change exists to kill. */
    expect(ctx.block).toMatch(/do not claim you are unable to view attachments/i);
  });

  test("an image with no text in it is reported as such, not as a failure", async () => {
    mockOcr.mockResolvedValue({ ok: true, text: "   " });
    const ctx = await buildAttachmentContext(
      [{ name: "logo.png", type: "image/png", content: PNG_DATA_URL }],
      OPTS,
    );
    expect(ctx.hasContent).toBe(false);
    expect(ctx.block).toMatch(/no readable text/i);
  });

  test("vision not configured is stated plainly", async () => {
    mockConfigured.mockReturnValue(false);
    const ctx = await buildAttachmentContext(
      [{ name: "shot.png", type: "image/png", content: PNG_DATA_URL }],
      OPTS,
    );
    expect(mockOcr).not.toHaveBeenCalled();
    expect(ctx.block).toMatch(/not configured/i);
  });

  test("an oversized image is refused before the network call", async () => {
    const big = "data:image/png;base64," + "A".repeat(6 * 1024 * 1024);
    const ctx = await buildAttachmentContext(
      [{ name: "huge.png", type: "image/png", content: big }],
      OPTS,
    );
    expect(mockOcr).not.toHaveBeenCalled();
    expect(ctx.block).toMatch(/above the .* limit/i);
  });

  test("a PDF says it is searchable rather than pretending it vanished", async () => {
    const pdf = "data:application/pdf;base64,JVBERi0=";
    const ctx = await buildAttachmentContext(
      [{ name: "contract.pdf", type: "application/pdf", content: pdf }],
      OPTS,
    );
    expect(ctx.block).toContain("contract.pdf");
    expect(ctx.block).toMatch(/knowledge base and is searchable/i);
  });

  test("several images are read concurrently, not one round-trip at a time", async () => {
    let inFlight = 0;
    let peak = 0;
    mockOcr.mockImplementation(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return { ok: true, text: "x" };
    });

    await buildAttachmentContext(
      ["a", "b", "c"].map((n) => ({ name: `${n}.png`, type: "image/png", content: PNG_DATA_URL })),
      OPTS,
    );

    expect(peak).toBeGreaterThan(1);
  });

  test("one unreadable file does not discard the readable ones", async () => {
    mockOcr
      .mockResolvedValueOnce({ ok: true, text: "usable content" })
      .mockResolvedValueOnce({ ok: false, reason: "bad_image", detail: "corrupt" });

    const ctx = await buildAttachmentContext(
      [
        { name: "good.png", type: "image/png", content: PNG_DATA_URL },
        { name: "bad.png", type: "image/png", content: PNG_DATA_URL },
      ],
      OPTS,
    );

    expect(ctx.hasContent).toBe(true);
    expect(ctx.block).toContain("usable content");
    expect(ctx.block).toContain("bad.png");
  });

  test("a single huge extraction cannot crowd out the conversation", async () => {
    mockOcr.mockResolvedValue({ ok: true, text: "z".repeat(50_000) });
    const ctx = await buildAttachmentContext(
      [{ name: "dense.png", type: "image/png", content: PNG_DATA_URL }],
      OPTS,
    );
    expect(ctx.block.length).toBeLessThan(MAX_CHARS_PER_ATTACHMENT + 1000);
  });

  test("many attachments together stay within the total budget", async () => {
    mockOcr.mockResolvedValue({ ok: true, text: "y".repeat(MAX_CHARS_PER_ATTACHMENT) });
    const files = Array.from({ length: 8 }, (_, i) => ({
      name: `s${i}.png`,
      type: "image/png",
      content: PNG_DATA_URL,
    }));
    const ctx = await buildAttachmentContext(files, OPTS);
    expect(ctx.block.length).toBeLessThan(MAX_CHARS_TOTAL + 2000);
  });

  test("every attachment is reported to the brain, failures included", async () => {
    const { trackEvent } = jest.requireMock("@/lib/analytics");
    mockOcr.mockResolvedValue({ ok: false, reason: "bad_image", detail: "corrupt" });

    await buildAttachmentContext(
      [{ name: "bad.png", type: "image/png", content: PNG_DATA_URL }],
      OPTS,
    );

    expect(trackEvent).toHaveBeenCalledWith(
      "assistant.attachment_read",
      "u1",
      "admin",
      expect.objectContaining({ file_name: "bad.png", status: "ocr_failed" }),
    );
  });
});
