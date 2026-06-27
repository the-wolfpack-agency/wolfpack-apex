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
