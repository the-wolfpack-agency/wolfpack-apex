/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Tests for src/lib/email-signatures-detect.ts.
 *
 * Plain-text suffix detection is exercised end-to-end via fetch-mock,
 * along with the new HTML helpers (stripHtmlQuotedBlock, resolveCidImages)
 * and detectSignatureHtmlFromOutlook which composes them with a
 * Microsoft Graph fetch.
 */

const mockGetValidToken = jest.fn();

jest.mock("@/lib/microsoft-graph", () => ({
  getValidToken: (...a: any[]) => mockGetValidToken(...a),
}));

import {
  htmlToPlainText,
  longestCommonSuffix,
  stripQuotedBlock,
  stripHtmlQuotedBlock,
  resolveCidImages,
  detectSignatureFromOutlook,
  detectSignatureHtmlFromOutlook,
} from "@/lib/email-signatures-detect";

const ORIGINAL_FETCH = global.fetch;

beforeEach(() => {
  mockGetValidToken.mockReset();
});

afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
});

describe("htmlToPlainText", () => {
  test("preserves line breaks via <br>", () => {
    expect(htmlToPlainText("Hello<br>World")).toBe("Hello\nWorld");
  });
  test("decodes basic entities", () => {
    expect(htmlToPlainText("Tom &amp; Jerry &lt;3")).toBe("Tom & Jerry <3");
  });
  test("strips tags", () => {
    expect(htmlToPlainText("<p>Hi <b>there</b></p>")).toBe("Hi there");
  });
});

describe("longestCommonSuffix", () => {
  test("finds the trailing block shared across messages", () => {
    const bodies = [
      "Hey Sara,\n\nThanks for the meeting!\n\nNick — CTO\nWolfpack",
      "Hi Bob,\n\nLooking forward to it.\n\nNick — CTO\nWolfpack",
      "Quick update.\n\nNick — CTO\nWolfpack",
    ];
    expect(longestCommonSuffix(bodies)).toBe("Nick — CTO\nWolfpack");
  });
  test("returns empty when no suffix matches", () => {
    expect(longestCommonSuffix(["foo", "bar"])).toBe("");
  });
  test("strips quoted-original block before comparing", () => {
    const bodies = [
      "Hi.\n\nNick — CTO\nWolfpack\n\nOn 2026-04-01 someone wrote:\n> orig",
      "Yo.\n\nNick — CTO\nWolfpack",
    ];
    expect(longestCommonSuffix(bodies)).toBe("Nick — CTO\nWolfpack");
  });
});

describe("stripQuotedBlock", () => {
  test("removes content after 'On ... wrote:'", () => {
    const body = "Reply.\n\nNick\n\nOn Tue 2026-04-01, Bob wrote:\n> hi";
    expect(stripQuotedBlock(body)).toBe("Reply.\n\nNick");
  });
  test("removes content after 'From:' header", () => {
    const body = "Reply.\n\nNick\n\nFrom: bob@x.com\nSubject: yo";
    expect(stripQuotedBlock(body)).toBe("Reply.\n\nNick");
  });
});

describe("stripHtmlQuotedBlock", () => {
  test("strips Outlook divRplyFwdMsg and everything after", () => {
    const html =
      '<p>Reply.</p><p>Nick</p><div id="divRplyFwdMsg"><p>From: x</p></div>';
    expect(stripHtmlQuotedBlock(html)).toBe("<p>Reply.</p><p>Nick</p>");
  });
  test("strips appendonsend block", () => {
    const html = '<p>Reply.</p><div id="appendonsend"></div><blockquote>orig</blockquote>';
    expect(stripHtmlQuotedBlock(html)).toBe("<p>Reply.</p>");
  });
  test("strips bare blockquote", () => {
    const html = "<p>Reply.</p><blockquote>old message</blockquote>";
    expect(stripHtmlQuotedBlock(html)).toBe("<p>Reply.</p>");
  });
  test("strips gmail_quote div", () => {
    const html = '<p>Reply.</p><div class="gmail_quote">orig</div>';
    expect(stripHtmlQuotedBlock(html)).toBe("<p>Reply.</p>");
  });
  test("returns input unchanged when no marker found", () => {
    const html = "<p>Just a fresh send with my signature.</p>";
    expect(stripHtmlQuotedBlock(html)).toBe(html);
  });
});

