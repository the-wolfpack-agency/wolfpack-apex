/**
 * @jest-environment jsdom
 */

/**
 * setup-draft tests — sessionStorage helpers for wizard draft persistence.
 */

beforeEach(() => {
  sessionStorage.clear();
});

import { loadDraft, saveDraft, clearDraft, SetupDraft } from "@/lib/setup-draft";

const KEY = "instinct_setup_draft_v1";

describe("loadDraft", () => {
  it("returns empty object when storage is empty", () => {
    expect(loadDraft()).toEqual({});
  });

  it("returns saved draft with workspaceName", () => {
    const draft: SetupDraft = { workspaceName: "Acme Corp" };
    sessionStorage.setItem(KEY, JSON.stringify(draft));
    expect(loadDraft()).toEqual({ workspaceName: "Acme Corp" });
  });

  it("returns saved draft with invites", () => {
    const draft: SetupDraft = {
      workspaceName: "Team",
      invites: [{ email: "a@b.com", role: "dev" }],
    };
    sessionStorage.setItem(KEY, JSON.stringify(draft));
    expect(loadDraft()).toEqual(draft);
  });

  it("returns empty object for corrupt JSON", () => {
    sessionStorage.setItem(KEY, "not-valid-json{{");
    expect(loadDraft()).toEqual({});
  });

  it("returns empty object for empty string stored", () => {
    sessionStorage.setItem(KEY, "");
    expect(loadDraft()).toEqual({});
  });
});

describe("saveDraft", () => {
  it("writes draft to sessionStorage", () => {
    saveDraft({ workspaceName: "My Workspace" });
    expect(sessionStorage.getItem(KEY)).toBe(JSON.stringify({ workspaceName: "My Workspace" }));
  });

  it("overwrites existing draft", () => {
    saveDraft({ workspaceName: "Old Name" });
    saveDraft({ workspaceName: "New Name" });
    expect(loadDraft()).toEqual({ workspaceName: "New Name" });
  });

  it("saves invites array", () => {
    const draft: SetupDraft = { invites: [{ email: "x@y.com", role: "ops" }] };
    saveDraft(draft);
    expect(loadDraft()).toEqual(draft);
  });
});

describe("clearDraft", () => {
  it("removes the key from sessionStorage", () => {
    sessionStorage.setItem(KEY, JSON.stringify({ workspaceName: "Acme" }));
    clearDraft();
    expect(sessionStorage.getItem(KEY)).toBeNull();
    expect(loadDraft()).toEqual({});
  });

  it("is a no-op when nothing is stored", () => {
    expect(() => clearDraft()).not.toThrow();
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });
});

describe("SSR safety (no window)", () => {
  const originalWindow = global.window;

  beforeEach(() => {
    // @ts-expect-error — simulate SSR
    delete global.window;
  });

  afterEach(() => {
    global.window = originalWindow;
  });

  it("loadDraft returns empty object without window", () => {
    expect(loadDraft()).toEqual({});
  });

  it("saveDraft does not throw without window", () => {
    expect(() => saveDraft({ workspaceName: "test" })).not.toThrow();
  });

  it("clearDraft does not throw without window", () => {
    expect(() => clearDraft()).not.toThrow();
  });
});

export {};
