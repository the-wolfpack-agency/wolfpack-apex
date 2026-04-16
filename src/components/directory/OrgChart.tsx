"use client";

/**
 * OrgChart — expandable tree of manager → direct reports from a given root
 * user. Lazy-loads each level on click (click the chevron to expand). Depth
 * is clamped to 5 to stop the UI from exploding on pathological org graphs.
 */

import { useCallback, useEffect, useState } from "react";
import { authHeaders } from "@/lib/client-auth";
import type { DirectoryUserView } from "@/components/directory/UserCard";

export interface OrgChartProps {
  rootMsUserId: string;
  maxDepth?: number;
}

interface NodeState {
  user: DirectoryUserView | null;
  loaded: boolean;
  expanded: boolean;
  reports: DirectoryUserView[] | null;
  loadingReports: boolean;
}

function emptyNode(): NodeState {
  return { user: null, loaded: false, expanded: false, reports: null, loadingReports: false };
}

export default function OrgChart({ rootMsUserId, maxDepth = 5 }: OrgChartProps) {
  const clamped = Math.min(Math.max(1, maxDepth), 5);
  const [tree, setTree] = useState<Record<string, NodeState>>({
    [rootMsUserId]: emptyNode(),
  });

  const ensureLoaded = useCallback(
    async (msUserId: string) => {
      setTree((prev) => {
        if (prev[msUserId]?.loaded || prev[msUserId]?.user) return prev;
        return { ...prev, [msUserId]: { ...emptyNode(), ...prev[msUserId] } };
      });
      try {
        const res = await fetch(
          `/api/directory/users/${encodeURIComponent(msUserId)}`,
          { headers: authHeaders() },
        );
        if (!res.ok) {
          setTree((prev) => ({
            ...prev,
            [msUserId]: { ...(prev[msUserId] ?? emptyNode()), loaded: true },
          }));
          return;
        }
        const body = (await res.json()) as { user?: DirectoryUserView };
        setTree((prev) => ({
          ...prev,
          [msUserId]: {
            ...(prev[msUserId] ?? emptyNode()),
            user: body.user ?? null,
            loaded: true,
          },
        }));
      } catch {
        setTree((prev) => ({
          ...prev,
          [msUserId]: { ...(prev[msUserId] ?? emptyNode()), loaded: true },
        }));
      }
    },
    [],
  );

  useEffect(() => {
    ensureLoaded(rootMsUserId);
  }, [rootMsUserId, ensureLoaded]);

  const toggleReports = useCallback(
    async (msUserId: string, depth: number) => {
      if (depth >= clamped) return;
      const current = tree[msUserId];
      if (!current) return;
      // Collapse
      if (current.expanded) {
        setTree((prev) => ({
          ...prev,
          [msUserId]: { ...prev[msUserId], expanded: false },
        }));
        return;
      }
      // Expand — lazy load if needed
      if (current.reports) {
        setTree((prev) => ({
          ...prev,
          [msUserId]: { ...prev[msUserId], expanded: true },
        }));
        return;
      }
      setTree((prev) => ({
        ...prev,
        [msUserId]: { ...prev[msUserId], loadingReports: true },
      }));
      try {
        const res = await fetch(
          `/api/directory/users/${encodeURIComponent(msUserId)}/direct-reports`,
          { headers: authHeaders() },
        );
        if (!res.ok) {
          setTree((prev) => ({
            ...prev,
            [msUserId]: {
              ...prev[msUserId],
              loadingReports: false,
              reports: [],
              expanded: true,
            },
          }));
          return;
        }
        const body = (await res.json()) as { reports?: DirectoryUserView[] };
        const reports = body.reports ?? [];
        setTree((prev) => {
          const next = { ...prev };
          next[msUserId] = {
            ...prev[msUserId],
            loadingReports: false,
            reports,
            expanded: true,
          };
          for (const r of reports) {
            if (!next[r.msUserId]) {
              next[r.msUserId] = { ...emptyNode(), user: r, loaded: true };
            }
          }
          return next;
        });
      } catch {
        setTree((prev) => ({
          ...prev,
          [msUserId]: { ...prev[msUserId], loadingReports: false, expanded: true },
        }));
      }
    },
    [tree, clamped],
  );

  const renderNode = (msUserId: string, depth: number): React.ReactElement => {
    const node = tree[msUserId];
    const user = node?.user ?? null;
    const canExpand = depth < clamped;
    const expanded = node?.expanded ?? false;

    return (
      <li
        key={msUserId}
        data-testid="org-chart-node"
        data-ms-user-id={msUserId}
        data-depth={depth}
        className="my-1"
        style={{ marginLeft: depth === 0 ? 0 : 16 }}
      >
        <div className="flex items-center gap-2">
          {canExpand ? (
            <button
              type="button"
              onClick={() => toggleReports(msUserId, depth)}
              aria-expanded={expanded}
              aria-label={expanded ? "Collapse reports" : "Expand reports"}
              data-testid="org-chart-expand"
              className="text-xs"
              style={{ color: "var(--wp-text-muted)" }}
            >
              {node?.loadingReports ? "…" : expanded ? "▾" : "▸"}
            </button>
          ) : (
            <span aria-hidden="true" className="text-xs" style={{ width: 12 }} />
          )}
          <span className="text-sm">
            {user ? user.displayName || user.userPrincipalName || msUserId : msUserId}
            {user?.jobTitle ? (
              <span className="ml-2 text-xs" style={{ color: "var(--wp-text-dim)" }}>
                {user.jobTitle}
              </span>
            ) : null}
          </span>
        </div>
        {expanded && node?.reports && node.reports.length > 0 ? (
          <ul className="border-l pl-2" style={{ borderColor: "var(--wp-dark-border)" }}>
            {node.reports.map((r) => renderNode(r.msUserId, depth + 1))}
          </ul>
        ) : null}
      </li>
    );
  };

  return (
    <ul data-testid="org-chart" className="list-none">
      {renderNode(rootMsUserId, 0)}
    </ul>
  );
}