describe("resolveCidImages", () => {
  test("replaces cid: refs with data: URIs from inline attachments", () => {
    const html =
      '<p>Sig:</p><img src="cid:logo123"><img src="cid:icon456">';
    const out = resolveCidImages(html, [
      {
        isInline: true,
        contentId: "logo123",
        contentType: "image/png",
        contentBytes: "AAAA",
      },
      {
        isInline: true,
        contentId: "<icon456>",
        contentType: "image/jpeg",
        contentBytes: "BBBB",
      },
    ]);
    expect(out).toContain('src="data:image/png;base64,AAAA"');
    expect(out).toContain('src="data:image/jpeg;base64,BBBB"');
    expect(out).not.toContain("cid:logo123");
  });
  test("leaves cid: refs alone when no matching attachment exists", () => {
    const html = '<img src="cid:missing">';
    expect(resolveCidImages(html, [])).toBe(html);
  });
  test("ignores non-inline attachments", () => {
    const html = '<img src="cid:logo">';
    const out = resolveCidImages(html, [
      {
        isInline: false,
        contentId: "logo",
        contentType: "image/png",
        contentBytes: "AAAA",
      },
    ]);
    expect(out).toBe(html);
  });
  test("handles single-quoted cid refs", () => {
    const html = "<img src='cid:logo'>";
    const out = resolveCidImages(html, [
      {
        isInline: true,
        contentId: "logo",
        contentType: "image/png",
        contentBytes: "AAAA",
      },
    ]);
    expect(out).toContain("data:image/png;base64,AAAA");
  });
});

describe("detectSignatureFromOutlook (plain text)", () => {
  test("returns not_connected when token unavailable", async () => {
    mockGetValidToken.mockResolvedValueOnce(null);
    const out = await detectSignatureFromOutlook("u1");
    expect(out).toEqual({
      ok: false,
      code: "not_connected",
      message: "microsoft_not_connected",
    });
  });
  test("returns scope_missing on Graph 403", async () => {
    mockGetValidToken.mockResolvedValueOnce({ accessToken: "tk" });
    global.fetch = jest.fn(async () => ({
      ok: false,
      status: 403,
      json: async () => ({}),
    })) as any;
    const out = await detectSignatureFromOutlook("u1");
    expect(out).toMatchObject({ ok: false, code: "scope_missing" });
  });
  test("returns no_sent_mail on empty value array", async () => {
    mockGetValidToken.mockResolvedValueOnce({ accessToken: "tk" });
    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ value: [] }),
    })) as any;
    const out = await detectSignatureFromOutlook("u1");
    expect(out).toMatchObject({ ok: false, code: "no_sent_mail" });
  });
  test("returns the signature when a stable suffix is detected", async () => {
    mockGetValidToken.mockResolvedValueOnce({ accessToken: "tk" });
    const tail = "Nick - CTO\nWolfpack Agency";
    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        value: [
          { id: "1", body: { contentType: "text", content: `Hey.\n\n${tail}` } },
          { id: "2", body: { contentType: "text", content: `Yo.\n\n${tail}` } },
          { id: "3", body: { contentType: "text", content: `Update.\n\n${tail}` } },
        ],
      }),
    })) as any;
    const out = await detectSignatureFromOutlook("u1");
    if (!out.ok) throw new Error("expected ok");
    expect(out.signature.text).toBe(tail);
    expect(out.signature.matchedCount).toBe(3);
    expect(out.signature.sampledCount).toBe(3);
    expect(out.signature.confidence).toBe(1);
  });
});

