import { mergeRefreshedMessages, type MergeableMessage } from "@/lib/assistant/merge-refreshed-messages";

type Msg = MergeableMessage & { content: string };

const user = (id: string | undefined, content: string): Msg => ({ id, role: "user", content });
const asst = (id: string | undefined, content: string, widget?: unknown): Msg => ({
  id,
  role: "assistant",
  content,
  ...(widget ? { widget } : {}),
});

describe("mergeRefreshedMessages", () => {
  it("REGRESSION: preserves an id-bearing assistant reply absent from the snapshot", () => {
    // The bug: user sends "sales", reply rendered with server messageId m1,
    // then a refresh races the assistant-save and returns only the user row.
    const prev = [user("u1", "sales"), asst("m1", "Here are the open deals...")];
    const remote = [user("u1", "sales")]; // assistant row not yet persisted
    const merged = mergeRefreshedMessages(prev, remote);
    expect(merged.map((m) => m.content)).toContain("Here are the open deals...");
    expect(merged).toHaveLength(2);
    // The shown reply survives the refresh.
    expect(merged.find((m) => m.id === "m1")).toBeDefined();
  });

  it("preserves a no-id optimistic row not represented in the snapshot", () => {
    const prev = [user(undefined, "sales"), asst(undefined, "thinking...")];
    const remote: Msg[] = [];
    const merged = mergeRefreshedMessages(prev, remote);
    expect(merged).toHaveLength(2);
  });

  it("dedupes a no-id optimistic row once the snapshot has the same role+content", () => {
    const prev = [user(undefined, "sales")];
    const remote = [user("u1", "sales")]; // server now has it with an id
    const merged = mergeRefreshedMessages(prev, remote);
    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe("u1");
  });

  it("does not duplicate an id-bearing row already in the snapshot", () => {
    const prev = [user("u1", "sales"), asst("m1", "deals")];
    const remote = [user("u1", "sales"), asst("m1", "deals")];
    const merged = mergeRefreshedMessages(prev, remote);
    expect(merged).toHaveLength(2);
  });

  it("dedupes an id-mismatched local reply when the snapshot has the same content under a different id", () => {
    const prev = [asst("local-tmp", "deals")];
    const remote = [asst("server-id", "deals")];
    const merged = mergeRefreshedMessages(prev, remote);
    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe("server-id");
  });

  it("orders server rows first, then local rows still missing", () => {
    const prev = [user("u1", "sales"), asst("m1", "deals")];
    const remote = [user("u1", "sales")];
    const merged = mergeRefreshedMessages(prev, remote);
    expect(merged[0].id).toBe("u1");
    expect(merged[1].id).toBe("m1");
  });

  it("preserves a locally-set widget when the snapshot row lacks it", () => {
    const widget = { kind: "task_list" };
    const prev = [asst("m1", "your tasks", widget)];
    const remote = [asst("m1", "your tasks")]; // snapshot row without widget
    const merged = mergeRefreshedMessages(prev, remote);
    expect(merged).toHaveLength(1);
    expect(merged[0].widget).toEqual(widget);
  });

  it("keeps the snapshot widget when it already has one (does not clobber)", () => {
    const localWidget = { kind: "task_list" };
    const remoteWidget = { kind: "calendar" };
    const prev = [asst("m1", "x", localWidget)];
    const remote = [asst("m1", "x", remoteWidget)];
    const merged = mergeRefreshedMessages(prev, remote);
    expect(merged[0].widget).toEqual(remoteWidget);
  });

  it("returns the snapshot unchanged when there is no local state", () => {
    const remote = [user("u1", "sales"), asst("m1", "deals")];
    const merged = mergeRefreshedMessages([], remote);
    expect(merged).toEqual(remote);
  });
});

describe("the answer on screen is not rewritten under the reader", () => {
  /* Reported 2026-08-19: a correct reply was replaced, seconds after it
     arrived, by the stored version with a hedging note prepended. The row was
     never dropped, so it read as the answer disappearing. */
  it("keeps the local content when the snapshot has rewritten the same turn", () => {
    const prev = [{ id: "m1", role: "assistant", content: "Ready to help. What's the task?" }];
    const remote = [
      {
        id: "m1",
        role: "assistant",
        content: "_Note: this answer may need a second look._\n\nReady to help. What's the task?",
      },
    ];
    const merged = mergeRefreshedMessages(prev, remote);
    expect(merged).toHaveLength(1);
    expect(merged[0].content).toBe("Ready to help. What's the task?");
  });

  it("still takes the server's row for a turn the client never had", () => {
    // The fix must not make a refresh useless: a turn from another tab or a
    // slow save still arrives.
    const merged = mergeRefreshedMessages(
      [{ id: "m1", role: "assistant", content: "first" }],
      [
        { id: "m1", role: "assistant", content: "first" },
        { id: "m2", role: "assistant", content: "second, from the server" },
      ],
    );
    expect(merged.map((m) => m.content)).toEqual(["first", "second, from the server"]);
  });
});

/**
 * Reported 2026-08-19: "the model name displayed for a bit then disappeared."
 *
 * The same mechanism as the answers that vanished, one field along. Which model
 * produced a reply is returned by the send and is not stored on the message
 * row, so a snapshot taken seconds later has no such field, and the merge
 * replaced the local row with it. The badge blinked out after arriving.
 */
describe("model attribution survives a background refresh", () => {
  test("a snapshot with no model does not erase the one on screen", () => {
    const local = [
      { id: "m1", role: "user", content: "what is up" },
      {
        id: "m2",
        role: "assistant",
        content: "Not much.",
        model: "gpt-4o-mini",
        provider: "azure-openai",
        tierRequested: "cheap",
      },
    ];
    const remote = [
      { id: "m1", role: "user", content: "what is up" },
      { id: "m2", role: "assistant", content: "Not much." },
    ];

    const merged = mergeRefreshedMessages(local, remote);
    expect(merged).toHaveLength(2);
    expect(merged[1]).toMatchObject({
      model: "gpt-4o-mini",
      provider: "azure-openai",
      tierRequested: "cheap",
    });
  });

  test("if the server ever does carry one, the server's wins", () => {
    /* The precedence that matters on the day this field becomes persisted:
       the stored value is the record, and the local copy only fills a gap. */
    const merged = mergeRefreshedMessages(
      [{ id: "m2", role: "assistant", content: "a", model: "stale-model" }],
      [{ id: "m2", role: "assistant", content: "a", model: "gpt-4o" }],
    );
    expect(merged[0].model).toBe("gpt-4o");
  });

  test("a turn with no model is left without one, rather than inventing it", () => {
    /* Typed with the optional field present so the assertion is about the
       VALUE being absent, not about the property being unknown to TypeScript. */
    const merged = mergeRefreshedMessages<{
      id: string;
      role: string;
      content: string;
      model?: string;
    }>(
      [{ id: "m2", role: "assistant", content: "zero token answer" }],
      [{ id: "m2", role: "assistant", content: "zero token answer" }],
    );
    expect(merged[0].model).toBeUndefined();
  });
});
