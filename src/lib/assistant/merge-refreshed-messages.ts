/**
 * Merge a silently-refreshed server snapshot of a conversation's messages
 * into the locally-held view, without dropping a turn that is shown locally
 * but not yet in the snapshot.
 *
 * Why this exists: the chat surface adds an assistant reply optimiztically
 * with the server-issued messageId, then a background refresh (poll or
 * cross-tab broadcast) re-fetches the conversation. If that refresh races
 * the server's assistant-message save, the snapshot can contain the user
 * row but not the assistant row. An earlier merge preserved only no-id
 * optimiztic rows, so an id-bearing assistant reply absent from the snapshot
 * was silently dropped: the reply appeared and then vanished a few seconds
 * later. This merge keeps any local row the snapshot does not represent,
 * matched by id OR by role+content (so an id-mismatched persist still dedupes).
 */
export interface MergeableMessage {
  id?: string;
  role: string;
  content: string;
  widget?: unknown;
  /* Which model answered. Live-only: the send returns it, the stored row does
     not carry it, so a snapshot taken seconds later has nothing to put here. */
  model?: string;
  provider?: string;
  tierRequested?: string;
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
    /* MODEL ATTRIBUTION IS LIVE-ONLY, so the snapshot cannot supply it.
       Reported 2026-08-19: "the model name displayed for a bit then
       disappeared". Same mechanism as the answers that vanished, one field
       along: the send returns which model produced the reply, nothing stores
       it, and the background refresh then replaced the local row with a server
       row that had no such field. The badge blinked out a few seconds after
       arriving.

       So it is carried over on an id match, exactly like content. A local
       value only ever fills a gap here: if the server ever does start
       returning one, the server's wins, which is the right precedence for the
       day the field becomes persisted. */
    return {
      ...m,
      ...(local.content ? { content: local.content } : {}),
      ...(m.widget ? {} : local.widget ? { widget: local.widget } : {}),
      ...(m.model ? {} : local.model ? { model: local.model } : {}),
      ...(m.provider ? {} : local.provider ? { provider: local.provider } : {}),
      ...(m.tierRequested
        ? {}
        : local.tierRequested
          ? { tierRequested: local.tierRequested }
          : {}),
    };
  });
}