describe("detectSignatureHtmlFromOutlook", () => {
  test("returns not_connected when token unavailable", async () => {
    mockGetValidToken.mockResolvedValueOnce(null);
    const out = await detectSignatureHtmlFromOutlook("u1");
    expect(out).toMatchObject({ ok: false, code: "not_connected" });
  });
  test("returns scope_missing on Graph 403", async () => {
    mockGetValidToken.mockResolvedValueOnce({ accessToken: "tk" });
    global.fetch = jest.fn(async () => ({
      ok: false,
      status: 403,
      json: async () => ({}),
    })) as any;
    const out = await detectSignatureHtmlFromOutlook("u1");
    expect(out).toMatchObject({ ok: false, code: "scope_missing" });
  });
  test("returns html with cid: resolved + plain-text confidence signal", async () => {
    mockGetValidToken.mockResolvedValueOnce({ accessToken: "tk" });
    const sigHtml =
      '<p>Best,</p><p>Alicia Zulker<br>Program Director</p>' +
      '<img src="cid:logo">';
    const fullHtml =
      '<p>Hi team!</p>' +
      sigHtml +
      '<div id="appendonsend"></div><blockquote>orig</blockquote>';
    const sigText = "\nBest,\nAlicia Zulker\nProgram Director\n";
    const fullText = "Hi team!\n" + sigText;
    /* Two-call pattern now: first the messages list (no $expand), then
       a separate per-message attachments fetch only when the latest
       has hasAttachments=true AND the stripped body references cid:.
       Mock both calls in sequence. */
    const fetchMock = jest.fn(async (url: string) => {
      if (url.includes("/attachments")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            value: [
              {
                isInline: true,
                contentId: "logo",
                contentType: "image/png",
                contentBytes: "AAAA",
              },
            ],
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          value: [
            {
              id: "msg-1",
              hasAttachments: true,
              body: { contentType: "html", content: fullHtml },
            },
            {
              id: "msg-2",
              hasAttachments: false,
              body: {
                contentType: "html",
                content: "<p>Yo.</p>" + sigHtml,
              },
            },
            {
              id: "msg-3",
              hasAttachments: false,
              body: {
                contentType: "text",
                content: "Hello." + sigText,
              },
            },
          ],
        }),
      };
    });
    global.fetch = fetchMock as any;
    const out = await detectSignatureHtmlFromOutlook("u1");
    if (!out.ok) throw new Error(`expected ok, got ${JSON.stringify(out)}`);
    expect(out.signature.html).toContain("Alicia Zulker");
    expect(out.signature.html).toContain("data:image/png;base64,AAAA");
    expect(out.signature.html).not.toContain("appendonsend");
    expect(out.signature.html).not.toContain("blockquote");
    expect(out.signature.sampledCount).toBe(3);
    /* Plain-text suffix is a best-effort confidence signal; with mixed
       HTML/text bodies it may not converge. The user-visible value is
       the HTML preview. */
    expect(typeof out.signature.text).toBe("string");
  });
  test("returns no_signature_detected when stripped HTML is empty", async () => {
    mockGetValidToken.mockResolvedValueOnce({ accessToken: "tk" });
    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        value: [
          {
            id: "1",
            body: {
              contentType: "html",
              content:
                '<div id="appendonsend"></div><blockquote>orig</blockquote>',
            },
            attachments: [],
          },
        ],
      }),
    })) as any;
    const out = await detectSignatureHtmlFromOutlook("u1");
    expect(out).toMatchObject({ ok: false, code: "no_signature_detected" });
  });
  test("messages list call does NOT use $expand=attachments — Graph rejects nested $select with 400 (regression for prod bug)", async () => {
    mockGetValidToken.mockResolvedValueOnce({ accessToken: "tk" });
    const fetchMock = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ value: [] }),
    }));
    global.fetch = fetchMock as any;
    await detectSignatureHtmlFromOutlook("u1");
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/sentitems/messages?"),
      expect.objectContaining({ headers: { Authorization: "Bearer tk" } }),
    );
    const firstCall = fetchMock.mock.calls[0] as unknown as [string, ...unknown[]];
    expect(String(firstCall[0])).not.toContain("$expand=");
    expect(String(firstCall[0])).not.toContain("expand=attachments");
  });
});
