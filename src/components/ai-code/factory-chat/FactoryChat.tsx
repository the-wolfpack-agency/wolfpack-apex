"use client";
/**
 * Factory Chat - the chat-centric Secure Agent surface. One neon conversation:
 * prompt chips seed it, the user's ask floats as a bubble, and the factory's
 * response is a bubble of WIDGETS - the live checkpoint track, the model + any
 * escalation, the human-in-the-loop consent + merge CTA, and the PR / preview /
 * deployed links. Every signal is real (see checkpoints.ts); nothing is simulated.
 *
 * Extraction-ready: all data access is via ./client against the existing endpoints.
 */
import { useCallback, useRef, useState } from "react";
import { NEON, neonGlow } from "./neon";
import ChatBubble from "./ChatBubble";
import CheckpointTrack from "./CheckpointTrack";
import DiffView from "./DiffView";
import PromptChips from "./PromptChips";
import GuidedIntake from "./GuidedIntake";
import FactoryLogo from "./FactoryLogo";
import { deriveCheckpoints, trackSummary } from "./checkpoints";
import { requestPipelineRun, approveHandoff, loadCi } from "./client";
import OpenPullRequests from "./OpenPullRequests";
import type { ChatTurn } from "./types";
import type { PromptChip } from "./chips";

/** CI poll cadence after a PR opens: fill the test dots live until CI is terminal. */
const CI_POLL_MS = 15_000;
const CI_POLL_MAX = 40; // ~10 min ceiling
const sleep = (ms: number) => new Promise<void>((r) => { setTimeout(r, ms); });

let turnSeq = 0;
const nextId = (): string => `turn-${++turnSeq}`;

