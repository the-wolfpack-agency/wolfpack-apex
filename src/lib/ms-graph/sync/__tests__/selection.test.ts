/**
 * Which Microsoft entities this deployment keeps.
 *
 * The whole sync layer exists and was called by nothing, so every canonical
 * table held zero rows and eleven learning extractors read them. Switching all
 * five on because they happened to be written would answer "what do we keep
 * from somebody's mailbox" by accident.
 */
import { selectedEntities, notSelected, DEFAULT_ENTITIES, ALL_ENTITIES } from "../selection";

describe("what gets kept", () => {
  /* A calendar holds who met whom and when: the least sensitive of the five,
     and the one whose absence costs most here. The most frequent unanswered
     questions on this deployment are all about meetings. */
  it("keeps the calendar by default and nothing else", () => {
    expect(selectedEntities(undefined)).toEqual(["events"]);
    expect(DEFAULT_ENTITIES).toEqual(["events"]);
  });

  it("does not keep mail, contacts or files unless asked", () => {
    const chosen = selectedEntities(undefined);
    for (const e of ["messages", "contacts", "files"]) expect(chosen).not.toContain(e);
  });

  it("keeps exactly what configuration names", () => {
    expect(selectedEntities("events,messages")).toEqual(["events", "messages"]);
  });

  /* The setting a client deployment needs before anybody has decided. */
  it("keeps nothing when told none", () => {
    expect(selectedEntities("none")).toEqual([]);
  });

  /* A typo must not stop the syncs that were spelled correctly, and the
     report says what was selected so a missing one is visible. */
  it("drops an unknown name rather than failing everything", () => {
    expect(selectedEntities("events,emails")).toEqual(["events"]);
  });

  it("is not case or space sensitive, because a person types it", () => {
    expect(selectedEntities(" Events , Contacts ")).toEqual(["events", "contacts"]);
  });

  /* A report that says what is kept must also say what is not, or a reader
     cannot tell a decision from an omission. */
  it("names what is deliberately not kept", () => {
    expect(notSelected(["events"]).sort()).toEqual(["contacts", "files", "messages", "tasks"]);
    expect(notSelected(ALL_ENTITIES)).toEqual([]);
  });
});
