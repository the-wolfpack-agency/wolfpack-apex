/**
 * A spreadsheet is good grounding and a bad quote.
 *
 * Measured 2026-08-27 by driving the real assistant against the real corpus.
 * "which hotels were surveyed in August" answered with:
 *
 *   3a931b25-...,Firstname,Lastname,ACTIVE,flastname,PCNA,PCNA Dealer General Manager
 *
 * A named dealer GM, their username and their role, printed into a chat
 * because a spreadsheet chunks as raw CSV and the Brain quoted the chunk
 * verbatim. Other rows carried a.person@example-dealer.com and
 * another.person@example.com.
 *
 * Redaction catches the email and cannot catch the name, because a name in a
 * CSV column is not a pattern. The row should not be quoted at all.
 *
 * The same hits handed to the model came back as prose with citations and no
 * personal data, which is the answer somebody actually wanted. So the fix is
 * not a better redactor, it is knowing which chunks are quotable.
 */

import { looksTabular } from "@/lib/brain/query";

describe("chunks that must not be quoted verbatim", () => {
  it("catches the survey row that named a real person", () => {
    /* The exact content that shipped to a chat window. */
    const row =
      'feedback on check-in, accommodations, customer service, and food & beverage. ' +
      '","Hotel was fine, no issues. " 2026 BA Program Evaluation - April 2026 Rev,' +
      '00000000-0000-4000-8000-000000000001,Firstname,Lastname,ACTIVE,flastname,PCNA,' +
      'PCNA Dealer General Manager,,00000000-0000-4000-8000-000000000002,8/21/2026 16:32:44';
    expect(looksTabular(row)).toBe(true);
  });

  it("catches a row on the UUID alone, before counting commas", () => {
    /* A UUID is never prose. One is enough. */
    expect(looksTabular("record 00000000-0000-4000-8000-000000000003 was updated")).toBe(true);
  });
});

describe("prose that must still be quoted", () => {
  it.each([
    "Learning Journal Brand Ambassador 101 Skills",
    "The engagement covers Phase One delivery. Payment terms are net thirty days.",
    "ted eLearning suite and supported by the Porsche Mobile Academy channel to enable continuous development beyond the classroom. Skills Training Program Communication Skills Customer Engagement",
  ])("%s is quotable", (text) => {
    /* THE HALF THAT MATTERS MOST. Verbatim quoting is fast, free, and better
       than a paraphrase. Declining to quote prose would spend a model call on
       every document question and throw away the zero-token answer that makes
       the product what it is. */
    expect(looksTabular(text)).toBe(false);
  });

  it("tolerates prose with ordinary commas", () => {
    expect(
      looksTabular(
        "Communication skills, customer engagement, brand heritage, and change management are covered in the classroom, with coaching afterwards.",
      ),
    ).toBe(false);
  });

  it("says no to an empty chunk rather than guessing", () => {
    expect(looksTabular("")).toBe(false);
    expect(looksTabular("   ")).toBe(false);
  });
});
