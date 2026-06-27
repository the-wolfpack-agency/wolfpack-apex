/**
 * Merge a silently-refreshed server snapshot of a conversation's messages
 * into the locally-held view, without dropping a turn that is shown locally
 * but not yet in the snapshot.
 *
 * Why this exists: the chat surface adds an assistant reply optimistically
 * with the server-issued messageId, then a background refresh (poll or
 * cross-tab broadcast) re-fetches the conversation. If that refresh races
 * the server's assistant-message save, the snapshot can contain the user
 * row but not the assistant row. An earlier merge preserved only no-id
 * optimistic rows, so an id-bearing assistant reply absent from the snapshot
 * was silently dropped: the reply appeared and then vanished a few seconds
 * later. This merge keeps any local row the snapshot does not represent,
 * matched by id OR by role+content (so an id-mismatched persist still dedupes).
 */
export interface MergeableMessage {
  id?: string;
  role: string;
  content: string;
  widget?: unknown;
}

export function mergeRefreshedMessages<T extends MergeableMessage>(
  prev: T[],
  remote: T[],
): T[] {
  const remoteIds = new Set(remote.filter((m) => m.id).map((m) => m.id as string));

  // Local rows the snapshot does not yet represent. A row is "represented"
  // when its id is in the snapshot OR a snapshot row shares its role+content.
  const localMissing = prev.filter((m) => {
    if (m.id && remoteIds.has(m.id)) return false;
    if (remote.some((r) => r.role === m.role && r.content === m.content)) return false;
    return true;
  });

  // Server rows first (chronological from the server), then any local row
  // still missing from the snapshot (the in-flight or not-yet-persisted turn).
  const merged: T[] = [...remote, ...localMissing];

  // Preserve a locally-set widget on an identified assistant row when the
  // snapshot would otherwise drop it (widgets are derived client-side and
  // may not be hydrated on every snapshot path).
  return merged.map((m) => {
    if (m.role !== "assistant" || !m.id || m.widget) return m;
    const local = prev.find((p) => p.id === m.id);
    if (local?.widget) return { ...m, widget: local.widget };
    return m;
  });
}
