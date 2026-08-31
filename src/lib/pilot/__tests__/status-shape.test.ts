/**
 * The arithmetic over a pilot status reading, and the one rule it enforces:
 * a source that was not read is never counted as empty.
 *
 * WHY THIS FILE IS MOSTLY ABOUT ZEROS. On 2026-08-26 this product was found to
 * contain six controls that were declared, described accurately in code, and
 * never executed. Every one reported a zero, and every zero had been read as
 * good news: a second model had reviewed zero answers while the playbook told
 * clients it reviewed every one. The tell was always the same, that a test
 * used the shape the code handles rather than the shape reality produces.
 *
 * Status is where that mistake is cheapest to make and most expensive to ship,
 * because "no blockers" is exactly what somebody wants to hear. So these tests
 * assert the UNHAPPY shapes: a dark source, a partial view, a clean single
 * source that is not entitled to a verdict.
 */

import {
  buildSignals,
  completedTaskCount,
  darkSources,
  documentsLanded,
  documentsNotIndexed,
  formatWhen,
  nextMeeting,
  openTaskCount,
  overdueTaskCount,
  readableSources,
  readiness,
  readinessLabel,
  summarize,
  type PilotStatusReading,
  type SourceReading,
  type StatusDocument,
  type StatusMeeting,
  type StatusTask,
} from "@/lib/pilot/status-shape";

const NOW = Date.parse("2026-08-26T12:00:00.000Z");

function ok<T>(items: T[]): SourceReading<T> {
  return { state: "ok", detail: null, items };
}
function dark<T>(detail = "the read failed"): SourceReading<T> {
  return { state: "unavailable", detail, items: [] };
}
function unconnected<T>(): SourceReading<T> {
  return { state: "not_connected", detail: "Microsoft 365 is not connected.", items: [] };
}

function meeting(over: Partial<StatusMeeting> = {}): StatusMeeting {
  return {
    id: "m1",
    subject: "Pilot review",
    start: new Date(NOW + 2 * 24 * 60 * 60 * 1000).toISOString(),
    attendees: ["client@example.com"],
    minutesUntil: 2 * 24 * 60,
    ...over,
  };
}
function doc(over: Partial<StatusDocument> = {}): StatusDocument {
  return {
    id: "d1",
    filename: "SOW.pdf",
    createdAt: new Date(NOW - 24 * 60 * 60 * 1000).toISOString(),
    indexed: true,
    ...over,
  };
}
function task(over: Partial<StatusTask> = {}): StatusTask {
  return { id: "t1", title: "Draft the report", dueAt: null, overdue: false, completed: false, ...over };
}

function reading(over: Partial<PilotStatusReading> = {}): PilotStatusReading {
  return {
    takenAt: new Date(NOW).toISOString(),
    windowDays: 14,
    calendar: ok([meeting()]),
    documents: ok([doc()]),
    tasks: ok([task()]),
    ...over,
  };
}

describe("a source that was not read is never a zero", () => {
  /* THE CENTRAL INVARIANT. Each of these returns a number when the source
     answered and null when it did not, and the two cases must not collapse. */
  it.each([
    ["openTaskCount", openTaskCount],
    ["overdueTaskCount", overdueTaskCount],
    ["completedTaskCount", completedTaskCount],
  ])("%s is null when the task store is dark, not 0", (_name, fn) => {
    expect(fn(reading({ tasks: dark() }))).toBeNull();
    /* And it really does return a number when the source answered, so the
       null above is proof of the distinction and not proof of a broken fn. */
    expect(fn(reading({ tasks: ok([]) }))).toBe(0);
  });

  it("documentsLanded is null when the Brain is dark, not 0", () => {
    expect(documentsLanded(reading({ documents: dark() }))).toBeNull();
    expect(documentsLanded(reading({ documents: ok([]) }))).toBe(0);
  });

  it("documentsNotIndexed is null when the Brain is dark, not 0", () => {
    expect(documentsNotIndexed(reading({ documents: dark() }))).toBeNull();
    expect(documentsNotIndexed(reading({ documents: ok([doc({ indexed: false })]) }))).toBe(1);
  });

  it("nextMeeting is null when the calendar is dark, and when it is merely empty", () => {
    expect(nextMeeting(reading({ calendar: dark() }))).toBeNull();
    expect(nextMeeting(reading({ calendar: ok([]) }))).toBeNull();
    /* Distinguishable at the source even though both meetings are null. */
    expect(darkSources(reading({ calendar: dark() }))).toHaveLength(1);
    expect(darkSources(reading({ calendar: ok([]) }))).toHaveLength(0);
  });

  it("a meeting already in the past is not the next checkpoint", () => {
    const past = meeting({ minutesUntil: -30 });
    expect(nextMeeting(reading({ calendar: ok([past]) }))).toBeNull();
  });

  it("picks the soonest upcoming meeting, not the first in the array", () => {
    const later = meeting({ id: "later", subject: "Later", minutesUntil: 900 });
    const sooner = meeting({ id: "sooner", subject: "Sooner", minutesUntil: 60 });
    expect(nextMeeting(reading({ calendar: ok([later, sooner]) }))?.id).toBe("sooner");
  });
});

