"use client";

/**
 * Forcefield public status page - /forcefield/status
 *
 * The honest, public health of the Forcefield control plane, so a prospect or a
 * customer (or an external uptime monitor) can see it is up. Reads the public
 * /api/forcefield/status endpoint. It leads with the fail-open guarantee, because
 * that is the point a reviewer cares about: a Forcefield outage never takes a
 * customer site down.
 *
 * Honest by construction: it shows LIVE health, and says plainly that historical
 * uptime history is not published yet (that needs an external monitor). It never
 * invents a number.
 *
 * Raw fetch is correct here (public, no session/JWT); the file is in the
 * no-raw-api-fetch guardrail exceptions, same as the other /forcefield pages.
 */
import { useCallback, useEffect, useState } from "react";
import { GlassPanel, StatusPill } from "@/components/console";

interface Status {
  ok: boolean;
  status: "ok" | "degraded";
  engine: string;
  database: boolean;
  failOpen: boolean;
}

export default function ForcefieldStatusPage() {
  const [data, setData] = useState<Status | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "error">("loading");
  const [checkedAt, setCheckedAt] = useState<string>("");

  const load = useCallback(async () => {
    setState("loading");
    try {
      const res = await fetch("/api/forcefield/status", { cache: "no-store" });
      if (!res.ok) { setState("error"); return; }
      setData((await res.json()) as Status);
      setState("ok");
      setCheckedAt(new Date().toLocaleString());
    } catch {
      setState("error");
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const operational = state === "ok" && data?.status === "ok";
  const degraded = state === "ok" && data?.status === "degraded";

  return (
    <main className="min-h-screen px-4 py-12 sm:px-8" style={{ background: "var(--wp-bg, #0b0d11)", color: "var(--wp-ink, #e8eaed)" }}>
      <div className="mx-auto w-full max-w-2xl">
        <header className="mb-8 flex items-center gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/ogiam-logo.png" alt="OGIAM" width={32} height={32} style={{ height: 32, width: "auto" }} />
          <div>
            <h1 className="text-2xl font-medium tracking-[-0.01em]">Forcefield status</h1>
            <p className="text-sm" style={{ color: "var(--wp-muted, #9aa0a6)" }}>Live health of the Forcefield service.</p>
          </div>
        </header>

        <GlassPanel testId="ff-status" padded glow={operational ? "none" : "gold"}>
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <StatusPill
                status={operational ? "operational" : degraded ? "degraded" : "unknown"}
                tone={operational ? "success" : degraded ? "warning" : undefined}
                label={state === "loading" ? "Checking..." : operational ? "All systems operational" : degraded ? "Degraded" : "Status unavailable"}
              />
            </div>
            <button data-testid="ff-status-refresh" type="button" onClick={() => void load()} disabled={state === "loading"}
              className="text-xs underline" style={{ color: "var(--wp-muted, #9aa0a6)" }}>
              {state === "loading" ? "Checking..." : "Refresh"}
            </button>
          </div>

          {state === "ok" && data && (
            <div className="mt-5 flex flex-col gap-2" data-testid="ff-status-components">
              <Row label="Detection + enforcement engine" up={data.engine === "ok"} />
              <Row label="Data + dashboard" up={data.database} />
            </div>
          )}
          {state === "error" && (
            <p data-testid="ff-status-error" className="mt-4 text-sm" style={{ color: "#f87171" }}>
              Could not reach the status service just now. Please refresh in a moment.
            </p>
          )}
          {checkedAt && <p className="mt-4 text-xs" style={{ color: "var(--wp-muted, #9aa0a6)" }}>Last checked: {checkedAt}</p>}
        </GlassPanel>

        <GlassPanel testId="ff-status-failopen" padded style={{ marginTop: "1rem" }}>
          <h2 className="text-sm font-medium">Fail-open guarantee</h2>
          <p className="mt-2 text-[13px] leading-relaxed" style={{ color: "var(--wp-muted, #9aa0a6)" }}>
            Forcefield is designed so that if this service is ever slow or unreachable, your site keeps
            serving. The edge shim fails open: on any error it allows the request through. A Forcefield
            outage degrades protection, never your site&apos;s availability.
          </p>
        </GlassPanel>

        <p className="mt-6 text-xs" style={{ color: "var(--wp-muted, #9aa0a6)" }}>
          This page shows live health. Historical uptime and a committed SLA are published for customers
          on a paid plan.
        </p>
      </div>
    </main>
  );
}

function Row({ label, up }: { label: string; up: boolean }) {
  return (
    <div className="flex items-center justify-between rounded-md px-3 py-2 text-sm" style={{ background: "rgba(255,255,255,0.03)" }}>
      <span>{label}</span>
      <span className="flex items-center gap-1.5 text-xs" style={{ color: up ? "#22c55e" : "#f59e0b" }}>
        <span style={{ width: 8, height: 8, borderRadius: 999, background: up ? "#22c55e" : "#f59e0b", display: "inline-block" }} />
        {up ? "Operational" : "Degraded"}
      </span>
    </div>
  );
}
