/**
 * search tool — dispatcher routing + handler contract.
 *
 * Locks in:
 *   - matchIntent accepts every supported phrasing (search / look up /
 *     find / show me), with optional surface narrowing.
 *   - matchIntent defers to the CRM tools' matchIntent so phrasings
 *     they claim ("find the contact for Acme") stay with them
 *     regardless of future registration-order shuffles.
 *   - matchIntent rejects ID-shaped queries so get_external_record
 *     keeps claiming them.
 *   - Capability is "*" — any authenticated user.
 *   - Handler error path returns `{ ok: false, code: "internal" }`.
 *   - Handler emits assistant.search_executed on every dispatch,
 *     assistant.search_no_results on zero results.
 *   - Sources array is populated from the top results.
 */

const mockRunSearch = jest.fn();
const mockTrackEvent = jest.fn();

jest.mock("@/lib/search/runSearch", () => {
  /* Keep the actual exported constants + types — only `runSearch`
     itself is the mock seam. */
  const actual = jest.requireActual("@/lib/search/runSearch");
  return {
    ...actual,
    runSearch: (...a: unknown[]) => mockRunSearch(...a),
  };
});
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: unknown[]) => mockTrackEvent(...a),
}));

import { searchTool, matchDocumentQuestion, relaxQuery } from "@/lib/assistant/tools/search";

const ctx = { userId: "u1", userRole: "cto" };

beforeEach(() => {
  jest.clearAllMocks();
  mockRunSearch.mockResolvedValue({
    results: [],
    took_ms: 1,
    counts: { chats: 0, channels: 0, emails: 0, calendar: 0, knowledge: 0, crm: 0 },
  });
});

/* ---------------------------------------------------------------------
 * matchIntent — happy phrasings
 *
 * v2 (2026-05-19): Universal Search now WINS bare-search phrasings —
 * "search Acme", "look up Acme", "find Acme", "search for Acme" all
 * land here so the CRM provider fans the same query back into the
 * CRM alongside chats/emails/calendar/knowledge. The TYPED_CRM_RE
 * guard inside search.matchIntent still defers structured queries
 * ("find the contact for Acme", "show me Acme's opportunities",
 * "deals over $50k") to the specialized CRM tools — those have
 * richer disambiguation surfaces than the universal result list.
 * ------------------------------------------------------------------- */

describe("matchIntent — accepted phrasings", () => {
  test("'search porsche' → query='porsche'", () => {
    const p = searchTool.matchIntent("search porsche");
    expect(p).not.toBeNull();
    expect(p?.query).toBe("porsche");
    expect(p?.types).toBeUndefined();
  });

  test("'show me porsche' → query='porsche'", () => {
    const p = searchTool.matchIntent("show me porsche");
    expect(p).not.toBeNull();
    expect(p?.query).toBe("porsche");
  });

  test("'search 911 turbo' → multi-word query stays intact", () => {
    const p = searchTool.matchIntent("search 911 turbo");
    expect(p).not.toBeNull();
    expect(p?.query).toBe("911 turbo");
  });

  test("'search porsche in my emails' → types=['email']", () => {
    /* Surface narrowing — 'in my emails' suffix routes to the email
       provider only. */
    const p = searchTool.matchIntent("search porsche in my emails");
    expect(p).not.toBeNull();
    expect(p?.query).toBe("porsche");
    expect(p?.types).toEqual(["email"]);
  });

  test("'show me porsche in calendar' → types=['calendar']", () => {
    const p = searchTool.matchIntent("show me porsche in calendar");
    expect(p).not.toBeNull();
    expect(p?.query).toBe("porsche");
    expect(p?.types).toEqual(["calendar"]);
  });

  test("'search porsche in everywhere' → no types narrowing", () => {
    const p = searchTool.matchIntent("search porsche in everywhere");
    expect(p).not.toBeNull();
    expect(p?.query).toBe("porsche");
    expect(p?.types).toBeUndefined();
  });

  test("'search porsche?' trailing punctuation tolerated", () => {
    const p = searchTool.matchIntent("search porsche?");
    expect(p).not.toBeNull();
    expect(p?.query).toBe("porsche");
  });
});

/* ---------------------------------------------------------------------
 * matchIntent — bare/generic phrasings v2 (now claimed by search tool)
 *
 * Previously the CRM tools claimed these and Universal Search saw
 * null. v2 (2026-05-19) flips that: Universal Search wins because its
 * `crm` provider fans the same query back into the CRM alongside
 * chats/emails/calendar/knowledge.
 * ------------------------------------------------------------------- */