export default function FactoryChat({ defaultRepo = "" }: { defaultRepo?: string }): React.ReactElement {
  const [input, setInput] = useState("");
  // Guided is the default intake (lead the user); freeform is the escape hatch.
  const [mode, setMode] = useState<"guided" | "freeform">("guided");
  const [intakeKey, setIntakeKey] = useState(0);
  const [repo, setRepo] = useState(defaultRepo);
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [busy, setBusy] = useState(false);
  const [consent, setConsent] = useState<Record<string, boolean>>({});
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  const patch = useCallback((id: string, up: Partial<ChatTurn>) => {
    setTurns((prev) => prev.map((t) => (t.id === id ? { ...t, ...up } : t)));
  }, []);

  const submit = useCallback(async (prompt: string) => {
    const text = prompt.trim();
    if (!text || busy) return;
    const id = nextId();
    setTurns((prev) => [...prev, { id, prompt: text, phase: "running" }]);
    setInput("");
    setBusy(true);
    try {
      const out = await requestPipelineRun({ prompt: text, repo });
      if (!out.ok) { patch(id, { phase: "error", error: out.error, result: out.result, model: out.model, notARequest: out.notARequest }); return; }
      const status = out.result.run?.status;
      patch(id, {
        phase: status === "ready_for_pr" ? "awaiting-human" : "gated",
        result: out.result,
        approvalId: out.approvalId,
        model: out.model,
      });
    } catch {
      patch(id, { phase: "error", error: "Network error - the factory did not respond." });
    } finally {
      setBusy(false);
    }
  }, [busy, repo, patch]);

  const merge = useCallback(async (turn: ChatTurn) => {
    const approvalId = turn.approvalId ?? turn.result?.approvalId;
    if (!approvalId) return;
    patch(turn.id, { phase: "running" });
    const out = await approveHandoff(approvalId);
    if (out.ok && out.prUrl) {
      patch(turn.id, { phase: "pr-open", prUrl: out.prUrl });
      // Poll the post-PR CI for the branch so the test checkpoints fill in LIVE,
      // in-chat - no link-out to GitHub Actions to watch the build. Bounded.
      if (out.branch && repo.trim()) {
        const repoFull = repo.trim();
        const branch = out.branch;
        for (let i = 0; i < CI_POLL_MAX; i++) {
          const ci = await loadCi(repoFull, branch);
          if (ci) patch(turn.id, { ci });
          if (!ci || ci.overall !== "pending") break; // terminal (or unavailable)
          await sleep(CI_POLL_MS);
        }
      }
    } else {
      patch(turn.id, { phase: "awaiting-human", error: out.validating ? "The repo's own gate is still validating - retry shortly." : out.error });
    }
  }, [patch, repo]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem", maxWidth: 820, margin: "0 auto", minHeight: "70vh", fontFamily: NEON.fontSans }}>
      <header style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "0.5rem" }}>
        <FactoryLogo height={44} />
        <div style={{ fontSize: "0.72rem", letterSpacing: "0.22em", textTransform: "uppercase", color: NEON.accent }}>
          Code Factory
        </div>
        <p style={{ color: NEON.textDim, fontSize: "0.82rem", margin: 0, textAlign: "center" }}>
          Describe the change. The factory writes it, proves it through the gate, and hands you a PR to approve.
        </p>
      </header>

      <OpenPullRequests repo={repo} />

      <div data-testid="chat-log" style={{ display: "flex", flexDirection: "column", gap: "0.9rem", flex: 1 }}>
        {turns.map((t) => (
          <div key={t.id} style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
            <ChatBubble role="user">{t.prompt}</ChatBubble>
            <ChatBubble role="factory">
              <FactoryResponse turn={t} consent={!!consent[t.id]} onConsent={(v) => setConsent((p) => ({ ...p, [t.id]: v }))} onMerge={() => void merge(t)} />
            </ChatBubble>
          </div>
        ))}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem", position: "sticky", bottom: 0, paddingTop: "0.5rem" }}>
        {mode === "guided" ? (
          <GuidedIntake
            key={intakeKey}
            onSubmit={(p) => { void submit(p); setIntakeKey((k) => k + 1); }}
            onFreeform={() => setMode("freeform")}
          />
        ) : (
        <>
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <button type="button" data-testid="to-guided" onClick={() => setMode("guided")} style={{ background: "transparent", border: "none", color: NEON.textDim, fontSize: "0.74rem", cursor: "pointer", textDecoration: "underline" }}>← guided</button>
        </div>
        <PromptChips onPick={(c: PromptChip) => { setInput(c.prompt); inputRef.current?.focus(); }} />
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "flex-end" }}>
          <textarea
            ref={inputRef}
            data-testid="composer"
            aria-label="Describe the change"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void submit(input); } }}
            placeholder="Describe the change, or pick a chip above. Cmd/Ctrl+Enter to send."
            rows={2}
            style={{ flex: 1, resize: "vertical", background: NEON.surface, border: `1px solid ${NEON.accentDim}`, borderRadius: 12, color: NEON.text, padding: "0.6rem 0.8rem", fontSize: "0.9rem", outline: "none" }}
          />
          <button
            type="button"
            data-testid="send"
            onClick={() => void submit(input)}
            disabled={busy || !input.trim()}
            style={{
              background: "transparent", border: `1px solid ${busy || !input.trim() ? NEON.pending : NEON.accent}`,
              color: busy || !input.trim() ? NEON.textDim : NEON.accent, borderRadius: 12, padding: "0.6rem 1.1rem",
              fontSize: "0.85rem", cursor: busy || !input.trim() ? "not-allowed" : "pointer",
              boxShadow: busy || !input.trim() ? "none" : neonGlow(NEON.accent),
            }}
          >
            {busy ? "Working…" : "Send"}
          </button>
        </div>
        </>
        )}
      </div>
    </div>
  );
}

