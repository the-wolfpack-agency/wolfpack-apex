"use client";

/**
 * /builds/security-plain-language - the plain-language product certification,
 * now a navigable, progress-tracked course rather than a static page.
 *
 * WHAT CHANGED. The same content (still sourced from
 * lib/builds/security-plain-language.ts, where a test pins its shape) is now
 * seeded into the lms_* tables and rendered as a course: a tier ladder, modules
 * of lessons, per-lesson completion, and a "check yourself" prompt. A signed-in
 * learner's progress is persisted and emits course.* analytics, so the page is
 * measurable, not illustrative.
 *
 * WHAT IS STILL TRUE. The product descriptions are written from public
 * knowledge; Palo Alto is not a client; the banner says so. What is now REAL is
 * the course mechanics and one learner's own progress - and only that.
 */

import { useCallback, useEffect, useState } from "react";
import { fetchWithRefresh, getInstinctToken, jsonHeaders } from "@/lib/client-auth";
import { CLIENT_BUILDS } from "@/lib/builds/registry";
import BuildBanner from "@/components/BuildBanner";
import { Stepper, type StepperStep } from "@/components/console";
import { METHOD, HEADLINE, CERT_PREMISE, PRECISION_NOTE, GATEKEEPING, REUSES, WHY_IT_WORKS, TO_BUILD_OUT, MEETING_BRIEF, DEMO_PATH } from "@/lib/builds/security-plain-language";
import type { LmsCourse, LessonBlock } from "@/lib/lms/content";
import type { CourseProgress, LessonStatus } from "@/lib/lms/progress";

const build = CLIENT_BUILDS.find((b) => b.href === "/builds/security-plain-language")!;
const SLUG = "security-plain-language";

const BLOCK_LABEL: Partial<Record<LessonBlock["type"], string>> = {
  glossary: "Jargon",
  stops: "What it stops",
  without: "Without it",
};

function LessonBlockView({ block }: { block: LessonBlock }) {
  if (block.type === "heading") return <h4 className="wp-build-lesson-h">{block.text}</h4>;
  if (block.type === "glossary")
    return (
      <p className="wp-build-lesson-jargon" data-testid="lesson-block-glossary">
        <span className="wp-build-lesson-beat">{BLOCK_LABEL.glossary}:</span> {block.term}
      </p>
    );
  if (block.type === "plain") return <p className="wp-build-lesson-plain">{block.text}</p>;
  if (block.type === "text") return <p className="wp-build-lesson-plain">{block.text}</p>;
  // stops / without: the value beats, called out.
  return (
    <p className={`wp-build-lesson-beat-row wp-build-lesson-${block.type}`}>
      <span className="wp-build-lesson-beat">{BLOCK_LABEL[block.type]}:</span>{" "}
      {"text" in block ? block.text : ""}
    </p>
  );
}