describe("matchIntent — bare-search phrasings (v2 universal wins)", () => {
  test.each([
    ["look up porsche", "porsche"],
    ["find porsche", "porsche"],
    ["search for porsche", "porsche"],
    ["look up porsche in my emails", "porsche"],
  ])("'%s' → MATCH with query=%s (universal fan-out)", (msg, q) => {
    const p = searchTool.matchIntent(msg);
    expect(p).not.toBeNull();
    expect(p?.query).toBe(q);
  });

  test("'search Acme' (the canonical v2 case) → MATCH; the engine's CRM provider then fans into the configured connector", () => {
    const p = searchTool.matchIntent("search Acme");
    expect(p).not.toBeNull();
    expect(p?.query).toBe("Acme");
    expect(p?.types).toBeUndefined();
  });

  test("'search Acme in crm' → types=['crm']", () => {
    /* Explicit single-surface narrowing. The route handler accepts
       both 'crm' and the vendor names 'salesforce' / 'hubspot' as
       aliases that map to the crm type. */
    const p = searchTool.matchIntent("search Acme in crm");
    expect(p).not.toBeNull();
    expect(p?.types).toEqual(["crm"]);
  });

  test("'search Acme in salesforce' → types=['crm'] (vendor alias)", () => {
    const p = searchTool.matchIntent("search Acme in salesforce");
    expect(p).not.toBeNull();
    expect(p?.types).toEqual(["crm"]);
  });
});

/* ---------------------------------------------------------------------
 * matchIntent — shadow guards (CRM tools must keep these intents)
 * ------------------------------------------------------------------- */

describe("matchIntent — CRM shadow guards", () => {
  test("'find the contact for Acme' → null (search_external_records owns it)", () => {
    expect(searchTool.matchIntent("find the contact for Acme")).toBeNull();
  });

  test("'deals over $50k closing this month' → null (filter tool owns it)", () => {
    expect(
      searchTool.matchIntent("deals over $50k closing this month"),
    ).toBeNull();
  });

  test("'show me Acme's opportunities' → null (related-records tool owns it)", () => {
    expect(searchTool.matchIntent("show me Acme's opportunities")).toBeNull();
  });

  test("'003g500000GemUXAAZ' bare-ID input → null", () => {
    /* Bare ID isn't a search verb anyway, but assert null so a future
       regex loosening can't accidentally fire a Graph search on a CRM
       record id. */
    expect(searchTool.matchIntent("003g500000GemUXAAZ")).toBeNull();
  });

  test("'find ACME' single-word ALL-CAPS short string → null (looks like ID)", () => {
    /* The defensive ALL-CAPS short-string guard inside search.matchIntent
       — prevents 'find ACME' from firing a Graph search when
       get_external_record's looser ID regex might also claim it. */
    expect(searchTool.matchIntent("find ACME")).toBeNull();
  });
});

/* ---------------------------------------------------------------------
 * Capability — anyone authenticated
 * ------------------------------------------------------------------- */

describe("capability gate", () => {
  test("tool's capability is '*' — wildcard, same pattern as the read-only connector tools", () => {
    expect(searchTool.capability).toBe("*");
  });

  test("tool name is the stable identifier the dispatcher logs", () => {
    expect(searchTool.name).toBe("search");
  });
});

/* ---------------------------------------------------------------------
 * Handler — happy path, zero results, error path
 * ------------------------------------------------------------------- */

