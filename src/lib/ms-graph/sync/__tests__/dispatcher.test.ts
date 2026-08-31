/**
 * The dispatcher, which had no tests and had never run.
 *
 * Five workers and a dispatcher were written, are correct on inspection, and
 * were invoked by nothing until 2026-08-31. Scheduling them means untested
 * code meeting a client's Graph tenant at seven in the morning, so the
 * behavior a first run depends on is pinned here: that one broken worker
 * cannot take the others down, that a missing scope is reported rather than
 * thrown, and that a selection is honoured.
 */
const mockEvents = jest.fn();
const mockMessages = jest.fn();
const mockContacts = jest.fn();
const mockFiles = jest.fn();
const mockTasks = jest.fn();

jest.mock("../events", () => ({ syncUser: (...a: unknown[]) => mockEvents(...a) }));
jest.mock("../messages", () => ({ syncUser: (...a: unknown[]) => mockMessages(...a) }));
jest.mock("../contacts", () => ({ syncUser: (...a: unknown[]) => mockContacts(...a) }));
jest.mock("../files", () => ({ syncUser: (...a: unknown[]) => mockFiles(...a) }));
jest.mock("../tasks", () => ({ syncUser: (...a: unknown[]) => mockTasks(...a) }));

import { syncAllEntities, WORKERS } from "../index";
import type { SyncWorkerResult, MsEntityType } from "../common";

const ok = (entityType: MsEntityType, created = 1): SyncWorkerResult => ({
  entityType,
  created,
  updated: 0,
  deleted: 0,
  durationMs: 5,
});

beforeEach(() => {
  for (const m of [mockEvents, mockMessages, mockContacts, mockFiles, mockTasks]) {
    m.mockReset();
  }
  mockEvents.mockResolvedValue(ok("events"));
  mockMessages.mockResolvedValue(ok("messages"));
  mockContacts.mockResolvedValue(ok("contacts"));
  mockFiles.mockResolvedValue(ok("files"));
  mockTasks.mockResolvedValue(ok("tasks"));
});

describe("running only what was selected", () => {
  /* The whole point of the selection: caching a mailbox is a decision, and a
     dispatcher that ran everything regardless would make it silently. */
  it("runs the calendar alone when that is all that was chosen", async () => {
    await syncAllEntities("a@b.com", { only: ["events"] });
    expect(mockEvents).toHaveBeenCalledWith("a@b.com");
    expect(mockMessages).not.toHaveBeenCalled();
    expect(mockContacts).not.toHaveBeenCalled();
    expect(mockFiles).not.toHaveBeenCalled();
  });

  it("runs every worker when nothing is specified", async () => {
    await syncAllEntities("a@b.com");
    for (const m of [mockEvents, mockMessages, mockContacts, mockFiles, mockTasks]) {
      expect(m).toHaveBeenCalled();
    }
  });

  it("has a worker for every entity type it claims", () => {
    for (const e of ["events", "tasks", "messages", "contacts", "files"] as MsEntityType[]) {
      expect(typeof WORKERS[e]).toBe("function");
    }
  });
});

describe("one broken worker does not take the sweep down", () => {
  /* THE BEHAVIOR A FIRST RUN DEPENDS ON. A tenant with no Tasks license, a
     revoked scope, a rate limit: any of them on one entity must leave the
     others to finish, or a single unlucky surface costs the whole night. */
  it("keeps going after a worker reports an error", async () => {
    mockMessages.mockResolvedValue({
      ...ok("messages", 0),
      error: "scope_missing",
      errorMessage: "Mail.Read not granted",
    });

    const res = await syncAllEntities("a@b.com", { only: ["messages", "events"] });
    expect(mockEvents).toHaveBeenCalled();
    expect(res.failedEntityTypes).toEqual(["messages"]);
    expect(res.totalCreated).toBe(1);
  });

  /* A worker that throws rather than returning an error is the case nobody
     writes on purpose and everybody eventually hits. */
  it("survives a worker that throws outright", async () => {
    mockEvents.mockRejectedValue(new Error("graph exploded"));
    await expect(syncAllEntities("a@b.com", { only: ["events", "contacts"] })).resolves.toBeTruthy();
    expect(mockContacts).toHaveBeenCalled();
  });

  it("totals what actually happened rather than what was attempted", async () => {
    mockEvents.mockResolvedValue(ok("events", 7));
    mockContacts.mockResolvedValue({ ...ok("contacts", 0), error: "rate_limited" });
    const res = await syncAllEntities("a@b.com", { only: ["events", "contacts"] });
    expect(res.totalCreated).toBe(7);
    expect(res.failedEntityTypes).toEqual(["contacts"]);
  });
});