describe("readiness refuses to be optimiztic about what it did not read", () => {
  it("is unknown when only one source answered, however clean that source is", () => {
    /* The trap in one test. Tasks are empty and perfect, and answering
       "on track" from that alone would be a claim about a calendar and a
       document library nobody looked at. */
    const r = reading({ calendar: dark(), documents: dark(), tasks: ok([]) });
    expect(openTaskCount(r)).toBe(0);
    expect(readiness(r)).toBe("unknown");
    expect(readinessLabel(readiness(r))).toBe("Not enough signal");
  });

  it("is unknown when nothing answered at all", () => {
    expect(readiness(reading({ calendar: dark(), documents: dark(), tasks: dark() }))).toBe("unknown");
  });

  it("is blocked when overdue work sits in front of a booked checkpoint", () => {
    const r = reading({
      calendar: ok([meeting()]),
      tasks: ok([task({ overdue: true, dueAt: new Date(NOW - 1000).toISOString() })]),
    });
    expect(readiness(r)).toBe("blocked");
  });

  it("is at risk when work is overdue and no checkpoint is booked", () => {
    const r = reading({
      calendar: ok([]),
      tasks: ok([task({ overdue: true })]),
    });
    expect(readiness(r)).toBe("at_risk");
  });

  it("is at risk when a checkpoint is booked and nothing has landed", () => {
    const r = reading({ calendar: ok([meeting()]), documents: ok([]), tasks: ok([]) });
    expect(readiness(r)).toBe("at_risk");
  });

  it("is on track only when two or more sources answered and nothing is wrong", () => {
    expect(readiness(reading())).toBe("on_track");
  });

  it("does not claim on track from a clean calendar plus a dark task store", () => {
    /* Two sources answer, so the verdict is allowed, but the overdue count is
       unknown. It must not become "no overdue work". */
    const r = reading({ calendar: ok([meeting()]), documents: ok([doc()]), tasks: dark() });
    expect(overdueTaskCount(r)).toBeNull();
    /* Allowed to be on_track on the evidence it has, but the dark source is
       still reported, and the summary says so. That is the contract. */
    expect(darkSources(r).map((d) => d.source)).toEqual(["tasks"]);
    expect(summarize(r)).toMatch(/partial view/i);
  });
});