export default function SecurityPlainLanguagePage() {
  const [course, setCourse] = useState<LmsCourse | null>(null);
  const [progress, setProgress] = useState<CourseProgress | null>(null);
  const [failed, setFailed] = useState(false);
  const [viewed, setViewed] = useState<Set<string>>(new Set());
  const [checked, setChecked] = useState<Set<string>>(new Set());

  useEffect(() => {
    /* Authenticated page: bounce a signed-out visitor to login rather than
       drawing an empty shell (the April 16 blank-dashboard regression). */
    if (!getInstinctToken()) {
      window.location.href = `/login?next=/builds/${SLUG}`;
      return;
    }
    fetchWithRefresh(`/api/lms/courses/${SLUG}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: { course: LmsCourse; progress: CourseProgress }) => {
        setCourse(d.course);
        setProgress(d.progress);
      })
      .catch(() => setFailed(true));
  }, []);

  const post = useCallback(
    async (lessonId: string, action: "view" | "complete" | "self_check") => {
      const res = await fetchWithRefresh("/api/lms/progress", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ slug: SLUG, lessonId, action }),
      });
      if (res.ok) {
        const d: { progress: CourseProgress } = await res.json();
        setProgress(d.progress);
      }
    },
    [],
  );

  const onExpand = useCallback(
    (lessonId: string) => {
      if (viewed.has(lessonId)) return;
      setViewed((prev) => new Set(prev).add(lessonId));
      void post(lessonId, "view");
    },
    [viewed, post],
  );

  const statusOf = (lessonId: string): LessonStatus | undefined => progress?.lessons[lessonId];

  if (failed) {
    return (
      <main className="wp-pilot" data-testid="spl-course">
        <BuildBanner build={build} />
        <p className="wp-pilot-aside" data-testid="spl-unavailable">
          This course is unavailable right now. Please try again shortly.
        </p>
      </main>
    );
  }
  if (!course) {
    return (
      <main className="wp-pilot" data-testid="spl-course">
        <BuildBanner build={build} />
        <p className="wp-pilot-aside" data-testid="spl-loading">Loading the course...</p>
      </main>
    );
  }

  const total = course.lessonIds.length;
  const done = course.lessonIds.filter((id) => progress?.lessons[id] === "completed").length;
  const fraction = total > 0 ? done / total : 0;
  const complete = progress?.completed ?? false;

  // Honest tier ladder: Foundations is what this course's lessons prove; the
  // higher tiers require assessment we have not built yet, so they stay pending.
  const tierSteps: StepperStep[] = course.tracks.map((t, i) => {
    let status: StepperStep["status"];
    let detail = t.proves;
    if (i === 0) {
      status = complete ? "passed" : progress?.enrolled ? "running" : "pending";
    } else {
      status = "pending";
      detail = `${t.proves} (lessons ready below; the certification assessment arrives with the tutor)`;
    }
    return { key: t.id, label: `${t.name} - ${t.audience}`, status, detail };
  });

  return (
    <main className="wp-pilot" data-testid="spl-course">
      <BuildBanner build={build} />

      <header className="wp-pilot-head">
        <p className="wp-pilot-eyebrow">Plain-language product certification</p>
        <h1>{course.title}</h1>
        {course.headline && <p className="wp-pilot-sub">{course.headline}</p>}
      </header>

      {/* THE ENGAGEMENT BRIEF. The course is the interactive product; this is the
          argument BEHIND it, restored for the team to understand the engagement.
          Collapsible so it does not clutter the learner's path, but one click
          away. Everything here comes from lib/builds/security-plain-language.ts,
          where a test pins the shape. */}
      <details className="wp-pilot-section" data-testid="spl-brief">
        <summary className="wp-build-brief-summary" data-testid="spl-brief-summary">
          Engagement brief: the argument behind this course
        </summary>
        <div className="wp-build-brief-body">
          <p className="wp-pilot-sub">{HEADLINE}</p>

          <h3>Who gets left out</h3>
          <p className="wp-pilot-aside">{CERT_PREMISE}</p>

          <h3>Why: jargon is gatekeeping</h3>
          <p className="wp-pilot-aside">{GATEKEEPING.thesis}</p>
          <ul className="wp-pilot-list">
            {GATEKEEPING.points.map((pt) => (<li key={pt}>{pt}</li>))}
          </ul>
          <p className="wp-pilot-aside">{GATEKEEPING.cost}</p>

          <h3>The method: four beats</h3>
          <ol className="wp-pilot-list">
            {METHOD.map((m) => (<li key={m.beat}><strong>{m.beat}.</strong> {m.does}</li>))}
          </ol>
          <p className="wp-pilot-aside">{PRECISION_NOTE}</p>

          <h3>What it reuses from the proven program</h3>
          <ul className="wp-pilot-list">
            {REUSES.map((r) => (<li key={r.have}><strong>{r.have}</strong> {r.serves}</li>))}
          </ul>

          <h3>Why the team feels the value</h3>
          <ul className="wp-pilot-list">
            {WHY_IT_WORKS.map((w) => (<li key={w}>{w}</li>))}
          </ul>

          <h3>What turns this into an engagement</h3>
          <ul className="wp-pilot-list">
            {TO_BUILD_OUT.map((t) => (<li key={t.question}><strong>{t.question}</strong> {t.why}</li>))}
          </ul>
        </div>
      </details>

      {/* PRESENTER NOTES for the warm second meeting. Collapsed by default so it
          is never on screen during the live demo; open it to prep. */}
      <details className="wp-pilot-section" data-testid="spl-meeting">
        <summary className="wp-build-brief-summary" data-testid="spl-meeting-summary">
          Notes
        </summary>
        <div className="wp-build-brief-body">
          <p className="wp-pilot-aside">{MEETING_BRIEF.context}</p>

          <h3>Open by</h3>
          <p className="wp-pilot-aside">{MEETING_BRIEF.openBy}</p>

          <h3>Three things to land</h3>
          <ul className="wp-pilot-list">
            {MEETING_BRIEF.landThese.map((l) => (<li key={l}>{l}</li>))}
          </ul>

          <h3>The demo moment</h3>
          <p className="wp-pilot-aside">{MEETING_BRIEF.demoMoment}</p>

          <h3>The honest line</h3>
          <p className="wp-pilot-aside">{MEETING_BRIEF.theHonestLine}</p>

          <h3>The ask</h3>
          <p className="wp-pilot-aside">{MEETING_BRIEF.theAsk}</p>

          <h3>Demo path, in order</h3>
          <ol className="wp-pilot-list">
            {DEMO_PATH.map((d) => (
              <li key={d.step}><strong>{d.step}.</strong> Show {d.show} <em>Why: {d.why}</em></li>
            ))}
          </ol>
        </div>
      </details>

      {/* THE LADDER, as the progression spine. */}
      <section className="wp-pilot-section" data-testid="spl-tiers">
        <h2>The certification ladder</h2>
        <Stepper steps={tierSteps} testId="spl-ladder" />
      </section>

      {/* PROGRESS. */}
      <section className="wp-pilot-section" data-testid="spl-progress">
        <p className="wp-pilot-aside">
          <strong data-testid="spl-progress-count">{done} of {total}</strong> lessons complete.
          {complete && (
            <span data-testid="spl-complete-badge" className="wp-build-complete"> Foundations complete.</span>
          )}
        </p>
        <div className="wp-build-progress-track" aria-hidden>
          <div className="wp-build-progress-fill" style={{ width: `${Math.round(fraction * 100)}%` }} />
        </div>
      </section>

      {/* THE MODULES AND LESSONS. */}
      {course.modules.map((m) => (
        <section className="wp-pilot-section" data-testid={`spl-module-${m.position}`} key={m.id}>
          <h2>{m.title}</h2>
          {m.summary && <p className="wp-pilot-aside">{m.summary}</p>}
          <ul className="wp-build-lessons">
            {m.lessons.map((lesson) => {
              const s = statusOf(lesson.id);
              const isDone = s === "completed";
              return (
                <li className="wp-build-lesson" data-testid={`lesson-${lesson.id}`} key={lesson.id}>
                  <details onToggle={(e) => (e.currentTarget as HTMLDetailsElement).open && onExpand(lesson.id)}>
                    <summary className="wp-build-lesson-summary">
                      <span className="wp-build-lesson-title">{lesson.title}</span>
                      {lesson.subtitle && <span className="wp-build-lesson-sub">{lesson.subtitle}</span>}
                      {isDone && <span className="wp-build-lesson-check" data-testid={`lesson-done-${lesson.id}`}>✓ complete</span>}
                    </summary>
                    <div className="wp-build-lesson-body">
                      {lesson.blocks.map((b, i) => (
                        <LessonBlockView block={b} key={i} />
                      ))}
                      {checked.has(lesson.id) && (
                        <div className="wp-build-selfcheck" data-testid={`lesson-selfcheck-${lesson.id}`}>
                          <p className="wp-build-lesson-beat">Can you say it in the four beats?</p>
                          <ol>
                            {METHOD.map((beat) => (
                              <li key={beat.beat}><strong>{beat.beat}.</strong> {beat.does}</li>
                            ))}
                          </ol>
                        </div>
                      )}
                      <div className="wp-build-lesson-actions">
                        <button
                          type="button"
                          data-testid={`lesson-complete-${lesson.id}`}
                          className="wp-build-btn"
                          disabled={isDone}
                          onClick={() => void post(lesson.id, "complete")}
                        >
                          {isDone ? "Completed" : "Mark complete"}
                        </button>
                        <button
                          type="button"
                          data-testid={`lesson-check-${lesson.id}`}
                          className="wp-build-btn wp-build-btn-ghost"
                          onClick={() => {
                            setChecked((prev) => new Set(prev).add(lesson.id));
                            void post(lesson.id, "self_check");
                          }}
                        >
                          Check yourself
                        </button>
                      </div>
                    </div>
                  </details>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </main>
  );
}
