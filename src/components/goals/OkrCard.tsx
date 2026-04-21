"use client";

/**
 * OkrCard — one OKR with a KR list and an embedded contribution stream
 * per KR. Expandable: default-collapsed to show just the objective +
 * overall KR progress; click to open the contribution streams.
 */

import { useState } from "react";
import KrProgress from "./KrProgress";
import ContributionStream from "./ContributionStream";
import AddKrForm from "./AddKrForm";
import UpdateKrProgressForm from "./UpdateKrProgressForm";
import ArchiveOkrButton from "./ArchiveOkrButton";
import EditOkrButton from "./EditOkrButton";
import { krList, type OkrView, type ContributionView } from "./types";

export interface OkrCardProps {
  okr: OkrView;
  /** kr_id → last-7-days contributions (already filtered by caller). */
  streams: Record<string, ContributionView[]>;
  userNames?: Record<string, string>;
  onCommit?: (kr_id: string) => void;
  defaultOpen?: boolean;
  /** Called after a KR is successfully appended / progress updated. */
  onKrAdded?: () => void;
  /** Called after an admin archives this OKR. */
  onArchived?: () => void;
  /** Current user role — used by the admin-only archive control. */
  userRole?: string | null;
}

export default function OkrCard({
  okr,
  streams,
  userNames,
  onCommit,
  defaultOpen,
  onKrAdded,
  onArchived,
  userRole = null,
}: OkrCardProps) {
  const [open, setOpen] = useState(Boolean(defaultOpen));
  const krs = krList(okr);

  return (
    <div
      data-testid={`okr-${okr.id}`}
      className="rounded-lg border p-4"
      style={{
        background: "var(--wp-dark-surface)",
        borderColor: "var(--wp-dark-border)",
      }}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <div
            className="text-[10px] uppercase tracking-wide"
            style={{ color: "var(--wp-text-muted)" }}
          >
            {okr.quarter}
          </div>
          <h3
            className="text-base font-semibold mt-0.5"
            style={{ color: "var(--wp-gold)" }}
          >
            {okr.objective}
          </h3>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <EditOkrButton
            okrId={okr.id}
            currentObjective={okr.objective}
            currentQuarter={okr.quarter}
            userRole={userRole}
            onSaved={onArchived ?? (() => {})}
          />
          <ArchiveOkrButton
            okrId={okr.id}
            userRole={userRole}
            onArchived={onArchived ?? (() => {})}
          />
          <button
            onClick={() => setOpen((o) => !o)}
            className="text-xs px-2 py-1 rounded"
            style={{
              background: "var(--wp-dark-surface2)",
              color: "var(--wp-text-dim)",
            }}
            aria-expanded={open}
            aria-controls={`okr-${okr.id}-body`}
          >
            {open ? "Collapse" : "Expand"}
          </button>
        </div>
      </div>

      <div id={`okr-${okr.id}-body`} className="mt-3 space-y-4">
        {krs.map((kr) => (
          <div key={kr.id} className="space-y-2">
            <KrProgress
              id={kr.id}
              metric={kr.metric}
              current_value={kr.current_value}
              target_value={kr.target_value}
              unit={kr.unit}
            />
            <UpdateKrProgressForm
              krId={kr.id}
              currentValue={kr.current_value}
              targetValue={kr.target_value}
              unit={kr.unit}
              onUpdated={onKrAdded ?? (() => {})}
            />
            {open && (
              <>
                <ContributionStream
                  kr_id={kr.id}
                  contributions={streams[kr.id] ?? []}
                  userNames={userNames}
                />
                {onCommit && (
                  <button
                    onClick={() => onCommit(kr.id)}
                    className="text-xs px-2 py-1 rounded"
                    style={{
                      background: "var(--wp-gold)20",
                      color: "var(--wp-gold)",
                    }}
                  >
                    Log commitment
                  </button>
                )}
              </>
            )}
          </div>
        ))}
        {krs.length === 0 && (
          <p
            className="text-xs"
            style={{ color: "var(--wp-text-muted)" }}
          >
            This OKR has no key results yet.
          </p>
        )}
        {/* Any teammate can supplement the OKR with a new KR. */}
        <div className="pt-2">
          <AddKrForm okrId={okr.id} onAdded={onKrAdded ?? (() => {})} />
        </div>
      </div>
    </div>
  );
}