function FactoryResponse({
  turn, consent, onConsent, onMerge,
}: { turn: ChatTurn; consent: boolean; onConsent: (v: boolean) => void; onMerge: () => void }): React.ReactElement {
  if (turn.phase === "running") {
    return <span data-testid="running" style={{ color: NEON.textDim }}>Generating and gating the change…</span>;
  }
  if (turn.phase === "error") {
    // A non-request (intent gate) is a gentle nudge, not a red error.
    if (turn.notARequest) {
      return <span data-testid="not-a-request" style={{ color: NEON.textDim }}>{turn.error ?? "That doesn't look like a change request."}</span>;
    }
    return <span data-testid="turn-error" style={{ color: NEON.blocked }}>{turn.error ?? "Something went wrong."}</span>;
  }

  const checkpoints = deriveCheckpoints(turn.result, turn.ci);
  const sum = trackSummary(checkpoints);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
      {/* Model + escalation badge - a capability on show, no trade secret. */}
      {turn.model && (
        <div data-testid="model-badge" style={{ display: "flex", gap: "0.5rem", alignItems: "center", fontSize: "0.72rem", color: NEON.textDim }}>
          <span style={{ color: NEON.accent }}>◇ {turn.model.name}</span>
          {turn.model.escalated && <span data-testid="escalated" style={{ color: NEON.held }}>↑ escalated to a superior agent</span>}
          <span>· {sum.clear}/{sum.total} checks cleared</span>
        </div>
      )}

      <CheckpointTrack checkpoints={checkpoints} />

      {/* Review the exact change in-chat - no link-out before consenting. */}
      {turn.result?.run?.diff ? <DiffView diff={turn.result.run.diff} /> : null}

      {/* Held: the gate did not clear an auto-handoff. */}
      {turn.phase === "gated" && (
        <div data-testid="held-notice" style={{ fontSize: "0.82rem", color: NEON.held }}>
          Held for a human. Nothing is handed off until the blocked checks are resolved.
        </div>
      )}

      {/* Human-in-the-loop: consent + merge CTA. */}
      {turn.phase === "awaiting-human" && (
        <div data-testid="consent-cta" style={{ display: "flex", flexDirection: "column", gap: "0.4rem", borderTop: `1px solid ${NEON.accentDim}`, paddingTop: "0.5rem" }}>
          <label style={{ display: "flex", gap: "0.5rem", alignItems: "center", fontSize: "0.82rem", color: NEON.text }}>
            <input type="checkbox" data-testid="consent" checked={consent} onChange={(e) => onConsent(e.target.checked)} />
            I reviewed the change and authorize opening a pull request.
          </label>
          <button
            type="button" data-testid="merge" disabled={!consent} onClick={onMerge}
            style={{ alignSelf: "flex-start", background: "transparent", border: `1px solid ${consent ? NEON.clear : NEON.pending}`, color: consent ? NEON.clear : NEON.textDim, borderRadius: 10, padding: "0.45rem 1rem", fontSize: "0.82rem", cursor: consent ? "pointer" : "not-allowed", boxShadow: consent ? neonGlow(NEON.clear) : "none" }}
          >
            Open the pull request
          </button>
          {turn.error && <span style={{ fontSize: "0.75rem", color: NEON.held }}>{turn.error}</span>}
        </div>
      )}

      {/* PR open: link + notification, then preview / deployed as they appear. */}
      {turn.phase === "pr-open" && (
        <div data-testid="pr-card" style={{ display: "flex", flexDirection: "column", gap: "0.3rem", borderTop: `1px solid ${NEON.clear}`, paddingTop: "0.5rem" }}>
          <span style={{ color: NEON.clear, fontSize: "0.85rem" }}>✓ Pull request opened</span>
          <a data-testid="pr-link" href={turn.prUrl} target="_blank" rel="noreferrer" style={{ color: NEON.accent, fontSize: "0.85rem", wordBreak: "break-all" }}>{turn.prUrl}</a>
          {turn.previewUrl && <a data-testid="preview-link" href={turn.previewUrl} target="_blank" rel="noreferrer" style={{ color: NEON.accent, fontSize: "0.8rem" }}>Preview: {turn.previewUrl}</a>}
          {turn.deployedUrl && <a data-testid="deployed-link" href={turn.deployedUrl} target="_blank" rel="noreferrer" style={{ color: NEON.clear, fontSize: "0.8rem" }}>Deployed: {turn.deployedUrl}</a>}
        </div>
      )}
    </div>
  );
}
