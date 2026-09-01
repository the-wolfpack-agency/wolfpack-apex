"use client";

/**
 * What this product can do, laid out so somebody can act on it.
 *
 * WHAT IT REPLACES. A wall of markdown: three headings, sixty-odd bullets and
 * a closing paragraph. Every line accurate, nothing findable. For the first
 * screen a person ever sees, that is the whole job failed. They do not want to
 * read a catalog, they want one thing to try.
 *
 * SO STARTERS COME FIRST AND ARE CLICKABLE. Clicking puts the sentence in the
 * composer rather than sending it, matching the fallback chips this product
 * already uses: somebody almost always wants to change a word, and sending on
 * their behalf takes that away.
 *
 * THE CATALOG STAYS, COLLAPSED. "Can it do X" is a real question and the
 * list is the only honest answer, but it is reference material and does not
 * belong ahead of the thing somebody can do in the next five seconds.
 */

import { useEffect, useState } from "react";
import { fetchWithRefresh } from "@/lib/client-auth";
import type { CapabilitiesWidgetSpec } from "@/lib/assistant/widgets/types";
import { StaggeredItem, useStaggeredReveal } from "./StaggeredItem";

export interface CapabilitiesWidgetProps {
  spec: CapabilitiesWidgetSpec;
  workflowId?: string;
  /** Puts a sentence in the composer. Absent in tests and on read-only surfaces. */
  onPickPrompt?: (prompt: string) => void;
}

export default function CapabilitiesWidget({
  spec,
  workflowId,
  onPickPrompt,
}: CapabilitiesWidgetProps) {
  const [openGroup, setOpenGroup] = useState<string | null>(null);

  const itemCount =
    spec.starters.length + spec.routines.length + spec.groups.reduce((n, g) => n + g.items.length, 0);

  useEffect(() => {
    fetchWithRefresh("/api/analytics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "assistant.widget_rendered",
        metadata: {
          widget_kind: "capabilities",
          item_count: itemCount,
          starter_count: spec.starters.length,
          group_count: spec.groups.length,
          ...(workflowId ? { workflow_id: workflowId } : {}),
        },
      }),
    }).catch(() => undefined);
  }, [itemCount, spec.starters.length, spec.groups.length, workflowId]);

  useStaggeredReveal({ widgetKind: "capabilities", itemCount, workflowId });

  function track(action: string, value?: string) {
    fetchWithRefresh("/api/analytics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "assistant.widget_interaction",
        metadata: {
          widget_kind: "capabilities",
          action,
          ...(value ? { value } : {}),
          ...(workflowId ? { workflow_id: workflowId } : {}),
        },
      }),
    }).catch(() => undefined);
  }

  function pick(prompt: string, action: string) {
    track(action, prompt);
    onPickPrompt?.(prompt);
  }

  return (
    <div className="wp-cap" data-testid="capabilities-widget">
      {/* THE FIRST THING, BECAUSE IT IS THE ONLY THING MOST PEOPLE NEED. */}
      {spec.starters.length > 0 ? (
        <section className="wp-cap-start">
          <h4 className="wp-cap-head">Try one of these</h4>
          <div className="wp-cap-starters" data-testid="capabilities-starters">
            {spec.starters.map((s, i) => (
              <StaggeredItem key={s.prompt} index={i}>
                <button
                  type="button"
                  className="wp-cap-starter"
                  onClick={() => pick(s.prompt, "starter_picked")}
                  data-testid="capabilities-starter"
                >
                  <span className="wp-cap-starter-prompt">{s.prompt}</span>
                  <span className="wp-cap-starter-why">{s.because}</span>
                </button>
              </StaggeredItem>
            ))}
          </div>
        </section>
      ) : null}

      {/* WHOLE JOBS. Named separately because one command doing six things is
          a different promise from one command doing one thing. */}
      {spec.routines.length > 0 ? (
        <section className="wp-cap-block">
          <h4 className="wp-cap-head">Whole jobs, in one command</h4>
          <div className="wp-cap-routines">
            {spec.routines.map((r) => (
              <button
                key={r.command}
                type="button"
                className="wp-cap-routine"
                onClick={() => pick(r.command, "routine_picked")}
                data-testid="capabilities-routine"
              >
                <code className="wp-cap-cmd">{r.command}</code>
                <span className="wp-cap-routine-desc">{r.description}</span>
              </button>
            ))}
          </div>
          <p className="wp-cap-note">
            Each runs several steps in order and stops when it needs you. Nothing is sent,
            filed or told to anybody without you confirming it.
          </p>
        </section>
      ) : null}

      {/* REFERENCE, COLLAPSED. Available to the person who asks "can it do X",
          out of the way of the person who just wants to start. */}
      {spec.groups.length > 0 ? (
        <section className="wp-cap-block">
          <h4 className="wp-cap-head">Everything, one thing at a time</h4>
          <ul className="wp-cap-groups">
            {spec.groups.map((g) => {
              const open = openGroup === g.title;
              return (
                <li key={g.title} className="wp-cap-group">
                  <button
                    type="button"
                    className="wp-cap-group-toggle"
                    aria-expanded={open}
                    onClick={() => {
                      setOpenGroup(open ? null : g.title);
                      track(open ? "group_closed" : "group_opened", g.title);
                    }}
                    data-testid="capabilities-group-toggle"
                  >
                    <span>{g.title}</span>
                    <span className="wp-cap-count">{g.items.length}</span>
                  </button>
                  {open ? (
                    <ul className="wp-cap-items" data-testid="capabilities-group-items">
                      {g.items.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      <p className="wp-cap-invite">{spec.fallbackInvitation}</p>
    </div>
  );
}