describe("handler — analytics + result framing", () => {
  test("happy path: emits assistant.search_executed with payload shape", async () => {
    mockRunSearch.mockResolvedValueOnce({
      results: [
        {
          type: "chat",
          id: "chat-1",
          title: "Porsche chat",
          snippet: "...",
          timestamp: "2026-04-22T10:00:00Z",
          url: "/messages?chat=chat-1",
        },
        {
          type: "email",
          id: "mail-1",
          title: "RE: Porsche",
          snippet: "...",
          timestamp: "2026-04-22T08:00:00Z",
          url: "https://outlook.test/mail-1",
        },
      ],
      took_ms: 7,
      counts: { chats: 1, channels: 0, emails: 1, calendar: 0, knowledge: 0, crm: 0 },
    });

    const r = await searchTool.handler({ query: "porsche" }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.answer).toContain("Found 2 results");

    const exec = mockTrackEvent.mock.calls.find(
      ([name]) => name === "assistant.search_executed",
    );
    expect(exec).toBeDefined();
    if (!exec) return;
    const [, actor, role, payload] = exec;
    expect(actor).toBe("u1");
    expect(role).toBe("cto");
    expect(payload).toEqual(
      expect.objectContaining({
        query_length: "porsche".length,
        total_results: 2,
        took_ms: 7,
        types: "chat,channel,email,calendar,knowledge,crm",
      }),
    );

    /* No zero-results event when results > 0. */
    const zero = mockTrackEvent.mock.calls.find(
      ([name]) => name === "assistant.search_no_results",
    );
    expect(zero).toBeUndefined();
  });

  test("sources array populated for top results (up to 5)", async () => {
    mockRunSearch.mockResolvedValueOnce({
      results: [
        { type: "chat", id: "c1", title: "Chat 1", snippet: "s", timestamp: "", url: "/messages?chat=c1" },
        { type: "email", id: "e1", title: "Email 1", snippet: "s", timestamp: "", url: "https://outlook.test/e1" },
        { type: "calendar", id: "evt1", title: "Event 1", snippet: "s", timestamp: "", url: "/calendar?event=evt1" },
      ],
      took_ms: 3,
      counts: { chats: 1, channels: 0, emails: 1, calendar: 1, knowledge: 0, crm: 0 },
    });

    const r = await searchTool.handler({ query: "anything" }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.sources).toBeDefined();
    expect(r.sources?.length).toBe(3);
    /* The calendar result type maps to the citation type "meeting"
       (matches the chat surface's badge convention). */
    const evtRef = r.sources?.find((s) => s.id === "evt1");
    expect(evtRef?.type).toBe("meeting");
  });

  test("zero results path: emits assistant.search_no_results AND assistant.search_executed", async () => {
    /* Default mock — empty results. */
    const r = await searchTool.handler({ query: "xyznotfound" }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.answer.toLowerCase()).toContain("no results");

    const exec = mockTrackEvent.mock.calls.find(
      ([name]) => name === "assistant.search_executed",
    );
    const zero = mockTrackEvent.mock.calls.find(
      ([name]) => name === "assistant.search_no_results",
    );
    expect(exec).toBeDefined();
    expect(zero).toBeDefined();
    if (!zero) return;
    const [, , , payload] = zero;
    expect(payload).toEqual(
      expect.objectContaining({
        query_length: "xyznotfound".length,
        types: "chat,channel,email,calendar,knowledge,crm",
      }),
    );
  });

  test("handler exception path returns ok:false with code='internal'", async () => {
    mockRunSearch.mockRejectedValueOnce(new Error("graph collapsed"));
    const r = await searchTool.handler({ query: "porsche" }, ctx);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("internal");
    expect(r.message).toContain("graph collapsed");
  });

  test("CRM provider results are surfaced via the source map", async () => {
    /* The crm SearchType maps to citation type "crm" so the chat
       surface can badge CRM hits distinctly from chats/emails/etc. */
    mockRunSearch.mockResolvedValueOnce({
      results: [
        {
          type: "crm",
          id: "salesforce:contact:003abc",
          title: "Acme Industries (contact)",
          snippet: "ceo@acme.com",
          timestamp: "",
          url: "https://acme.my.salesforce.com/003abc",
        },
      ],
      took_ms: 5,
      counts: { chats: 0, channels: 0, emails: 0, calendar: 0, knowledge: 0, crm: 1 },
    });
    const r = await searchTool.handler({ query: "Acme" }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.answer).toContain("1 CRM record");
    const crmRef = r.sources?.find((s) => s.id === "salesforce:contact:003abc");
    expect(crmRef?.type).toBe("crm");
  });

  test("handler attaches a search_results widget on every success", async () => {
    /* Mirrors the SearchResponse shape — the widget spec is built
     *  by copying results, counts, and took_ms straight through plus
     *  echoing the user's query string for the empty-state and
     *  refresh prompt. The chat surface then dispatches it to
     *  SearchResultsWidget via ChatWidget's kind switch. */
    mockRunSearch.mockResolvedValueOnce({
      results: [
        {
          type: "chat",
          id: "c1",
          title: "Chat 1",
          snippet: "s",
          timestamp: "2026-04-22T10:00:00Z",
          url: "/messages?chat=c1",
        },
        {
          type: "email",
          id: "e1",
          title: "Email 1",
          snippet: "s",
          timestamp: "2026-04-22T08:00:00Z",
          url: "https://outlook.test/e1",
        },
      ],
      took_ms: 9,
      counts: { chats: 1, channels: 0, emails: 1, calendar: 0, knowledge: 0, crm: 0 },
    });

    const r = await searchTool.handler({ query: "porsche" }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.widget).toBeDefined();
    expect(r.widget?.kind).toBe("search_results");
    if (!r.widget || r.widget.kind !== "search_results") return;
    expect(r.widget.query).toBe("porsche");
    expect(r.widget.took_ms).toBe(9);
    expect(r.widget.counts).toEqual({
      chats: 1,
      channels: 0,
      emails: 1,
      calendar: 0,
      knowledge: 0,
      crm: 0,
    });
    expect(r.widget.results).toHaveLength(2);
    expect(r.widget.results[0]).toEqual({
      type: "chat",
      id: "c1",
      title: "Chat 1",
      snippet: "s",
      timestamp: "2026-04-22T10:00:00Z",
      url: "/messages?chat=c1",
    });
  });

  test("zero-results path still attaches the widget (renders the empty state inline)", async () => {
    /* Default mock has zero results. The widget rides along even
     *  when results.length === 0; the renderer detects the empty
     *  list and renders the "no results" inline state rather than
     *  the checkbox row. */
    const r = await searchTool.handler({ query: "xyznotfound" }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.widget).toBeDefined();
    expect(r.widget?.kind).toBe("search_results");
    if (!r.widget || r.widget.kind !== "search_results") return;
    expect(r.widget.results).toEqual([]);
    expect(r.widget.query).toBe("xyznotfound");
  });

  test("workflowId is threaded into analytics payload when present", async () => {
    const r = await searchTool.handler(
      { query: "porsche" },
      { ...ctx, workflowId: "wf-123" },
    );
    expect(r.ok).toBe(true);
    const exec = mockTrackEvent.mock.calls.find(
      ([name]) => name === "assistant.search_executed",
    );
    expect(exec?.[3]).toEqual(
      expect.objectContaining({ workflow_id: "wf-123" }),
    );
  });
});

