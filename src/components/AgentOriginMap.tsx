"use client";

/**
 * Agent origin map: where AGENT traffic reached our surface from, by the
 * request's edge country, on a dark equirectangular world grid with glowing
 * nodes sized by volume and colored by how Forcefield handled them (red =
 * hostile-leaning, amber = unidentified automation, green = verified good
 * agents, Web Bot Auth). A UA-only claim is spoofable and stays amber.. A cluster of hostile nodes over one region is the signal.
 *
 * HONEST BY CONSTRUCTION. This is the NETWORK ORIGIN of the traffic - a cloud
 * region or proxy just as often as a person's country - so it is a coarse
 * origin signal, never a confirmed operator location. The caption says so.
 * Countries we do not have a centroid for still appear in the exact-count list.
 */

import { centroidFor, project } from "@/lib/geo/country-centroids";
import { worldOutlinePaths } from "@/lib/geo/world-outline";

export interface AgentOrigin {
  country: string;
  total: number;
  welcomed: number;
  /** Welcomes we actually VERIFIED (Web Bot Auth), not just UA-claimed. Only
   *  these earn the trusted-green tone; a UA-only claim is spoofable. */
  welcomedVerified: number;
  flagged: number;
  hostile: number;
}

const W = 720;
const H = 360;

function tone(o: AgentOrigin): string {
  // A UA-claimed "known bot" is spoofable (a Googlebot UA from an unexpected
  // network is a classic tell), so only WEB-BOT-AUTH-VERIFIED welcomes earn the
  // trusted green. UA-only claims count as unverified automation, like flagged.
  const unverified = o.flagged + Math.max(0, o.welcomed - o.welcomedVerified);
  if (o.hostile > 0 && o.hostile >= o.welcomedVerified) return "#ef4444"; // hostile-leaning
  if (o.welcomedVerified > 0 && o.welcomedVerified >= unverified && o.welcomedVerified >= o.hostile) return "#30a46c"; // verified good agent
  return "#f5a623"; // unidentified / unverified automation
}

export function AgentOriginMap({ origins }: { origins: readonly AgentOrigin[] }) {
  const maxTotal = Math.max(1, ...origins.map((o) => o.total));
  const placed = origins
    .map((o) => ({ o, c: centroidFor(o.country) }))
    .filter((x): x is { o: AgentOrigin; c: NonNullable<ReturnType<typeof centroidFor>> } => x.c !== null);

  const meridians = [-150, -120, -90, -60, -30, 0, 30, 60, 90, 120, 150];
  const parallels = [-60, -30, 0, 30, 60];

  if (origins.length === 0) {
    return (
      <div data-testid="agent-origin-map-empty" style={{ fontSize: "0.8rem", color: "var(--wp-text-muted, #9ca3af)" }}>
        No agent traffic recorded in this window yet. Origins appear here as ogiam.com sees agent requests.
      </div>
    );
  }

  return (
    <div data-testid="agent-origin-map" style={{ display: "grid", gap: "0.8rem" }}>
      <style>{`
        @keyframes ff-origin-pulse { 0%,100% { opacity: 0.32; } 50% { opacity: 0.08; } }
        .ff-origin-halo { animation: ff-origin-pulse 2.6s ease-in-out infinite; }
        @media (prefers-reduced-motion: reduce) { .ff-origin-halo { animation: none; } }
      `}</style>
      <div style={{ position: "relative", width: "100%", borderRadius: 8, overflow: "hidden", background: "radial-gradient(120% 120% at 50% 30%, #0e1626 0%, #0b0d11 70%)" }}>
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Agent traffic origins by country" style={{ display: "block" }}>
          {/* world landmass outline: a subtle backdrop so the nodes read as
              geography, not floating dots. Low-poly + low-opacity on purpose. */}
          {worldOutlinePaths(W, H).map((d, i) => (
            <path key={`land${i}`} d={d} fill="rgba(120,150,200,0.06)" stroke="rgba(120,150,200,0.16)" strokeWidth={0.75} />
          ))}
          {/* graticule */}
          {meridians.map((lon) => {
            const x = ((lon + 180) / 360) * W;
            return <line key={`m${lon}`} x1={x} y1={0} x2={x} y2={H} stroke="rgba(120,150,200,0.08)" strokeWidth={1} />;
          })}
          {parallels.map((lat) => {
            const y = ((90 - lat) / 180) * H;
            return <line key={`p${lat}`} x1={0} y1={y} x2={W} y2={y} stroke="rgba(120,150,200,0.08)" strokeWidth={1} />;
          })}
          <line x1={0} y1={H / 2} x2={W} y2={H / 2} stroke="rgba(120,150,200,0.16)" strokeWidth={1} />

          {placed.map(({ o, c }) => {
            const p = project(c.lat, c.lon);
            const x = p.x * W;
            const y = p.y * H;
            const r = 3 + Math.sqrt(o.total / maxTotal) * 13;
            const color = tone(o);
            return (
              <g key={o.country} data-testid={`origin-node-${o.country}`}>
                <circle className="ff-origin-halo" cx={x} cy={y} r={r} fill={color} opacity={0.3} />
                <circle cx={x} cy={y} r={Math.max(2, r * 0.42)} fill={color}>
                  <title>{`${c.name} (${o.country}) · ${o.total} agent requests · ${o.hostile} hostile · ${o.flagged} flagged · ${o.welcomedVerified} verified good, ${Math.max(0, o.welcomed - o.welcomedVerified)} UA-claimed (unverified)`}</title>
                </circle>
              </g>
            );
          })}
        </svg>
      </div>

      {/* legend + honest caption */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem 1rem", fontSize: "0.7rem", color: "var(--wp-text-muted, #9ca3af)" }}>
        <Legend color="#ef4444" label="hostile-leaning" />
        <Legend color="#f5a623" label="unverified / unidentified" />
        <Legend color="#30a46c" label="verified good agent" />
        <span style={{ marginLeft: "auto", fontStyle: "italic" }}>Network origin (edge IP country) - a cloud region or proxy, not a confirmed operator location.</span>
      </div>

      {/* exact counts, incl. countries with no centroid */}
      <ul data-testid="agent-origin-list" style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "0.25rem" }}>
        {origins.slice(0, 12).map((o) => (
          <li key={o.country} style={{ display: "flex", alignItems: "center", gap: "0.6rem", fontSize: "0.76rem" }}>
            <span style={{ width: 8, height: 8, borderRadius: 999, background: tone(o), flex: "0 0 auto" }} />
            <span style={{ width: 28, color: "var(--wp-text, #eee)", fontWeight: 600, flex: "0 0 auto" }}>{o.country}</span>
            <span style={{ flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--wp-text-muted, #9ca3af)" }}>{centroidFor(o.country)?.name ?? "unknown region"}</span>
            {/* Two fixed, right-aligned columns so totals line up whether or not a
                row has a hostile tag. The hostile column is always reserved (empty
                when zero) so the total never slides into it. */}
            <span style={{ width: 44, flex: "0 0 auto", textAlign: "right", color: "var(--wp-text, #eee)", fontVariantNumeric: "tabular-nums" }}>{o.total}</span>
            <span data-testid={`origin-hostile-${o.country}`} style={{ width: 68, flex: "0 0 auto", textAlign: "right", color: "#ef4444", fontVariantNumeric: "tabular-nums" }}>{o.hostile > 0 ? `${o.hostile} hostile` : ""}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem" }}>
      <span style={{ width: 8, height: 8, borderRadius: 999, background: color }} />
      {label}
    </span>
  );
}
