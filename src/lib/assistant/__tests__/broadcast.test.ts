/**
 * One message into every user's assistant, and the thing it must never become.
 *
 * The hazard is not delivery. It is that the org-wide answer cache reads
 * assistant messages out of any conversation and replays them to the whole
 * workspace, and the knowledge base promotes answers into curated facts. A
 * broadcast stored as an ordinary assistant message therefore becomes a
 * cacheable ANSWER: "submit expenses by Friday" served to somebody who asks
 * about expense policy three weeks later, and eventually written down as a
 * standing fact about this company.
 *
 * That failure already happened once in a different form. On 2026-08-27 a
 * general-knowledge answer was cached, served ahead of the documents that held
 * the real material, and promoted into curated knowledge.
 *
 * So most of what is asserted here is about what a broadcast is NOT.
 */

const mockTrack = jest.fn();
const mockAudit = jest.fn().mockResolvedValue(undefined);
const mockQuery = jest.fn();

jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: unknown[]) => mockTrack(...a) }));
jest.mock("@/lib/audit-log", () => ({ recordAudit: (...a: unknown[]) => mockAudit(...a) }));
jest.mock("@/lib/db", () => ({ query: (...a: unknown[]) => mockQuery(...a) }));

import { broadcastToAssistants, MAX_BROADCAST_CHARS } from "@/lib/assistant/broadcast";

const input = {
  message: "Office closed Monday for the bank holiday.",
  workspaceId: "ws1",
  actorId: "u-actor",
  actorRole: "cto",
};

/** Recipients, then per-user conversation insert and message insert. */
function wireHappyPath(recipients: string[]) {
  mockQuery.mockReset();
  mockQuery.mockImplementation((sql: string) => {
    if (sql.includes("FROM instinct_team_members")) {
      return Promise.resolve({ rows: recipients.map((id) => ({ id })) });
    }
    if (sql.includes("INSERT INTO instinct_conversations")) {
      return Promise.resolve({ rows: [{ id: "c1" }] });
    }
    return Promise.resolve({ rows: [] });
  });
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("delivery", () => {
  it("writes the message to every active member", async () => {
    wireHappyPath(["a", "b", "c"]);
    const r = await broadcastToAssistants(input);
    expect(r.delivered).toBe(3);
    expect(r.failed).toBe(0);
    expect(r.readable).toBe(true);
  });

  it("keeps going when one person cannot be written to", async () => {
    let seen = 0;
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes("FROM instinct_team_members")) {
        return Promise.resolve({ rows: [{ id: "a" }, { id: "b" }, { id: "c" }] });
      }
      if (sql.includes("INSERT INTO instinct_conversations")) {
        seen += 1;
        if (seen === 2) return Promise.reject(new Error("nope"));
        return Promise.resolve({ rows: [{ id: "c1" }] });
      }
      return Promise.resolve({ rows: [] });
    });
    const r = await broadcastToAssistants(input);
    expect(r.delivered).toBe(2);
    expect(r.failed).toBe(1);
  });

  /* An unreadable recipient list is not an empty one. Reporting zero delivered
     as a clean send is how somebody believes the company was told something it
     was not. */
  it("reports an unreadable recipient list rather than a successful send of zero", async () => {
    mockQuery.mockRejectedValue(new Error("db down"));
    const r = await broadcastToAssistants(input);
    expect(r.readable).toBe(false);
    expect(r.delivered).toBe(0);
  });

  it("sends nothing for an empty message", async () => {
    wireHappyPath(["a"]);
    const r = await broadcastToAssistants({ ...input, message: "   " });
    expect(r.delivered).toBe(0);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("refuses a message longer than the limit", async () => {
    wireHappyPath(["a"]);
    await expect(
      broadcastToAssistants({ ...input, message: "x".repeat(MAX_BROADCAST_CHARS + 1) }),
    ).rejects.toThrow(/at most/);
  });
});

