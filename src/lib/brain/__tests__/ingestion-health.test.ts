/**
 * The checks that would have caught this month, run on a schedule instead.
 *
 * Every finding here is something that actually went wrong and was found by
 * hand, late:
 *
 *   Ten PDFs sat mid-ingest from 2026-05-16 to 2026-08-27 because nothing was
 *   looking.
 *
 *   Ninety Word documents stayed broken for three months after the parser bug
 *   that broke them was fixed.
 *
 *   744 of 795 answerable documents turned out to be demo fixtures and scanner
 *   output, so the assistant was answering from them.
 *
 * Not one was caught by a test, because none of them is a bug in a function.
 * They are facts about accumulated state, which is exactly the work a scheduled
 * agent should do and a person should not.
 */

const mockQuery = jest.fn();
jest.mock("@/lib/db", () => ({ query: (...a: unknown[]) => mockQuery(...a) }));

import { readIngestionHealth, summarizeHealth } from "@/lib/brain/ingestion-health";

/** The document-level aggregate, then the chunk aggregate. */
function rows(over: Record<string, unknown> = {}, unembedded = "0") {
  mockQuery
    .mockResolvedValueOnce({
      rows: [
        {
          stranded: "0",
          stranded_oldest_days: null,
          failed: "0",
          skipped: "0",
          indexed_no_chunks: "0",
          non_corpus: "0",
          client_corpus: "100",
          ...over,
        },
      ],
    })
    .mockResolvedValueOnce({ rows: [{ unembedded }] });
}

beforeEach(() => jest.clearAllMocks());

describe("the findings", () => {
  it("flags documents stuck mid-ingest, harder when they are old", async () => {
    rows({ stranded: "10", stranded_oldest_days: "103" });
    const f = (await readIngestionHealth()).findings.find((x) => x.id === "stranded")!;
    expect(f.severity).toBe("high");
    expect(f.detail).toContain("103 day");
    expect(f.action).toBeTruthy();
  });

  it("flags a document that is indexed with no chunks as HIGH", async () => {
    /* The worst kind, and the reason this check exists. It reads as done, is
       counted as answerable, and can never be quoted. A silent hole. */
    rows({ indexed_no_chunks: "3" });
    const f = (await readIngestionHealth()).findings.find((x) => x.id === "indexed_no_chunks")!;
    expect(f.severity).toBe("high");
    expect(f.title).toMatch(/nothing in them/);
  });

  it("flags a corpus that is mostly not the client's own material", async () => {
    /* 84% on the day this was written. The assistant had been answering from
       demo fixtures for the life of the product. */
    rows({ non_corpus: "744", client_corpus: "51" });
    const f = (await readIngestionHealth()).findings.find((x) => x.id === "non_corpus_share")!;
    expect(f.severity).toBe("high");
    expect(f.title).toContain("94%");
    expect(f.action).toMatch(/Sync the real libraries/);
  });

  it("does not nag when the demo share is small", async () => {
    /* A finding that fires at any non-zero value trains people to ignore it. */
    rows({ non_corpus: "5", client_corpus: "500" });
    const f = (await readIngestionHealth()).findings.find((x) => x.id === "non_corpus_share")!;
    expect(f.severity).toBe("low");
    expect(f.action).toBeUndefined();
  });

  it("flags passages that keyword can reach and semantic cannot", async () => {
    rows({}, "2214");
    const f = (await readIngestionHealth()).findings.find((x) => x.id === "unembedded")!;
    expect(f.count).toBe(2214);
    expect(f.action).toContain("brain-backfill");
  });

  it("says nothing at all when there is nothing to say", async () => {
    rows();
    const h = await readIngestionHealth();
    expect(h.findings).toEqual([]);
    expect(summarizeHealth(h)).toMatch(/Nothing to flag/);
  });
});

describe("an unreadable pipeline is not a healthy one", () => {
  it("reports unreadable rather than clean when the query throws", async () => {
    /* THE MISTAKE THIS FILE EXISTS TO CATCH, and it would be embarrassing to
       make it here. An empty findings list from a dead database looks exactly
       like a clean pipeline. */
    mockQuery.mockRejectedValue(new Error("db down"));
    const h = await readIngestionHealth();
    expect(h.readable).toBe(false);
    expect(h.findings).toEqual([]);
    expect(summarizeHealth(h)).toMatch(/not the same as healthy/);
  });

  it("never claims everything is fine from an unreadable read", async () => {
    mockQuery.mockRejectedValue(new Error("db down"));
    expect(summarizeHealth(await readIngestionHealth())).not.toMatch(/Nothing to flag/);
  });
});

describe("the summary", () => {
  it("leads with how many are serious", async () => {
    rows({ stranded: "10", stranded_oldest_days: "103", failed: "165" });
    expect(summarizeHealth(await readIngestionHealth())).toMatch(/serious/);
  });

  it("never uses an em dash", async () => {
    rows({ stranded: "2", failed: "165", skipped: "190", non_corpus: "744", client_corpus: "140" });
    const h = await readIngestionHealth();
    for (const f of h.findings) {
      expect(f.title).not.toContain("—");
      expect(f.detail).not.toContain("—");
    }
    expect(summarizeHealth(h)).not.toContain("—");
  });
});
