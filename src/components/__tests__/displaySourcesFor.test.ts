/** @jest-environment node */
/**
 * displaySourcesFor — the fix for the raw-URL sources in production.
 *
 * The regression: on "what is in the SOW?" the cited document lived only in the
 * answer's text footer, with no structured `sources`, so the old code showed
 * the raw percent-encoded SharePoint URL and rendered no card. This helper is
 * what makes a card render (and the footer get stripped) regardless of path:
 * structured sources win, otherwise the footer is parsed.
 */

import { displaySourcesFor } from "@/components/InstinctChat";

// Minimal Message shape — the helper only reads role, sources, content.
const asMsg = (o: Record<string, unknown>) => o as never;

describe("displaySourcesFor", () => {
  it("prefers structured sources when present", () => {
    const out = displaySourcesFor(
      asMsg({
        role: "assistant",
        sources: [{ id: "s1", title: "Real.pdf", url: "https://x/r.pdf", type: "sharepoint" }],
        content: "answer\n\n**Sources:**\n1. [Footer.pdf](https://x/f.pdf)",
      }),
    );
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe("Real.pdf");
  });

  it("falls back to the footer when structured sources are absent (the SOW case)", () => {
    const out = displaySourcesFor(
      asMsg({
        role: "assistant",
        sources: undefined,
        content:
          "The SOW covers payment terms. [1]\n\n**Sources:**\n" +
          "1. [viaPeople Work Order.docx.pdf](https://netorg9503444.sharepoint.com/x.docx.pdf)",
      }),
    );
    expect(out).toHaveLength(1);
    expect(out[0].title).toContain("viaPeople Work Order");
    expect(out[0].url).toContain("sharepoint.com");
    expect(out[0].type).toBe("document");
  });

  it("returns [] for an assistant answer with neither structured sources nor a footer", () => {
    expect(displaySourcesFor(asMsg({ role: "assistant", content: "no sources here" }))).toEqual([]);
  });

  it("returns [] for a user message", () => {
    expect(
      displaySourcesFor(asMsg({ role: "user", content: "**Sources:**\n1. [x](https://x/x)" })),
    ).toEqual([]);
  });
});
