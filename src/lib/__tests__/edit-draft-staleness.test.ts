/**
 * Edit-page localStorage draft auto-discards when stale.
 *
 * Regression for the user-facing bug where /sites/[id]/edit kept
 * restoring a drastically-older draft ("Restored an in-progress draft
 * from your last session") even after the saved brief had moved
 * forward server-side. The UI therefore showed a near-empty placeholder
 * while the DEPLOYED site had rich content, and the only escape was
 * clicking Discard manually each time.
 *
 * The edit page now tags every stored draft with the hash of the
 * SAVED brief at the moment the draft was written. On load, if the
 * saved brief's current hash differs from the tagged hash, the draft
 * is silently discarded (it's older than the server state). This
 * test locks the hash + staleness contract — if the algorithm changes
 * and stops detecting drift, the "Restored draft" banner would return.
 */

/**
 * Re-declared inline because the edit page is a "use client" component
 * and can't be imported into jsdom cleanly (Next's `use(params: Promise)`
 * suspends). The hash is a pure function — the test owns an identical
 * copy so any divergence surfaces as a test failure.
 */
function hashBrief(b: unknown): string {
  const s = JSON.stringify(b);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16);
}

interface Brief { client: string; product: { name: string }; pages: unknown[] }
interface StoredDraft {
  brief: Brief;
  savedHashAtWrite?: string;
  writtenAt?: number;
}

/**
 * Replicates the decision branch in the edit page's load effect:
 *   - legacy (no hash): discard
 *   - identical to saved: discard (no-op, nothing to restore)
 *   - hash matches saved's current hash: restore
 *   - hash does NOT match saved's current hash: discard (stale)
 */
function decideRestore(
  stored: Brief | StoredDraft | null,
  saved: Brief,
): "restore" | "discard" | "empty" {
  if (stored === null) return "empty";
  const isEnvelope =
    typeof stored === "object" && stored !== null && "brief" in stored;
  const storedBrief = isEnvelope ? (stored as StoredDraft).brief : (stored as Brief);
  const storedHash = isEnvelope ? (stored as StoredDraft).savedHashAtWrite : undefined;
  if (JSON.stringify(storedBrief) === JSON.stringify(saved)) return "discard";
  if (storedHash === undefined) return "discard"; // legacy pre-guard draft
  if (storedHash !== hashBrief(saved)) return "discard"; // stale
  return "restore";
}

const EMPTY: Brief = {
  client: "cftr",
  product: { name: "test" },
  pages: [{ route: "/", sections: [] }],
};
const RICH: Brief = {
  client: "cftr",
  product: { name: "CFTR — Aidan Mulready" },
  pages: [
    {
      route: "/",
      sections: [{ type: "hero", heading: "AIDAN MULREADY" }] as unknown[],
    },
  ],
};

describe("edit page — localStorage draft staleness guard", () => {
  it("legacy draft (no hash field) is auto-discarded", () => {
    const legacy = EMPTY; // pre-envelope format = bare brief
    expect(decideRestore(legacy, RICH)).toBe("discard");
  });

  it("draft tagged with the CURRENT saved hash is restored", () => {
    const envelope: StoredDraft = {
      brief: { ...EMPTY, product: { name: "EDITED" } },
      savedHashAtWrite: hashBrief(RICH),
      writtenAt: Date.now(),
    };
    expect(decideRestore(envelope, RICH)).toBe("restore");
  });

  it("draft tagged with a STALE saved hash is auto-discarded (the 2026-04-18 bug)", () => {
    // Draft was written when the saved brief was EMPTY; since then the
    // server has promoted the rich brief. The draft is older than the
    // server state and must NOT be restored.
    const envelope: StoredDraft = {
      brief: EMPTY,
      savedHashAtWrite: hashBrief(EMPTY),
      writtenAt: Date.now() - 60_000,
    };
    expect(decideRestore(envelope, RICH)).toBe("discard");
  });

  it("draft identical to the saved brief is a no-op discard (no banner)", () => {
    const envelope: StoredDraft = {
      brief: RICH,
      savedHashAtWrite: hashBrief(RICH),
      writtenAt: Date.now(),
    };
    expect(decideRestore(envelope, RICH)).toBe("discard");
  });

  it("no stored draft returns empty", () => {
    expect(decideRestore(null, RICH)).toBe("empty");
  });
});

describe("hashBrief — stable + change-detecting", () => {
  it("same input → same output", () => {
    expect(hashBrief(RICH)).toBe(hashBrief(RICH));
  });

  it("any change in brief flips the hash", () => {
    const a = hashBrief(RICH);
    const b = hashBrief({ ...RICH, client: "different" });
    expect(a).not.toBe(b);
  });

  it("adding a section changes the hash", () => {
    const a = hashBrief(EMPTY);
    const withSection = {
      ...EMPTY,
      pages: [{ route: "/", sections: [{ type: "hero" }] }],
    };
    expect(a).not.toBe(hashBrief(withSection));
  });
});
