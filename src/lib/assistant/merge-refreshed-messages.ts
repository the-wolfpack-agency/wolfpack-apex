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

  /* KEEP WHAT THE READER IS ALREADY READING.
   *
   * When a snapshot row and a local row share an id they are the same turn, and
   * the local copy is the one the send returned and the one on screen. Taking
   * the server's copy wholesale let post-processing rewrite an answer under the
   * reader: on 2026-08-19 a correct reply was silently replaced, seconds after
   * it arrived, by the stored version with a hedging note prepended. To the
   * user that is the answer disappearing.
   *
   * So an id match keeps the local content and widget, and takes only the
   * fields the server can know better. The server row still wins for any turn
   * the client never had. */
  return merged.map((m) => {
    if (m.role !== "assistant" || !m.id) return m;
    const local = prev.find((p) => p.id === m.id);
    if (!local) return m;
    /* CONTENT prefers the local copy: it is what the send returned and what is
       on screen, and the server's copy may carry post-processing the reader
       never asked for.
       WIDGET keeps the earlier rule, deliberately the other way round: a widget
       is derived data the server may hydrate better, so a snapshot widget wins
       and the local one only fills a gap. */
    return {
      ...m,
      ...(local.content ? { content: local.content } : {}),
      ...(m.widget ? {} : local.widget ? { widget: local.widget } : {}),
    };
  });
}
