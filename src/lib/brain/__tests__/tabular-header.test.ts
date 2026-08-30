/**
 * A row of a spreadsheet means nothing without its column names.
 *
 * MEASURED ON THE LIVE CORPUS, 2026-08-30. A survey export chunks into 105
 * pieces and only the FIRST carries the header:
 *
 *   chunk  0  Sheet: Evaluation Responses
 *             Assessment Name,User ID,...,Class,Location,Prompt,Response
 *   chunk  1  pporting your learning? ...","all of them were great...
 *   chunk  2  er Sales Professional,,6ff691aa,8/21/2026 15:27:12,...
 *
 * A chunk full of hotel names has nothing saying those are LOCATIONS. A chunk
 * of free text has nothing saying it is a RESPONSE. The embedder sees commas.
 *
 * That is why "what feedback did we get about food and beverage" never finds
 * the survey it is plainly inside. Feedback is a document type this client
 * collects constantly, so it is the tabular case that matters most.
 */

import {
  applyTableHeaders,
  readTableContext,
  renderContext,
} from "@/lib/brain/tabular-header";

const SURVEY_HEADER = "Assessment Name,User ID,Class,Location,Prompt,Response";

describe("recognising a table", () => {
  it("reads the sheet and header a spreadsheet export opens with", () => {
    const ctx = readTableContext(`Sheet: Evaluation Responses\n${SURVEY_HEADER}\nrow,data,here,Conrad,q,a`)!;
    expect(ctx.sheet).toBe("Evaluation Responses");
    expect(ctx.header).toBe(SURVEY_HEADER);
  });

  it("reads a header with no sheet line", () => {
    expect(readTableContext(`${SURVEY_HEADER}\nrow,data,here,Conrad,q,a`)?.header).toBe(SURVEY_HEADER);
  });

  /* PROSE MUST BE UNTOUCHED. Almost every document is prose, and a false
     positive here would staple a sentence onto every chunk of a contract. */
  it.each([
    "The payment terms are net 30 from invoice date.",
    "Here's what the brain has on this: **SOW.pdf**",
    "",
    "A single line with, some commas, in it that is really a sentence about things",
  ])("does not see a table in %s", (text) => {
    expect(readTableContext(text)).toBeNull();
  });

  /* THE DANGEROUS FALSE POSITIVE. Mistaking a DATA row for a header would
     stamp one respondent's answers onto all 105 chunks: wrong, and their name
     would ride along on every one of them. */
  /* THE EXPENSIVE FALSE POSITIVE, and an earlier version of this had it. At a
     60 per cent threshold this row passed, because names and status codes look
     exactly like column names: Joseph, Bacus, ACTIVE and jbacus are four
     label-shaped cells out of six.
     Stamping it as the header would have put one respondent's name and status
     on all 105 chunks of the document. Wrong on every chunk, and their
     identity carried into places it never appeared. */
  it("does not mistake a data row for a header", () => {
    const dataRow = "2026 BA Program Evaluation,1bcec47b-e59d-4288,Joseph,Bacus,ACTIVE,jbacus";
    expect(readTableContext(dataRow)).toBeNull();
  });

  it("does not mistake a row of timestamps and ids for a header", () => {
    expect(readTableContext("8/21/2026 15:27:12,6ff691aa-0a81-4832,SINGLE_ANSWER,4")).toBeNull();
  });
});

describe("giving every chunk its columns back", () => {
  const chunks = [
    `Sheet: Evaluation Responses\n${SURVEY_HEADER}\n2026 BA Program,abc,101,Conrad,How was it,Great`,
    "er Sales Professional,,6ff691aa,8/21/2026,Conrad,I would recommend the food and beverage",
    "another,bare,row,Ritz Carlton,q,a",
  ];

  it("prefixes the bare rows", () => {
    const out = applyTableHeaders(chunks);
    expect(out[1]).toContain(SURVEY_HEADER);
    expect(out[2]).toContain(SURVEY_HEADER);
  });

  /* The point of the exercise: the words that were always there now sit next
     to the column that gives them meaning. */
  it("puts Location next to the hotel name", () => {
    const out = applyTableHeaders(chunks);
    expect(out[2]).toMatch(/Location/);
    expect(out[2]).toMatch(/Ritz Carlton/);
  });

  it("leaves a chunk that already carries its header alone", () => {
    expect(applyTableHeaders(chunks)[0]).toBe(chunks[0]);
  });

  /* A WORKBOOK IS SEVERAL TABLES IN A TRENCH COAT. Carrying the first sheet's
     header into the second one's rows would state something FALSE, which is
     worse than omitting something true. */
  it("switches header when a new sheet begins", () => {
    const out = applyTableHeaders([
      `Sheet: Evaluation Responses\n${SURVEY_HEADER}\na,b,c,Conrad,q,r`,
      "bare,row,from,first,sheet,here",
      "Sheet: Export\nName,Email,Score\nJoe,j@x.com,5",
      "Jane,jane@x.com,4",
    ]);
    expect(out[1]).toContain(SURVEY_HEADER);
    expect(out[3]).toContain("Name,Email,Score");
    expect(out[3]).not.toContain(SURVEY_HEADER);
  });

  /* A ROW OF SHORT VALUES LOOKS EXACTLY LIKE A HEADER and nothing about its
     shape says otherwise. Before the context was anchored on the "Sheet:"
     marker, one such row silently stopped every chunk after it from getting
     its columns back, which is the failure this whole file exists to prevent
     arriving quietly. */
  it("is not derailed by a row that looks like a header", () => {
    const out = applyTableHeaders([
      `Sheet: Evaluation Responses\n${SURVEY_HEADER}\na,b,c,Conrad,q,r`,
      "Motor Springs,Conrad,Ritz Carlton,Westlake,Boston,Dallas",
      "another,bare,row,Ritz Carlton,q,a",
    ]);
    expect(out[1]).toContain(SURVEY_HEADER);
    expect(out[2]).toContain(SURVEY_HEADER);
  });

  it("leaves a prose document completely alone", () => {
    const prose = ["The payment terms are net 30.", "Final payment is due on delivery."];
    expect(applyTableHeaders(prose)).toEqual(prose);
  });

  /* Running it twice must not stack headers, so a re-ingest is safe. */
  it("is idempotent", () => {
    const once = applyTableHeaders(chunks);
    expect(applyTableHeaders(once)).toEqual(once);
  });

  it("renders a header with no sheet without an empty label", () => {
    expect(renderContext({ sheet: null, header: SURVEY_HEADER })).toBe(SURVEY_HEADER);
  });
});
