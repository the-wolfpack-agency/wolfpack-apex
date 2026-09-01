/**
 * Version drift.
 *
 * The failure being guarded is a silent weights change: the answers get worse,
 * somebody asks what changed, and nothing in the system can say. So the
 * assertions are about noticing the change EXACTLY, without becoming an alarm
 * that everybody learns to ignore.
 */
import {
  observeVersion,
  normalizeVersion,
  isMaterial,
  quarantineIsStale,
  type KnownVersion,
} from "../version-drift";

const known = (v: string, calls = 100): KnownVersion => ({
  servedVersion: v,
  lastSeenAt: "2026-08-01T00:00:00Z",
  callCount: calls,
});

describe("normalizeVersion", () => {
  it("trims and lowercases", () => {
    expect(normalizeVersion("  GPT-4o-2024-11-20 ")).toBe("gpt-4o-2024-11-20");
  });

  it("does NOT strip the date suffix", () => {
    /* The tempting simplification, and it would blind this module to the exact
       change it exists to catch. */
    expect(normalizeVersion("gpt-4o-2024-11-20")).not.toBe("gpt-4o");
  });

  it("treats absent as empty rather than throwing", () => {
    expect(normalizeVersion(null)).toBe("");
    expect(normalizeVersion(undefined)).toBe("");
  });
});

describe("observeVersion", () => {
  it("is quiet when nothing changed", () => {
    const o = observeVersion({
      modelId: "gpt-4o",
      servedVersion: "gpt-4o-2024-11-20",
      known: [known("gpt-4o-2024-11-20")],
    });
    expect(o.kind).toBe("unchanged");
    expect(isMaterial(o)).toBe(false);
  });

  it("calls the first sighting a beginning, not a change", () => {
    /* Every model produces one of these on its first call ever. Reporting it
       as a change would fill the record with events on the day this ships. */
    const o = observeVersion({ modelId: "gpt-4o", servedVersion: "gpt-4o-2024-11-20", known: [] });
    expect(o.kind).toBe("first_sighting");
    expect(o.previousVersion).toBeNull();
    expect(isMaterial(o)).toBe(false);
  });

  it("catches a silent weights change under the same name", () => {
    // THE EVENT THIS MODULE EXISTS FOR.
    const o = observeVersion({
      modelId: "gpt-4o",
      servedVersion: "gpt-4o-2025-06-01",
      known: [known("gpt-4o-2024-11-20", 12_000)],
    });
    expect(o.kind).toBe("changed");
    expect(o.previousVersion).toBe("gpt-4o-2024-11-20");
    // How much work was built on the old weights is what makes it worth reading.
    expect(o.previousCallCount).toBe(12_000);
    expect(isMaterial(o)).toBe(true);
  });

  it("tells a rollback apart from a new version", () => {
    /* Different news: a provider rolling back often means a regression somebody
       else already noticed has been undone. */
    const o = observeVersion({
      modelId: "gpt-4o",
      servedVersion: "gpt-4o-2024-11-20",
      known: [known("gpt-4o-2025-06-01", 40), known("gpt-4o-2024-11-20", 12_000)],
    });
    expect(o.kind).toBe("reverted");
    expect(isMaterial(o)).toBe(true);
  });

  it("compares against what is serving NOW, not against everything ever seen", () => {
    // known is most-recent-first, so the head is the incumbent.
    const o = observeVersion({
      modelId: "gpt-4o",
      servedVersion: "gpt-4o-2025-06-01",
      known: [known("gpt-4o-2025-06-01"), known("gpt-4o-2024-11-20")],
    });
    expect(o.kind).toBe("unchanged");
  });

  it("ignores case and whitespace differences from a provider", () => {
    const o = observeVersion({
      modelId: "gpt-4o",
      servedVersion: " GPT-4O-2024-11-20 ",
      known: [known("gpt-4o-2024-11-20")],
    });
    expect(o.kind).toBe("unchanged");
  });
});

describe("quarantineIsStale", () => {
  it("says a quarantine is stale once different weights are serving", () => {
    /* A model quarantined for regressing was quarantined for what its weights
       did. When the provider ships new ones, continuing to refuse is punishing
       a name. */
    expect(
      quarantineIsStale({
        quarantinedVersion: "gpt-4o-2024-11-20",
        servingVersion: "gpt-4o-2025-06-01",
      }),
    ).toBe(true);
  });

  it("holds the quarantine while the same weights are serving", () => {
    expect(
      quarantineIsStale({
        quarantinedVersion: "gpt-4o-2024-11-20",
        servingVersion: "gpt-4o-2024-11-20",
      }),
    ).toBe(false);
  });

  it("says nothing about a quarantine that never named a version", () => {
    /* An older decision with no version recorded cannot be shown to be stale,
       and guessing would silently reopen a model somebody stopped on purpose. */
    expect(quarantineIsStale({ quarantinedVersion: null, servingVersion: "anything" })).toBe(false);
  });
});
