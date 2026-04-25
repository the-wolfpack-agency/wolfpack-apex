/**
 * Plain-text extractor tests.
 */
import { extractText } from "../../extractors/text";

describe("extractText", () => {
  test("decodes utf-8 bytes to string with status='extracted'", async () => {
    const result = await extractText(
      Buffer.from("Hello, world.\nLine two."),
      "text/plain",
      "note.txt",
    );
    expect(result).toEqual({ text: "Hello, world.\nLine two.", status: "extracted" });
  });

  test("preserves non-ASCII characters", async () => {
    const result = await extractText(
      Buffer.from("Café — résumé"),
      "text/plain",
      "x.txt",
    );
    expect(result.status).toBe("extracted");
    expect(result.text).toBe("Café — résumé");
  });

  test("empty buffer returns empty string + extracted", async () => {
    const result = await extractText(Buffer.from(""), "text/plain", "empty.txt");
    expect(result).toEqual({ text: "", status: "extracted" });
  });
});
