# Instinct offline pattern — templatized

Stream U4 (2026-04-19) generalized the site-editor offline primitives
into a reusable pattern. Any feature that lives inside the authenticated
dashboard can now adopt offline support by calling two hooks and a tiny
imperative save helper. No new runtime dependencies.

---

## Table of contents

1. [When to use it](#when-to-use-it)
2. [When NOT to use it](#when-not-to-use-it)
3. [Architecture at a glance](#architecture-at-a-glance)
4. [API reference](#api-reference)
5. [Worked example — meeting drafts](#worked-example--meeting-drafts)
6. [Analytics — slicing by `resource_type`](#analytics--slicing-by-resource_type)
7. [Testing checklist](#testing-checklist)

---

## When to use it

- **Mutations that tolerate eventual consistency.** Draft saves, notes,
  annotations, comment composition, HR doc uploads-in-progress,
  discussion drafts, knowledge capture notes, journal entries.
- **Reads that should survive a refresh offline.** Cached copy of an
  object the user was just looking at, so a cold-load on the subway
  renders the last-known good state instead of a blank screen.
- **Any feature where user-perceived latency dominates correctness
  latency.** If the user sees "saved" and the server catches up later,
  that's a better UX than blocking the UI on the request.

## When NOT to use it

- **Financial transactions.** Anything that moves money, writes an
  audit-critical row, or triggers irreversible side effects (sending
  an email, running a workflow). These must be synchronous.
- **Auth.** Login, MFA, refresh. Never queue credentials.
- **Real-time collaboration.** Live presence, co-editing cursors, and
  anything that relies on conflict-free replicated state must round-trip
  to a real sync service (not this queue).
- **Large binary payloads.** IndexedDB is not a CDN; do not stash
  multi-MB video transcripts here.

---

## Architecture at a glance

```
┌──────────────────────────────────────────────────────────────┐
│                    feature code (React)                      │
│   useOfflineCache(type, id, fetcher)   useOfflineQueue(...)  │
└──────────────────────────┬───────────────────────────────────┘
                           │
              ┌────────────┴────────────┐
              ▼                         ▼
   ┌─────────────────────┐    ┌──────────────────────┐
   │  offline-cache.ts   │    │  offline-queue.ts    │
   │  IDB: resource_cache│    │  IDB: mutation_queue │
   │  composite keyPath  │    │  FIFO + backoff      │
   └─────────────────────┘    └──────────────────────┘
              │                         │
              ▼                         ▼
        analytics ──────────────► OfflineStatusPill
```

Two IndexedDB databases are involved:
- `instinct-offline` — the mutation queue + the legacy `brief_cache`
  store (both owned by `offline-queue.ts`).
- `instinct-resource-cache` — the new, resource-agnostic store
  (`offline-cache.ts`). Separated so its schema can evolve without
  racing the queue's `onupgradeneeded`.

The service worker (`public/sw.js`) and `OfflineStatusPill` are
unchanged — features get "flush on reconnect" and visible offline
status for free when they mount inside the dashboard layout.

---

## API reference

### `src/lib/offline-cache.ts`

```ts
export interface ResourceCacheEntry<T> {
  resource_type: string;
  resource_id: string;
  data: T;
  fetched_at: number;
}

export async function cacheResource<T>(
  resource_type: string,
  resource_id: string,
  data: T,
): Promise<void>;

export async function readCachedResource<T>(
  resource_type: string,
  resource_id: string,
  opts?: { silent?: boolean; onAnalytics?: ... },
): Promise<ResourceCacheEntry<T> | null>;

export async function clearResource(type: string, id: string): Promise<void>;
export async function listCachedResources(type: string): Promise<ResourceCacheEntry<unknown>[]>;
```

### `src/lib/hooks/useOfflineQueue.ts`

```ts
function useOfflineQueue<B>(
  endpoint: string,
  method: "POST" | "PATCH" | "PUT" | "DELETE",
  options?: {
    replay?: (body: B) => Promise<Response>;
    resourceType?: string;   // stamped as X-Instinct-Resource-Type
    headers?: Record<string, string>;
  },
): {
  enqueue: (body: B) => Promise<string>;   // queued id
  pendingCount: number;                     // reactive
  isFlushing: boolean;                      // reactive
  flush: () => Promise<void>;               // manual trigger
};
```

- Auto-flushes on the `online` event.
- Emits `offline.mutation_queued` / `_replayed` / `_replay_failed`
  through the underlying queue module.

### `src/lib/hooks/useOfflineCache.ts`

```ts
function useOfflineCache<T>(
  resource_type: string,
  resource_id: string,
  fetcher: () => Promise<T>,
): {
  data: T | null;
  isLoading: boolean;
  isStale: boolean;          // true if served from cache
  cacheAgeMs: number | null;
  refetch: () => Promise<void>;
};
```

Behavior:
- On mount → attempt `fetcher()`. Success → cache + `isStale=false`.
  Failure → read cache + `isStale=true`. No cache on failure → `data=null`.
- On `online` event → if currently stale, auto-refetch.

---

## Worked example — meeting drafts

`src/lib/meetings-offline.ts` applies the pattern to
`apex_meeting_transcripts` drafts. It is the template that
`hr-documents-offline.ts`, `journal-offline.ts`, `discussions-offline.ts`,
and `knowledge-offline.ts` should mirror.

```ts
// src/lib/meetings-offline.ts (excerpt)
export const MEETING_DRAFT_RESOURCE = "meeting_draft";
export const MEETING_DRAFT_ENDPOINT = "/api/meetings/draft";

export async function saveMeetingDraftOffline(draft: MeetingDraft) {
  await cacheResource(MEETING_DRAFT_RESOURCE, draft.draft_id, draft);

  const online = typeof navigator === "undefined" ? true : navigator.onLine;

  if (online) {
    try {
      const res = await fetchWithRefresh(MEETING_DRAFT_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      if (res.ok) return { queueId: null, syncedInline: true };
    } catch {
      /* fall through to queue */
    }
  }

  const entry = await enqueueMutation({
    endpoint: MEETING_DRAFT_ENDPOINT,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Instinct-Resource-Type": MEETING_DRAFT_RESOURCE,
    },
    body: draft,
  });
  notifyQueueChanged();
  return { queueId: entry.id, syncedInline: false };
}

export async function loadMeetingDraft(draftId: string) {
  const rec = await readCachedResource<MeetingDraft>(
    MEETING_DRAFT_RESOURCE,
    draftId,
  );
  return rec?.data ?? null;
}
```

In a React component:

```tsx
function MeetingDraftEditor({ draftId }: { draftId: string }) {
  const { data, isLoading, isStale, cacheAgeMs } = useOfflineCache(
    "meeting_draft",
    draftId,
    () => fetchWithRefresh(`/api/meetings?id=${draftId}`).then((r) => r.json()),
  );

  if (isLoading) return <Spinner />;
  return (
    <>
      {isStale ? (
        <StaleBanner ageMs={cacheAgeMs ?? 0} />
      ) : null}
      <Form
        initial={data}
        onSave={(draft) => saveMeetingDraftOffline(draft)}
      />
    </>
  );
}
```

The `OfflineStatusPill` component — already globally mounted — picks up
the queued mutation via the shared `instinct-offline-queue-changed`
custom event and shows the user that edits are pending. No extra wiring
required.

---

## Analytics — slicing by `resource_type`

Every `offline.*` event now carries a `resource_type` dimension. The
analytics dashboard can therefore answer questions like:

- "Which feature area has the highest offline usage?" → group by
  `resource_type` on `offline.mutation_queued`.
- "Are designers benefiting from the offline cache?" → filter
  `offline.resource_served_from_cache` where `resource_type = 'brief'`.
- "Is the HR module's replay reliable?" → compute success rate of
  `offline.mutation_replayed` ÷ (`_replayed` + `_replay_failed`) filtered
  to `resource_type = 'hr_doc_pending'`.

Events:

| event | metadata |
| --- | --- |
| `offline.mutation_queued` | `{ resource_type, endpoint, method }` |
| `offline.mutation_replayed` | `{ resource_type, endpoint, success }` |
| `offline.mutation_replay_failed` | `{ resource_type, endpoint, error, attempt }` |
| `offline.resource_served_from_cache` | `{ resource_type, resource_id, cache_age_ms }` |
| `offline.brief_served_from_cache` | `{ site_id, cache_age_ms }` — legacy, still fires for `resource_type='brief'` |
| `offline.returned_online` | `{ queue_size }` |
| `offline.detected` | `{}` |

`resource_type` values currently in use:
- `"brief"` — site editor
- `"meeting_draft"` — worked example (this doc)

Reserve additional values as you add offline support: `"hr_doc_pending"`,
`"journal_entry"`, `"discussion_draft"`, `"knowledge_note"`.

---

## Testing checklist

Every feature that adopts this pattern must ship with:

- [ ] **Unit tests** for the `save*Offline` / `load*` helpers, using
  `fake-indexeddb/auto`. Assert both `navigator.onLine === true` and
  `=== false` branches.
- [ ] **Hook tests** rendering in jsdom, toggling online state, and
  asserting `pendingCount` + `isStale` behavior.
- [ ] **E2E** (Playwright) that goes offline with dev-tools, performs
  the feature's core action, goes online, asserts the server state
  reflects the offline change.
- [ ] Regression: `npx jest src/lib/__tests__/offline-*` remains green.

Happy templating.