describe("a broadcast is not an answer", () => {
  it("is stored with its own source, never as a normal assistant reply", async () => {
    wireHappyPath(["a"]);
    await broadcastToAssistants(input);
    const insert = mockQuery.mock.calls.find((c) =>
      String(c[0]).includes("INSERT INTO instinct_messages"),
    );
    expect(insert).toBeDefined();
    expect(String(insert![0])).toContain("'broadcast'");
  });

  /* Zero tokens is not cosmetic. The deterministic-share figure counts a reply
     as model-answered when it records tokens, so a broadcast carrying tokens
     would quietly report the product as using a model more than it does. */
  it("records no tokens, so it cannot distort the deterministic share", async () => {
    wireHappyPath(["a"]);
    await broadcastToAssistants(input);
    const insert = mockQuery.mock.calls.find((c) =>
      String(c[0]).includes("INSERT INTO instinct_messages"),
    );
    expect(String(insert![0])).toMatch(/,\s*0,/);
  });

  it("carries no grounding flag, which is what the cache requires", async () => {
    wireHappyPath(["a"]);
    await broadcastToAssistants(input);
    const insert = mockQuery.mock.calls.find((c) =>
      String(c[0]).includes("INSERT INTO instinct_messages"),
    );
    const metadata = JSON.parse(String(insert![1]![2]));
    expect(metadata.grounded).toBeUndefined();
    expect(metadata.broadcast).toBe(true);
  });

  /* Its own conversation, so an announcement never lands in the middle of
     somebody's half-finished question, and never sits next to a user message
     the cache could pair it with. */
  it("lands in its own conversation rather than an existing thread", async () => {
    wireHappyPath(["a"]);
    await broadcastToAssistants(input);
    const conv = mockQuery.mock.calls.find((c) =>
      String(c[0]).includes("INSERT INTO instinct_conversations"),
    );
    expect(conv).toBeDefined();
    expect(String(conv![1]![1])).toBe("Announcement");
  });

  /* The column is last_message_at. An earlier draft wrote updated_at, which
     does not exist on this table and would have thrown on the first send. */
  it("sets last_message_at, the column this table actually has", async () => {
    wireHappyPath(["a"]);
    await broadcastToAssistants(input);
    const conv = mockQuery.mock.calls.find((c) =>
      String(c[0]).includes("INSERT INTO instinct_conversations"),
    );
    expect(String(conv![0])).toContain("last_message_at");
    expect(String(conv![0])).not.toContain("updated_at");
  });
});

describe("it goes through the same gate as an answer", () => {
  it("removes a personal identifier before sending it to everybody", async () => {
    wireHappyPath(["a", "b"]);
    const r = await broadcastToAssistants({
      ...input,
      message: "Payroll questions to finance. Reference card 4111 1111 1111 1111.",
    });
    expect(r.redacted.length).toBeGreaterThan(0);
    const insert = mockQuery.mock.calls.find((c) =>
      String(c[0]).includes("INSERT INTO instinct_messages"),
    );
    expect(String(insert![1]![1])).not.toContain("4111 1111 1111 1111");
  });
});

describe("it is recorded", () => {
  it("writes an analytics event naming the sender and the reach", async () => {
    wireHappyPath(["a", "b"]);
    await broadcastToAssistants(input);
    expect(mockTrack).toHaveBeenCalledWith(
      "assistant.broadcast_sent",
      "u-actor",
      "cto",
      expect.objectContaining({ recipients: 2, delivered: 2, failed: 0 }),
    );
  });

  /* Writing into every person's assistant is a privileged action, and "who
     sent this to the whole company" is a question somebody will ask. */
  it("writes an audit entry", async () => {
    wireHappyPath(["a"]);
    await broadcastToAssistants(input);
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "assistant.broadcast_sent" }),
    );
  });

  it("does not lose the send when the audit write fails", async () => {
    wireHappyPath(["a"]);
    mockAudit.mockRejectedValueOnce(new Error("audit down"));
    const r = await broadcastToAssistants(input);
    expect(r.delivered).toBe(1);
  });
});
