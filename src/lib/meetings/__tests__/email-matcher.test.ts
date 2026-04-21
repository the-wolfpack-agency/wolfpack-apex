/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Email matcher — the robust fallback path that finally fixes the
 * "No recent email with attendees" bug. Filter lives in JavaScript,
 * not Graph OData, so it doesn't depend on any tenant-specific
 * filter support or on attendee.address being populated.
 */

import { matchMessagesToAttendees } from "@/lib/meetings/email-matcher";

function msg(id: string, over: Partial<any> = {}): any {
  return {
    id,
    subject: "s",
    from: { emailAddress: { name: "X", address: "x@co" } },
    toRecipients: [],
    ccRecipients: [],
    receivedDateTime: "2026-04-21T10:00:00Z",
    bodyPreview: "",
    isRead: true,
    importance: "normal",
    ...over,
  };
}

describe("matchMessagesToAttendees", () => {
  test("matches by attendee EMAIL appearing as sender address", () => {
    const messages = [
      msg("m1", {
        from: { emailAddress: { name: "Nick H", address: "nick@wolfpack.dev" } },
      }),
      msg("m2", {
        from: { emailAddress: { name: "Other", address: "other@x.co" } },
      }),
    ];
    const hits = matchMessagesToAttendees(messages, [], ["nick@wolfpack.dev"]);
    expect(hits.map((h) => h.id)).toEqual(["m1"]);
  });

  test("matches by attendee NAME when only name is known (Graph omits address)", () => {
    const messages = [
      msg("m1", {
        // Sender address differs, but recipient NAME matches attendee
        from: { emailAddress: { name: "You", address: "me@wolfpack.dev" } },
        toRecipients: [
          { emailAddress: { name: "Nick Hoxsie", address: "nick.h@wolfpack.dev" } },
        ],
      }),
      msg("m2"),
    ];
    const hits = matchMessagesToAttendees(
      messages,
      ["Nick Hoxsie"], // attendees = display names, attendeeEmails = empty
      [],
    );
    expect(hits.map((h) => h.id)).toEqual(["m1"]);
  });

  test("finds threads we SENT (from=us, to=attendee) — the old gap", () => {
    const messages = [
      msg("out", {
        from: { emailAddress: { name: "Me", address: "nick@wolfpack.dev" } },
        toRecipients: [
          { emailAddress: { name: "Meghan Burke", address: "meghan@wolfpack.dev" } },
        ],
      }),
    ];
    const hits = matchMessagesToAttendees(messages, ["Meghan Burke"], []);
    expect(hits.map((h) => h.id)).toEqual(["out"]);
  });

  test("matches CC participants", () => {
    const messages = [
      msg("m1", {
        ccRecipients: [{ emailAddress: { name: "Jorge Colon", address: "jorge@wolfpack.dev" } }],
      }),
    ];
    expect(
      matchMessagesToAttendees(messages, ["Jorge Colon"], []).map((h) => h.id),
    ).toEqual(["m1"]);
  });

  test("dedupes messages that match multiple needles", () => {
    const messages = [
      msg("m1", {
        from: { emailAddress: { name: "Nick H", address: "nick@wolfpack.dev" } },
        toRecipients: [{ emailAddress: { name: "Nick H", address: "nick@wolfpack.dev" } }],
      }),
    ];
    const hits = matchMessagesToAttendees(messages, ["Nick H"], ["nick@wolfpack.dev"]);
    expect(hits).toHaveLength(1);
  });

  test("returns [] when there are no needles", () => {
    expect(matchMessagesToAttendees([msg("m1")], [], [])).toEqual([]);
  });

  test("is case-insensitive on both sides", () => {
    const messages = [
      msg("m1", {
        from: { emailAddress: { name: "NICK HOXSIE", address: "NICK@Wolfpack.DEV" } },
      }),
    ];
    const hits = matchMessagesToAttendees(messages, ["nick hoxsie"], []);
    expect(hits.map((h) => h.id)).toEqual(["m1"]);
  });

  test("ignores non-string / blank attendee entries", () => {
    const messages = [
      msg("m1", {
        from: { emailAddress: { name: "Nick Hoxsie", address: "nick@wolfpack.dev" } },
      }),
    ];
    const hits = matchMessagesToAttendees(
      messages,
      ["Nick Hoxsie", "", "   ", null as any, undefined as any],
      [],
    );
    expect(hits).toHaveLength(1);
  });
});