describe("signals are cross-source first, and the dark ones are never dropped", () => {
  it("names overdue work against the meeting it is due before", () => {
    const r = reading({
      calendar: ok([meeting({ subject: "Steering committee" })]),
      tasks: ok([
        task({ id: "a", overdue: true }),
        task({ id: "b", overdue: true }),
      ]),
    });
    const s = buildSignals(r, "UTC");
    const blocker = s.find((x) => x.id === "overdue-before-checkpoint");
    expect(blocker).toBeDefined();
    expect(blocker!.tone).toBe("blocker");
    expect(blocker!.title).toContain("Steering committee");
    expect(blocker!.title).toContain("2 overdue");
    /* Two sources. This is the row no single integration could produce. */
    expect(blocker!.sources).toEqual(["calendar", "tasks"]);
    /* And it leads. */
    expect(s[0].id).toBe("overdue-before-checkpoint");
  });

  it("flags a checkpoint with no recent material", () => {
    const r = reading({ calendar: ok([meeting()]), documents: ok([]), tasks: ok([]) });
    const s = buildSignals(r);
    const watch = s.find((x) => x.id === "checkpoint-without-material");
    expect(watch).toBeDefined();
    expect(watch!.sources).toEqual(["calendar", "documents"]);
  });

  it("emits a dark signal for every source that did not answer", () => {
    const r = reading({ calendar: unconnected(), documents: dark("Brain read failed") });
    const s = buildSignals(r);
    const darkOnes = s.filter((x) => x.tone === "dark");
    expect(darkOnes.map((d) => d.id).sort()).toEqual(["dark-calendar", "dark-documents"]);
    /* The reason travels with it. A dark row that says nothing is a dark row
       nobody acts on. */
    expect(darkOnes.find((d) => d.id === "dark-documents")!.detail).toContain("Brain read failed");
    expect(darkOnes.find((d) => d.id === "dark-calendar")!.title).toContain("not connected");
  });

  it("never reports work as clear when the task store was not read", () => {
    const r = reading({ tasks: dark() });
    const s = buildSignals(r);
    expect(s.find((x) => x.id === "work-clear")).toBeUndefined();
    expect(s.find((x) => x.id === "work-remaining")).toBeUndefined();
    expect(s.find((x) => x.id === "dark-tasks")).toBeDefined();
  });

  it("does report work as clear when the task store answered and was empty", () => {
    const r = reading({ tasks: ok([]) });
    const clear = buildSignals(r).find((x) => x.id === "work-clear");
    expect(clear).toBeDefined();
    /* The wording has to carry the difference, because this is the sentence a
       client hears. "The task store answered and it is empty" is a claim about
       having looked. */
    expect(clear!.detail).toContain("answered");
  });

  it("flags documents that landed but cannot be quoted from", () => {
    const r = reading({ documents: ok([doc({ indexed: false })]) });
    const s = buildSignals(r).find((x) => x.id === "documents-not-answerable");
    expect(s).toBeDefined();
    expect(s!.tone).toBe("watch");
  });
});

describe("the spoken summary", () => {
  it("leads with the verdict and names the systems it could not read", () => {
    const r = reading({ tasks: dark("The task store read failed: timeout") });
    const line = summarize(r, "UTC");
    expect(line).toMatch(/tasks unavailable/i);
    expect(line).toMatch(/partial view/i);
  });

  it("says plainly that nothing is a zero when every source is dark", () => {
    const r = reading({ calendar: dark(), documents: dark(), tasks: dark() });
    const line = summarize(r);
    expect(line).toMatch(/not a zero|it is an unknown/i);
    /* Must never contain a count, because there is nothing to count. */
    expect(line).not.toMatch(/\b0 (open|documents)/);
  });

  it("does not promise a checkpoint it cannot see", () => {
    const r = reading({ calendar: dark() });
    expect(summarize(r)).not.toMatch(/next checkpoint/i);
  });

  it("reads the clean case as a plain sentence", () => {
    const line = summarize(reading(), "UTC");
    expect(line).toMatch(/^On track:/);
    expect(line).not.toMatch(/partial view/i);
  });

  it("has no em dashes anywhere it can produce text", () => {
    /* House style, enforced where the product speaks rather than in review. */
    const cases = [
      summarize(reading(), "UTC"),
      summarize(reading({ tasks: dark() }), "UTC"),
      summarize(reading({ calendar: dark(), documents: dark(), tasks: dark() })),
      ...buildSignals(reading({ calendar: unconnected() }), "UTC").flatMap((s) => [s.title, s.detail]),
    ];
    for (const c of cases) expect(c).not.toContain("—");
  });
});

describe("formatWhen", () => {
  it("formats in the reader's zone, not the server's", () => {
    const iso = "2026-08-27T23:30:00.000Z";
    const utc = formatWhen(iso, "UTC");
    const ny = formatWhen(iso, "America/New_York");
    expect(utc).not.toEqual(ny);
    /* 23:30 UTC is the previous evening in New York. The whole reason the
       tool context carries a time zone. */
    expect(ny).toContain("Aug 27");
    expect(utc).toContain("Aug 27");
    expect(ny).toContain("7:30");
  });

  it("survives an unparseable date and an invalid zone without throwing", () => {
    expect(formatWhen("not-a-date")).toBe("an unreadable date");
    expect(() => formatWhen("2026-08-27T10:00:00Z", "Mars/Olympus")).not.toThrow();
  });
});

describe("readableSources", () => {
  it("counts only the sources that actually answered", () => {
    expect(readableSources(reading())).toEqual(["calendar", "documents", "tasks"]);
    expect(readableSources(reading({ documents: dark() }))).toEqual(["calendar", "tasks"]);
    expect(readableSources(reading({ calendar: unconnected(), tasks: dark() }))).toEqual(["documents"]);
  });
});
