"use client";

/**
 * UserCard — renders a tenant directory user with avatar initials, title,
 * department, contact links, manager link + direct-reports count.
 *
 * Accepts a pre-resolved `user` prop OR an `idOrUpn` to look up. On a
 * cache-miss the backend transparently fetches from Graph + upserts, so the
 * "loading" state is usually momentary. We render a skeleton during the
 * fetch so the parent card layout doesn't jump.
 */

import { useEffect, useState } from "react";
import { authHeaders } from "@/lib/client-auth";
import OOOBadge from "@/components/presence/OOOBadge";

export interface DirectoryUserView {
  id: string;
  msUserId: string;
  userPrincipalName: string | null;
  displayName: string | null;
  givenName: string | null;
  surname: string | null;
  mail: string | null;
  jobTitle: string | null;
  department: string | null;
  officeLocation: string | null;
  businessPhones: string[];
  mobilePhone: string | null;
  managerMsId: string | null;
}

export interface UserCardProps {
  user?: DirectoryUserView;
  idOrUpn?: string;
  showManager?: boolean;
  showDirectReports?: boolean;
  showOOOForInstinctUserId?: string; // internal user id for cached OOO lookup
  compact?: boolean;
}

function initials(user: DirectoryUserView): string {
  const name = user.displayName || user.userPrincipalName || user.mail || "?";
  return name
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s.charAt(0).toUpperCase())
    .join("") || "?";
}

export default function UserCard(props: UserCardProps) {
  const [user, setUser] = useState<DirectoryUserView | null>(props.user ?? null);
  const [loaded, setLoaded] = useState<boolean>(Boolean(props.user));
  const [reportsCount, setReportsCount] = useState<number | null>(null);

  useEffect(() => {
    if (props.user) {
      setUser(props.user);
      setLoaded(true);
      return;
    }
    if (!props.idOrUpn) return;
    let active = true;
    (async () => {
      try {
        const res = await fetch(
          `/api/directory/users/${encodeURIComponent(props.idOrUpn!)}`,
          { headers: authHeaders() },
        );
        if (!active) return;
        if (!res.ok) {
          setUser(null);
          setLoaded(true);
          return;
        }
        const body = (await res.json()) as { user?: DirectoryUserView };
        setUser(body.user ?? null);
        setLoaded(true);
      } catch {
        if (active) setLoaded(true);
      }
    })();
    return () => {
      active = false;
    };
  }, [props.idOrUpn, props.user]);

  useEffect(() => {
    if (!user || !props.showDirectReports) return;
    let active = true;
    (async () => {
      try {
        const res = await fetch(
          `/api/directory/users/${encodeURIComponent(user.msUserId)}/direct-reports`,
          { headers: authHeaders() },
        );
        if (!active) return;
        if (!res.ok) return;
        const body = (await res.json()) as { reports?: unknown[] };
        setReportsCount(Array.isArray(body.reports) ? body.reports.length : 0);
      } catch {
        /* ignore */
      }
    })();
    return () => {
      active = false;
    };
  }, [user, props.showDirectReports]);

  if (!loaded) {
    return (
      <div
        data-testid="user-card-skeleton"
        className="rounded-lg border p-4 animate-pulse"
        style={{
          background: "var(--wp-dark-surface2)",
          borderColor: "var(--wp-dark-border)",
        }}
      >
        <div className="h-4 w-32 rounded bg-black/20" />
        <div className="mt-2 h-3 w-48 rounded bg-black/10" />
      </div>
    );
  }

  if (!user) {
    return (
      <div
        className="rounded-lg border p-4 text-sm"
        style={{
          background: "var(--wp-dark-surface2)",
          borderColor: "var(--wp-dark-border)",
          color: "var(--wp-text-dim)",
        }}
      >
        User not found
      </div>
    );
  }

  return (
    <div
      data-testid="user-card"
      data-ms-user-id={user.msUserId}
      className="rounded-lg border p-4 flex items-start gap-3"
      style={{
        background: "var(--wp-dark-surface2)",
        borderColor: "var(--wp-dark-border)",
      }}
    >
      <div
        aria-hidden="true"
        className="w-10 h-10 rounded-full flex items-center justify-center text-sm font-semibold shrink-0"
        style={{ background: "var(--wp-dark-surface)", color: "var(--wp-gold)" }}
      >
        {initials(user)}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <p className="text-sm font-semibold truncate">
            {user.displayName || user.userPrincipalName || "Unknown"}
          </p>
          {props.showOOOForInstinctUserId ? (
            <OOOBadge instinctUserId={props.showOOOForInstinctUserId} />
          ) : null}
        </div>
        {user.jobTitle ? (
          <p className="text-xs truncate" style={{ color: "var(--wp-text-dim)" }}>
            {user.jobTitle}
            {user.department ? <span> · {user.department}</span> : null}
          </p>
        ) : user.department ? (
          <p className="text-xs truncate" style={{ color: "var(--wp-text-dim)" }}>
            {user.department}
          </p>
        ) : null}
        {!props.compact && (
          <div className="mt-2 space-y-0.5 text-xs" style={{ color: "var(--wp-text-dim)" }}>
            {user.mail ? (
              <p className="truncate">
                <a href={`mailto:${user.mail}`} className="hover:underline">
                  {user.mail}
                </a>
              </p>
            ) : null}
            {user.mobilePhone ? (
              <p className="truncate">
                <a href={`tel:${user.mobilePhone}`} className="hover:underline">
                  {user.mobilePhone}
                </a>
              </p>
            ) : user.businessPhones.length > 0 ? (
              <p className="truncate">{user.businessPhones[0]}</p>
            ) : null}
            {user.officeLocation ? <p className="truncate">{user.officeLocation}</p> : null}
          </div>
        )}
        {(props.showManager && user.managerMsId) || (props.showDirectReports && reportsCount !== null) ? (
          <div className="mt-2 flex gap-3 text-xs" style={{ color: "var(--wp-text-muted)" }}>
            {props.showManager && user.managerMsId ? (
              <a
                href={`/directory/${encodeURIComponent(user.managerMsId)}`}
                className="hover:underline"
                data-testid="user-card-manager-link"
              >
                Manager
              </a>
            ) : null}
            {props.showDirectReports && reportsCount !== null ? (
              <span data-testid="user-card-reports-count">
                {reportsCount} report{reportsCount === 1 ? "" : "s"}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
