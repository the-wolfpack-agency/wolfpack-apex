/**
 * Where data enters a system, and where it leaves.
 *
 * A finding list says what is broken. A data-flow map says what the system IS:
 * every form is a place information arrives, every third-party origin a place
 * it departs. An engineer handed the keys draws this before proposing
 * anything, because a recommendation made without knowing where the data goes
 * is a guess.
 *
 * It is also the part a client usually cannot produce themselves. Nobody has a
 * current list of every form on their estate or every vendor their pages
 * contact, and the second is exactly what a privacy review asks for.
 */
import { extractDataFlows, mapDataFlows } from "@/lib/platform-scan/mapping/data-flow";

const PAGE = "https://client.example.com/account";

describe("entry points", () => {
  it("finds a form and where it submits", () => {
    const { entryPoints } = extractDataFlows(
      `<form method="post" action="/account/update"><input name="email"></form>`,
      PAGE,
    );
    expect(entryPoints).toHaveLength(1);
    expect(entryPoints[0]).toMatchObject({ method: "POST", action: "/account/update" });
  });

  it("defaults to GET when the form does not say", () => {
    const { entryPoints } = extractDataFlows(`<form action="/search"></form>`, PAGE);
    expect(entryPoints[0].method).toBe("GET");
  });

  /* The names, never the values. A scan recording what somebody typed is a
     breach rather than a report. */
  it.each([
    [`<input type="password" name="pw">`, "pw"],
    [`<input type="file" name="upload">`, "upload"],
    [`<input type="text" name="card_number">`, "card_number"],
    [`<input type="text" name="ssn">`, "ssn"],
    [`<input type="text" name="cardNumber">`, "cardNumber"],
    [`<input type="text" name="card-number">`, "card-number"],
  ])("flags a sensitive field %s", (field, expected) => {
    const { entryPoints } = extractDataFlows(`<form>${field}</form>`, PAGE);
    expect(entryPoints[0].sensitiveFields).toContain(expected);
  });

  /* Dropping the word boundary to catch card_number would flag these, and a
     report that calls a discard button a payment field is one nobody trusts
     twice. */
  it.each(["discard", "postcard", "socialize", "passenger"])(
    "does not flag %s",
    (name) => {
      const { entryPoints } = extractDataFlows(
        `<form><input type="text" name="${name}"></form>`,
        PAGE,
      );
      expect(entryPoints[0].sensitiveFields).toEqual([]);
    },
  );

  it("leaves ordinary fields alone, so the flag keeps meaning something", () => {
    const { entryPoints } = extractDataFlows(
      `<form><input name="query"><input name="page"></form>`,
      PAGE,
    );
    expect(entryPoints[0].sensitiveFields).toEqual([]);
  });

  /* THE ONE THAT MATTERS MOST. A form posting off-site is the page handing
     typed input to somebody else, and it is invisible to anyone reading the
     site rather than its markup. */
  it("marks a form that submits to another origin", () => {
    const { entryPoints, exitOrigins } = extractDataFlows(
      `<form method="post" action="https://forms.vendor.io/collect"><input type="password" name="pw"></form>`,
      PAGE,
    );
    expect(entryPoints[0].crossOrigin).toBe(true);
    expect(exitOrigins).toContainEqual({ origin: "https://forms.vendor.io", via: "form" });
  });

  it("does not mark a form posting to its own site", () => {
    const { entryPoints } = extractDataFlows(
      `<form action="https://client.example.com/update"></form>`,
      PAGE,
    );
    expect(entryPoints[0].crossOrigin).toBe(false);
  });

  it("treats an empty action as posting to itself", () => {
    const { entryPoints } = extractDataFlows(`<form method="post"></form>`, PAGE);
    expect(entryPoints[0].crossOrigin).toBe(false);
  });

  it("finds every form on a page, not just the first", () => {
    const { entryPoints } = extractDataFlows(
      `<form action="/a"></form><div><form action="/b"></form></div>`,
      PAGE,
    );
    expect(entryPoints.map((e) => e.action)).toEqual(["/a", "/b"]);
  });
});