/**
 * Naming the filing cabinet is not naming the document.
 *
 * "what is in the SharePoint about training" captured "SharePoint about
 * training" as the search subject. No document contains the word SharePoint,
 * so a question about a library we had fully ingested answered "No results
 * found". Measured against the real pipeline on 2026-08-27: four similar
 * phrasings returned documents and this one returned nothing, purely because
 * the sentence named the container it lives in.
 *
 * A client says "what's in SharePoint about X", "what's in our files about X",
 * "what's in the drive about X". The search term is what follows "about".
 */
describe("questions that name where the documents live", () => {
  it.each([
    ["what is in the SharePoint about training", "training"],
    ["whats in SharePoint about brand ambassadors", "brand ambassadors"],
    ["what's in our files about onboarding", "onboarding"],
    ["what is in the drive about pricing", "pricing"],
    ["what is in the document library about expenses", "expenses"],
    ["what is in our knowledge base about refunds", "refunds"],
  ])("%s searches for %s", (question, expected) => {
    expect(matchDocumentQuestion(question)).toBe(expected);
  });

  /* Nothing was asked ABOUT anything. There is no query that answers this, and
     inventing one guarantees an empty result that reads as an empty library. */
  it("declines when a container is named with no topic", () => {
    expect(matchDocumentQuestion("what is in SharePoint")).toBeNull();
    expect(matchDocumentQuestion("what is in the drive")).toBeNull();
  });

  /* The container rule must not swallow real document names. */
  it.each([
    ["what is in the contract", "contract"],
    ["what does the SOW say about payment", "SOW payment"],
    /* Was "summarize the onboarding deck". Summarise is deliberately no longer
       claimed as a search: it returned a browsable list to somebody who asked
       for a summary, and now falls through to retrieval, which synthesises.
       The claim THIS test makes is about the container rule not swallowing a
       real document name, so the example is swapped rather than dropped. */
    ["what is in the onboarding deck", "onboarding deck"],
    ["what does our security policy say", "security policy"],
  ])("leaves %s alone", (question, expected) => {
    expect(matchDocumentQuestion(question)).toBe(expected);
  });
});

/**
 * The commonest dead end in the product.
 *
 * Measured on production over 60 days: 130 assistant answers were dead ends,
 * and 36 of them were one query, "coaching calls spreasheet". One person, one
 * typo, thirty-six attempts, nothing back every time. They were never told the
 * file might be there under a slightly different name. They were told nothing
 * was found, and eventually they stopped asking.
 *
 * A search that only matches what was typed puts the burden of spelling on the
 * person asking.
 */
describe("relaxing a query that found nothing", () => {
  /* A misspelling is usually the longest and most specific token, so it is the
     first to go and the words most likely to be right are kept. */
  it("drops the longest meaningful word", () => {
    expect(relaxQuery("coaching calls spreasheet")).toBe("coaching calls");
  });

  it("ignores filler when choosing what to drop", () => {
    expect(relaxQuery("the report about onboarding")).toBe("report");
  });

  /* Dropping the only meaningful word leaves nothing to search for, and a
     search for the filler would match everything. */
  it.each(["invoices", "the invoices", "show me the report"])(
    "refuses to relax %s, because dropping its one real word leaves nothing",
    (q) => {
      expect(relaxQuery(q)).toBeNull();
    },
  );

  it("survives punctuation without producing empty tokens", () => {
    expect(relaxQuery("q3 revenue, forecasted?")).toBe("q3 revenue");
  });
});
