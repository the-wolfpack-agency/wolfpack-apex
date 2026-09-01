/**
 * A CSV reader that survives a real export.
 *
 * WHY NOT THE ONE THAT EXISTS. brain/extractor.ts splits on commas and says so
 * in its own comment: tolerant, and correct for header rows only. A
 * change-request export is full of quoted descriptions containing commas and
 * newlines, and a naive split shifts every column after the first one.
 *
 * The consequence is worse than a crash. A status column would fill with
 * fragments of somebody's description and the analysis would come out
 * confident and wrong, which is the failure mode this codebase has spent the
 * week removing.
 */

import { parseCsv, parseCsvRows } from "@/lib/gist/csv";

describe("the cases that break a naive split", () => {
  it("keeps a comma inside a quoted field", () => {
    const t = parseCsv('Number,Status,Description\nCR-1,Approved,"Update pricing, including tax"');
    expect(t.rows[0].Status).toBe("Approved");
    expect(t.rows[0].Description).toBe("Update pricing, including tax");
  });

  it("reads a doubled quote as an escaped quote", () => {
    const t = parseCsv('Number,Note\nCR-1,"He said ""no"" and closed it"');
    expect(t.rows[0].Note).toBe('He said "no" and closed it');
  });

  it("keeps a newline inside a quoted field on the same row", () => {
    const t = parseCsv('Number,Note\nCR-1,"Multi\nline"\nCR-2,Short');
    expect(t.rows).toHaveLength(2);
    expect(t.rows[0].Note).toBe("Multi\nline");
    expect(t.rows[1].Number).toBe("CR-2");
  });

  it("handles an empty trailing cell", () => {
    const t = parseCsv("Number,Status,Completed\nCR-1,Approved,");
    expect(t.rows[0].Completed).toBe("");
  });

  /* Most Windows exports carry one, and it would otherwise become part of the
     first header's name, so that column would never match anything. */
  it("strips a byte order mark", () => {
    const t = parseCsv("﻿Number,Status\nCR-1,Approved");
    expect(t.headers[0]).toBe("Number");
    expect(t.rows[0].Number).toBe("CR-1");
  });

  it("reads a file with no trailing newline", () => {
    expect(parseCsv("A,B\n1,2").rows).toHaveLength(1);
  });

  it("handles CRLF line endings", () => {
    const t = parseCsv("A,B\r\n1,2\r\n3,4");
    expect(t.rows).toHaveLength(2);
    expect(t.rows[1].B).toBe("4");
  });

  /* A short row usually means trailing empty columns. Dropping it would
     quietly shrink the data set somebody is about to draw conclusions from. */
  it("pads a short row rather than dropping it", () => {
    const t = parseCsv("A,B,C\n1,2");
    expect(t.rows).toHaveLength(1);
    expect(t.rows[0].C).toBe("");
  });

  it("ignores blank lines", () => {
    expect(parseCsv("A,B\n\n1,2\n\n").rows).toHaveLength(1);
  });

  it("returns nothing for an empty file rather than throwing", () => {
    expect(parseCsv("")).toEqual({ headers: [], rows: [] });
    expect(parseCsvRows("")).toEqual([]);
  });
});
