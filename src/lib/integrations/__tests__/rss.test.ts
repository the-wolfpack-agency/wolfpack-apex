/**
 * The feed reader shared by `headlines` and `news_search`.
 *
 * The entity ordering is the reason this is tested on its own: decoding
 * `&amp;` first turns the literal text `&amp;lt;` into `<`, which is a bug that
 * looks like correct code. It was already right in the private parser this was
 * lifted from, and lifting is exactly when that kind of thing gets dropped.
 */
import { parseFeed, extractTag, fetchFeed } from "@/lib/integrations/rss";

const RSS = `<rss><channel>
  <item>
    <title><![CDATA[SpaceX tugs Starship into port]]></title>
    <link>https://example.test/a</link>
    <pubDate>Tue, 19 Aug 2026 09:00:00 GMT</pubDate>
    <description><![CDATA[<p>After 24 days at sea.</p>]]></description>
  </item>
  <item>
    <title>Tom &amp; Jerry &amp;lt; still airs</title>
    <link>https://example.test/b</link>
    <pubDate>Mon, 18 Aug 2026 09:00:00 GMT</pubDate>
  </item>
</channel></rss>`;

const ATOM = `<feed>
  <entry>
    <title>NASA images a crater</title>
    <link rel="alternate" href="https://example.test/c"/>
    <published>2026-08-17T10:00:00Z</published>
    <summary>The crater formed on Aug 5.</summary>
  </entry>
</feed>`;

describe("parseFeed", () => {
  test("reads RSS items with title, link, date and summary", () => {
    const items = parseFeed(RSS, "Example");
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      title: "SpaceX tugs Starship into port",
      link: "https://example.test/a",
      source: "Example",
    });
    // Markup is stripped out of the summary, so a snippet reads as text.
    expect(items[0].summary).toBe("After 24 days at sea.");
  });

  test("reads Atom entries, whose link is an attribute", () => {
    const items = parseFeed(ATOM, "NASA");
    expect(items[0]).toMatchObject({ title: "NASA images a crater", link: "https://example.test/c" });
    expect(items[0].published).toBe("2026-08-17T10:00:00Z");
  });

  test("an item with no title or no link is skipped, not half-rendered", () => {
    expect(parseFeed("<rss><item><title>No link</title></item></rss>", "X")).toEqual([]);
  });

  test("the limit bounds the work a single feed can cost", () => {
    const many = `<rss>${"<item><title>t</title><link>https://e.test/x</link></item>".repeat(50)}</rss>`;
    expect(parseFeed(many, "X", 10)).toHaveLength(10);
  });
});

describe("extractTag", () => {
  test("&amp; is decoded LAST, so escaped entities survive", () => {
    /* The feed escaped an entity: the raw text is "&amp;lt;", which is how a
       publisher writes the literal characters "&lt;". Decoding &amp; first
       would produce "&lt;" and then decode THAT into "<", silently turning
       text into markup. Decoding it last is the only order that survives. */
    const items = parseFeed(RSS, "X");
    expect(items[1].title).toBe("Tom & Jerry &lt; still airs");
  });

  test("a missing tag is an empty string, never undefined", () => {
    expect(extractTag("<item><title>t</title></item>", "pubDate")).toBe("");
  });
});

describe("fetchFeed never throws, and null is not an empty list", () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  /* The distinction earns its keep twice: a multi-feed search must not report
     "nothing published" when it could not look, and a single-feed caller must
     not report success on a network failure. */
  test("a publisher that is down reads as null, not as an empty feed", async () => {
    global.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    await expect(fetchFeed("https://down.test/rss", "Down", 100)).resolves.toBeNull();
  });

  test("a non-200 reads as null", async () => {
    global.fetch = (async () => ({ ok: false, status: 503 })) as unknown as typeof fetch;
    await expect(fetchFeed("https://down.test/rss", "Down", 100)).resolves.toBeNull();
  });

  test("a feed that is READ and has nothing is an empty list, not null", async () => {
    global.fetch = (async () => ({ ok: true, text: async () => "<rss></rss>" })) as unknown as typeof fetch;
    await expect(fetchFeed("https://empty.test/rss", "Empty", 100)).resolves.toEqual([]);
  });
});
