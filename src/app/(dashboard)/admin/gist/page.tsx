"use client";

/**
 * /admin/gist - what the product has learned from its own decisions.
 *
 * THE ARGUMENT THIS PAGE MAKES. Instinct is sold one client, one database, so
 * today every deployment starts ignorant and stays ignorant: nothing learned
 * serving one client can help the next, because the data cannot move. A gist
 * is the only artifact that can legitimately cross that boundary. It records
 * the SHAPE of a decision, never its content, which is why it can.
 *
 * SO THE PAGE LEADS WITH WHAT A GIST CAN CONTAIN. The safety claim is the
 * whole proposition, and showing the closed vocabulary is more convincing than
 * describing it: there is no free-text field, so there is nothing to redact
 * and nothing to leak.
 *
 * Then it shows whether the abstraction actually predicts anything, measured
 * on real traffic. A page that argued the idea without the numbers would be a
 * pitch deck.
 */

import { useCallback, useEffect, useState } from "react";
import { getInstinctUser, authHeaders, fetchWithRefresh } from "@/lib/client-auth";

interface Signal {
  feature: string;
  value: string;
  observations: number;
  badRate: number;
  lift: number;
  trustworthy: boolean;
}

interface GistState {
  readable: boolean;
  days: number;
  minObservations?: number;
  turns?: number;
  baseBadRate?: number;
  outcomes?: Record<string, number>;
  signals?: Signal[];
  usable?: Signal[];
  vocabulary?: Record<string, string[]>;
}

/* What each outcome means, in the words somebody would use out loud. */
const OUTCOME_MEANING: Record<string, string> = {
  dead_end: "was told we had nothing, and never came back",
  re_asked: "asked the same thing again in different words",
  pushed_past: "was told we had nothing and carried on anyway",
  continued: "kept the conversation going",
  single_turn: "asked once and stopped. Satisfied or gave up: this cannot tell which",
};

export default function GistPage() {
  const [state, setState] = useState<GistState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const user = getInstinctUser();
    if (!user) {
      window.location.href = "/login?next=/admin/gist";
      return;
    }
    try {
      const res = await fetchWithRefresh("/api/admin/gist", { headers: authHeaders() });
      if (!res.ok) {
        setError(`The gist could not be read (HTTP ${res.status}).`);
        return;
      }
      setState(await res.json());
    } catch {
      setError("The gist could not be read.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const dim = { color: "var(--wp-text-dim)" };
  const text = { color: "var(--wp-text)" };

  return (
    <main className="p-6 max-w-4xl">
      <h1 className="text-2xl font-bold mb-2" style={text}>
        Gist
      </h1>
      <p className="text-sm mb-6" style={dim}>
        What the product learns from its own decisions, without keeping anything anybody said.
      </p>

      {/* THE SAFETY ARGUMENT, FIRST AND CONCRETE. */}
      <section className="mb-8" data-testid="gist-vocabulary">
        <h2 className="text-lg font-semibold mb-2" style={text}>
          What a gist can contain
        </h2>
        <p className="text-xs mb-3" style={dim}>
          Everything a gist holds comes from the lists below. There is no free-text field, so there
          is nothing to redact and nothing to leak. That is what lets one client&rsquo;s experience
          improve the next one without their data going anywhere: what somebody asked about belongs
          to them, how the product behaved does not.
        </p>
        {state?.vocabulary ? (
          <ul className="text-xs space-y-1" style={dim}>
            {Object.entries(state.vocabulary).map(([name, values]) => (
              <li key={name}>
                <span style={text}>{name}</span>: {values.join(" · ")}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs" style={dim}>
            Loading.
          </p>
        )}
      </section>

      {error ? (
        <p className="text-sm" style={dim} data-testid="gist-error">
          {error}
        </p>
      ) : null}

      {state && !state.readable ? (
        <p className="text-sm" style={dim} data-testid="gist-unreadable">
          The message store could not be read, so nothing is reported here. That is different from a
          quiet quarter and is not shown as one.
        </p>
      ) : null}

      {state?.readable ? (
        <>
          <section className="mb-8" data-testid="gist-outcomes">
            <h2 className="text-lg font-semibold mb-2" style={text}>
              What happened, across {state.turns?.toLocaleString()} answered turns
            </h2>
            <p className="text-xs mb-3" style={dim}>
              Last {state.days} days. A turn &ldquo;ended badly&rdquo; when somebody hit a dead end
              or had to ask again: {((state.baseBadRate ?? 0) * 100).toFixed(1)}% of the time.
            </p>
            <ul className="text-xs space-y-1" style={dim}>
              {Object.entries(state.outcomes ?? {})
                .sort((a, b) => b[1] - a[1])
                .map(([outcome, n]) => (
                  <li key={outcome}>
                    <span style={text}>{n.toLocaleString()}</span> {OUTCOME_MEANING[outcome] ?? outcome}
                  </li>
                ))}
            </ul>
          </section>

          {/* THE FINDING. Whether shape alone predicts trouble. */}
          <section data-testid="gist-signals">
            <h2 className="text-lg font-semibold mb-2" style={text}>
              What the shape predicts
            </h2>
            <p className="text-xs mb-3" style={dim}>
              Lift is how much more often a turn ends badly when this is true, against the overall
              rate. Anything under {state.minObservations} observations is marked thin: this product
              adopted a conclusion from six data points once and had to reverse it.
            </p>
            <div className="overflow-x-auto">
              <table className="text-xs w-full" style={dim}>
                <thead>
                  <tr style={text}>
                    <th className="text-left pr-4 pb-1">Shape</th>
                    <th className="text-right pr-4 pb-1">Turns</th>
                    <th className="text-right pr-4 pb-1">Ended badly</th>
                    <th className="text-right pr-4 pb-1">Lift</th>
                    <th className="text-left pb-1">Read as</th>
                  </tr>
                </thead>
                <tbody>
                  {(state.signals ?? []).map((s) => (
                    <tr key={`${s.feature}-${s.value}`} data-testid="gist-signal-row">
                      <td className="pr-4 py-0.5" style={text}>
                        {s.feature}={s.value}
                      </td>
                      <td className="text-right pr-4 tabular-nums">{s.observations.toLocaleString()}</td>
                      <td className="text-right pr-4 tabular-nums">{(s.badRate * 100).toFixed(1)}%</td>
                      <td className="text-right pr-4 tabular-nums">{s.lift.toFixed(2)}</td>
                      <td>
                        {!s.trustworthy
                          ? "too thin to trust"
                          : s.lift >= 1.5
                            ? "predicts trouble"
                            : s.lift <= 0.5
                              ? "reliably fine"
                              : ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-xs mt-3" style={dim} data-testid="gist-verdict">
              {(state.usable?.length ?? 0) > 0
                ? `${state.usable!.length} of these both clear the floor and move the rate enough to act on. The shape carries signal, so storing it is worth doing.`
                : "Nothing here clears the floor and moves the rate enough to act on. The shape does not carry usable signal on this data, and a store would hold noise."}
            </p>
          </section>
        </>
      ) : null}
    </main>
  );
}