describe("exit points", () => {
  it.each([
    [`<script src="https://cdn.vendor.io/a.js"></script>`, "script"],
    [`<img src="https://pixel.tracker.net/p.gif">`, "img"],
    [`<iframe src="https://widget.chat.io/w"></iframe>`, "iframe"],
    [`<link href="https://fonts.vendor.io/f.css">`, "link"],
  ])("finds a third party reached by %s", (markup, via) => {
    const { exitOrigins } = extractDataFlows(markup, PAGE);
    expect(exitOrigins[0].via).toBe(via);
  });

  it("ignores the site's own resources", () => {
    const { exitOrigins } = extractDataFlows(
      `<script src="/app.js"></script><img src="https://client.example.com/logo.png">`,
      PAGE,
    );
    expect(exitOrigins).toEqual([]);
  });

  it("ignores data and javascript URLs rather than reporting them as vendors", () => {
    const { exitOrigins } = extractDataFlows(
      `<img src="data:image/gif;base64,R0lGOD"><a href="javascript:void(0)"></a>`,
      PAGE,
    );
    expect(exitOrigins).toEqual([]);
  });
});

describe("mapping a sample of pages", () => {
  const html = (body: string) =>
    new Response(body, { status: 200, headers: { "content-type": "text/html" } });

  it("merges one origin seen on several pages", async () => {
    const fetchImpl = jest.fn(async () =>
      html(`<script src="https://cdn.vendor.io/a.js"></script>`),
    );
    const map = await mapDataFlows("https://client.example.com", ["/a", "/b"], { fetchImpl } as never);

    expect(map.exitPoints).toHaveLength(1);
    expect(map.exitPoints[0].pages).toHaveLength(2);
    expect(map.pagesRead).toBe(2);
  });

  /* The vendor on every page matters more than the one on a single archived
     article. */
  it("puts the most widely contacted vendor first", async () => {
    const fetchImpl = jest.fn(async (url: string) =>
      String(url).endsWith("/a")
        ? html(`<script src="https://rare.io/x.js"></script><img src="https://everywhere.io/p.gif">`)
        : html(`<img src="https://everywhere.io/p.gif">`),
    );
    const map = await mapDataFlows(
      "https://client.example.com",
      ["/a", "/b", "/c"],
      { fetchImpl } as never,
    );
    expect(map.exitPoints[0].origin).toBe("https://everywhere.io");
  });

  /* Fetching a PDF and regexing it for <form> wastes a request and finds
     nothing. */
  it("reads only markup", async () => {
    const fetchImpl = jest.fn(async () =>
      new Response("%PDF-1.4", { status: 200, headers: { "content-type": "application/pdf" } }),
    );
    const map = await mapDataFlows("https://client.example.com", ["/doc.pdf"], { fetchImpl } as never);
    expect(map.pagesRead).toBe(0);
  });

  it("bounds the sample rather than mirroring the site", async () => {
    const fetchImpl = jest.fn(async () => html("<html></html>"));
    const paths = Array.from({ length: 50 }, (_, i) => `/p${i}`);
    await mapDataFlows("https://client.example.com", paths, { fetchImpl } as never);
    expect(fetchImpl).toHaveBeenCalledTimes(12);
  });

  /* One unreadable page must not cost the map. */
  it("keeps going when a page fails", async () => {
    const fetchImpl = jest.fn(async (url: string) => {
      if (String(url).endsWith("/bad")) throw new Error("ECONNRESET");
      return html(`<img src="https://vendor.io/p.gif">`);
    });
    const map = await mapDataFlows(
      "https://client.example.com",
      ["/bad", "/good"],
      { fetchImpl } as never,
    );
    expect(map.pagesRead).toBe(1);
    expect(map.exitPoints).toHaveLength(1);
  });
});
