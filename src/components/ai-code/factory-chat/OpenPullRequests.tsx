"use client";
/**
 * OpenPullRequests - the in-tool approval surface. Lists the workspace's OPEN
 * factory PRs with their link, CI/gate/eligibility status, and an "Approve &
 * merge" action so a human merges from the tool. Governance is preserved: the
 * button is disabled unless CI is green (the server enforces the same floor), and
 * GitHub's branch protection still applies to the merge - a refusal (e.g. review
 * required) is surfaced inline, never silently swallowed.
 *
 * Self-contained (NEON tokens, the client seam) so it lifts into the standalone
 * Code Factory repo with the rest of the module.
 */
import { useCallback, useEffect, useState } from "react";
import { NEON } from "./neon";
import { loadOpenPulls, mergePull } from "./client";
import type { OpenPullStatus } from "./types";

function Badge({ label, color }: { label: string; color: string }): React.ReactElement {
  return (
    <span style={{ fontSize: "0.64rem", letterSpacing: "0.04em", textTransform: "uppercase", color, border: `1px solid ${color}`, borderRadius: 4, padding: "1px 6px", whiteSpace: "nowrap" }}>
      {label}
    </span>
  );
}

export default function OpenPullRequests({ repo }: { repo: string }): React.ReactElement | null {
  const [pulls, setPulls] = useState<OpenPullStatus[] | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [note, setNote] = useState<Record<number, string>>({});

  const refresh = useCallback(async () => {
    setPulls(await loadOpenPulls(repo));
  }, [repo]);

  useEffect(() => { void refresh(); }, [refresh]);

  const approve = useCallback(async (pr: OpenPullStatus) => {
    setBusy(pr.number);
    setNote((n) => ({ ...n, [pr.number]: "" }));
    const out = await mergePull(pr.repo, pr.number);
    if (out.ok) {
      setPulls((prev) => (prev ? prev.filter((p) => p.number !== pr.number) : prev));
    } else {
      setNote((n) => ({ ...n, [pr.number]: out.error ?? "Merge was refused." }));
    }
    setBusy(null);
  }, []);

  if (!pulls || pulls.length === 0) return null;

  return (
    <section data-testid="open-pulls" style={{ background: NEON.surface, border: `1px solid ${NEON.hairline}`, borderRadius: 12, padding: "0.9rem 1rem", display: "flex", flexDirection: "column", gap: "0.7rem" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: "0.72rem", letterSpacing: "0.18em", textTransform: "uppercase", color: NEON.accent }}>
          Open PRs awaiting approval ({pulls.length})
        </span>
        <button type="button" data-testid="refresh-pulls" onClick={() => void refresh()} style={{ background: "transparent", border: "none", color: NEON.textDim, fontSize: "0.72rem", cursor: "pointer", textDecoration: "underline" }}>
          refresh
        </button>
      </div>

      {pulls.map((pr) => {
        const canMerge = pr.ciGreen && pr.ciReadable;
        return (
          <div key={pr.number} data-testid={`pull-${pr.number}`} style={{ display: "flex", flexDirection: "column", gap: "0.45rem", paddingTop: "0.6rem", borderTop: `1px solid ${NEON.hairline}` }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: "0.75rem", alignItems: "baseline" }}>
              <a href={pr.url} target="_blank" rel="noopener noreferrer" style={{ color: NEON.text, fontSize: "0.9rem", fontWeight: 600, textDecoration: "none" }}>
                #{pr.number} {pr.title}
              </a>
              <span style={{ color: NEON.textDim, fontSize: "0.68rem", whiteSpace: "nowrap" }}>{pr.fileCount} file{pr.fileCount === 1 ? "" : "s"}</span>
            </div>

            <div style={{ display: "flex", flexWrap: "wrap", gap: "0.35rem" }}>
              <Badge label={pr.ciReadable ? (pr.ciGreen ? "CI green" : "CI not green") : "CI unknown"} color={pr.ciGreen ? NEON.clear : NEON.blocked} />
              <Badge label={`gate ${pr.gateOutcome}`} color={pr.gateOutcome === "allow" ? NEON.clear : pr.gateOutcome === "block" ? NEON.blocked : NEON.textDim} />
              {pr.hasTests ? <Badge label="tests" color={NEON.clear} /> : <Badge label="no tests" color={NEON.textDim} />}
              {pr.touchesSensitiveSurface ? <Badge label="sensitive" color={NEON.blocked} /> : null}
              <Badge label={pr.eligible ? "auto-eligible" : "needs human"} color={pr.eligible ? NEON.clear : NEON.accent} />
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
              <button
                type="button"
                data-testid={`approve-${pr.number}`}
                disabled={!canMerge || busy === pr.number}
                onClick={() => void approve(pr)}
                title={canMerge ? "Merge this PR from the tool" : "CI must be green before a merge"}
                style={{
                  background: canMerge ? NEON.accent : "transparent",
                  color: canMerge ? NEON.accentInk : NEON.textDim,
                  border: `1px solid ${canMerge ? NEON.accent : NEON.hairline}`,
                  borderRadius: 6, padding: "0.35rem 0.8rem", fontSize: "0.78rem",
                  cursor: canMerge && busy !== pr.number ? "pointer" : "not-allowed",
                  opacity: busy === pr.number ? 0.6 : 1,
                }}
              >
                {busy === pr.number ? "Merging..." : "Approve & merge"}
              </button>
              {note[pr.number] ? <span data-testid={`note-${pr.number}`} style={{ color: NEON.blocked, fontSize: "0.72rem" }}>{note[pr.number]}</span> : null}
            </div>
          </div>
        );
      })}
    </section>
  );
}
