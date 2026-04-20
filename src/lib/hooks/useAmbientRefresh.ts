"use client";

/**
 * useAmbientRefresh — React hook that mounts once per dashboard session
 * and runs U6's ambient refresh orchestrator.
 *
 * On mount:
 *   - Kicks off `runSessionWarmPass()` when `navigator.onLine` — silent
 *     re-touch of the top-N most-recent cached RAG queries per scope.
 *   - Starts `startIdleRefresh()` — idle-based stale refresh watcher.
 *   - Subscribes to the `online` event so a mid-session reconnect
 *     triggers a fresh warm pass.
 *
 * On unmount:
 *   - Aborts any in-flight warm pass via AbortController.
 *   - Stops the idle watcher (clears timers, removes listeners).
 *   - Removes the `online` listener.
 *
 * Silent by design — this hook never returns UI state. The whole point
 * of ambient refresh is that the user never knows it's happening.
 *
 * Mount ONCE per dashboard session (in the (dashboard) route-group
 * layout). Mounting in multiple places would double the warm-pass
 * traffic and burn tokens/bandwidth for no user benefit.
 */

import { useEffect } from "react";
import {
  runSessionWarmPass,
  startIdleRefresh,
  type IdleRefreshHandle,
} from "@/lib/ambient-refresh";

export function useAmbientRefresh(): void {
  useEffect(() => {
    if (typeof window === "undefined") return;

    const controller = new AbortController();
    let idleHandle: IdleRefreshHandle | null = null;

    // Kick off the initial warm pass if we're online. Never awaited in
    // the effect body — the effect returns its cleanup synchronously
    // and the pass runs in the background.
    function triggerWarmPass() {
      if (!navigator.onLine) return;
      // Swallow errors — `runSessionWarmPass` never rejects, but this
      // is defense-in-depth so the promise return never floats to a
      // React-unhandled-rejection warning.
      void runSessionWarmPass({ signal: controller.signal }).catch(() => {
        /* silent */
      });
    }

    triggerWarmPass();

    // Start idle refresh. Returns a handle we retain for cleanup. When
    // the AbortSignal fires, startIdleRefresh will call handle.stop()
    // internally, so the explicit stop() below is belt-and-braces.
    idleHandle = startIdleRefresh({ signal: controller.signal });

    // Mid-session reconnect: fresh warm pass. One pass per online event
    // — `runSessionWarmPass`'s internal rate-limiter + the module-level
    // refresh mutex keep this cheap.
    function onOnline() {
      triggerWarmPass();
    }
    window.addEventListener("online", onOnline);

    return () => {
      window.removeEventListener("online", onOnline);
      controller.abort();
      idleHandle?.stop();
    };
  }, []);
}
