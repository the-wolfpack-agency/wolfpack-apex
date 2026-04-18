"use client";

/**
 * BriefForm — guided editor for a SiteBrief.
 *
 * Replaces the raw JSON textarea on the site detail page. Renders a form
 * for top-level product fields plus a list of sections, each with a small
 * type-specific sub-form. Falls back to a JSON view via the toggle for
 * power users / unsupported edits.
 *
 * Every edit fires onChange so the parent can persist + emit
 * `site.brief_form_edited` analytics. NO orphan UI.
 */

import { useState, useId } from "react";

// slugify + kebab-case — used to turn a label into a stable DOM id.
// Every input on every form in this file goes through either Field or
// NamedInput so each has an id + matching name + htmlFor label. Chrome
// Issues tab complains "A form field element should have an id or name
// attribute" otherwise, and those warnings accumulate per-render —
// during a 4s deploy-status poll the count hits the hundreds quickly.
function slug(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "") || "field";
}

export const SECTION_TYPES = [
  "hero",
  "text",
  "callout",
  "banner",
  "stats",
  "cards",
  "gallery",
  "quote",
] as const;
export type SectionType = (typeof SECTION_TYPES)[number];

export interface Section {
  type: SectionType;
  heading?: string;
  body?: string;
  cta?: { label: string; href: string };
  backgroundImage?: string;
  items?: Array<Record<string, unknown>>;
  images?: Array<{ src: string; alt?: string }>;
  attribution?: string;
}

export interface Brief {
  client: string;
  product: { name: string; tagline?: string; supportEmail?: string; domain?: string };
  theme?: Record<string, string>;
  pages: Array<{ route: string; title?: string; sections: Section[] }>;
  contactForm?: { fields: string[] };
}

export interface BriefFormProps {
  value: Brief;
  onChange: (next: Brief) => void;
}

export function BriefForm({ value, onChange }: BriefFormProps) {
  const [showJson, setShowJson] = useState(false);
  const page = value.pages[0] ?? { route: "/", sections: [] };

  function update(next: Partial<Brief>) {
    onChange({ ...value, ...next });
  }
  function updateSections(sections: Section[]) {
    onChange({ ...value, pages: [{ ...page, sections }, ...value.pages.slice(1)] });
  }
  function updateSection(idx: number, patch: Partial<Section>) {
    const next = page.sections.map((s, i) => (i === idx ? { ...s, ...patch } : s));
    updateSections(next);
  }
  function addSection(type: SectionType) {
    const blank: Section = { type };
    if (type === "stats") blank.items = [{ label: "", value: 0 }];
    if (type === "cards") blank.items = [{ title: "", body: "" }];
    if (type === "gallery") blank.images = [];
    updateSections([...page.sections, blank]);
  }
  function removeSection(idx: number) {
    updateSections(page.sections.filter((_, i) => i !== idx));
  }
  function moveSection(idx: number, dir: -1 | 1) {
    const next = [...page.sections];
    const j = idx + dir;
    if (j < 0 || j >= next.length) return;
    [next[idx], next[j]] = [next[j], next[idx]];
    updateSections(next);
  }

  if (showJson) {
    return (
      <div data-brief-form="json">
        <button onClick={() => setShowJson(false)} style={btn()}>← Form view</button>
        <label htmlFor="brief-json-editor" style={{ position: "absolute", left: "-9999px" }}>
          Brief JSON editor
        </label>
        <textarea
          id="brief-json-editor"
          name="brief-json-editor"
          aria-label="Brief JSON editor"
          value={JSON.stringify(value, null, 2)}
          onChange={(e) => {
            try {
              onChange(JSON.parse(e.target.value));
            } catch {
              /* ignore until valid */
            }
          }}
          style={{ width: "100%", minHeight: "500px", marginTop: "0.75rem", fontFamily: "monospace", fontSize: "0.8rem", background: "var(--wp-dark)", color: "var(--wp-text)", border: "1px solid var(--wp-border)", borderRadius: "6px", padding: "1rem" }}
        />
      </div>
    );
  }

  return (
    <div data-brief-form="form" style={{ display: "grid", gap: "1rem" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h3 style={{ margin: 0, fontSize: "1rem" }}>Product</h3>
        <button onClick={() => setShowJson(true)} style={btn()}>Show JSON</button>
      </div>
      <div style={grid()}>
        <Field label="Display name" value={value.product.name} onChange={(v) => update({ product: { ...value.product, name: v } })} />
        <Field label="Tagline" value={value.product.tagline ?? ""} onChange={(v) => update({ product: { ...value.product, tagline: v } })} />
        <Field label="Domain" value={value.product.domain ?? ""} onChange={(v) => update({ product: { ...value.product, domain: v } })} />
        <Field label="Support email" value={value.product.supportEmail ?? ""} onChange={(v) => update({ product: { ...value.product, supportEmail: v } })} />
      </div>

      <h3 style={{ margin: "1rem 0 0.25rem", fontSize: "1rem" }}>Sections ({page.sections.length})</h3>
      {page.sections.map((s, i) => (
        <div key={i} data-section={s.type} style={card()}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.5rem" }}>
            <strong style={{ textTransform: "uppercase", fontSize: "0.7rem", letterSpacing: "0.1em", color: "var(--wp-gold)" }}>{s.type}</strong>
            <div style={{ display: "flex", gap: "0.25rem" }}>
              <button onClick={() => moveSection(i, -1)} style={btnSmall()} aria-label="Move up">↑</button>
              <button onClick={() => moveSection(i, 1)} style={btnSmall()} aria-label="Move down">↓</button>
              <button onClick={() => removeSection(i)} style={btnSmall("#c44")} aria-label="Remove">✕</button>
            </div>
          </div>
          <SectionEditor section={s} onChange={(patch) => updateSection(i, patch)} />
        </div>
      ))}

      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem", marginTop: "0.5rem" }}>
        {SECTION_TYPES.map((t) => (
          <button key={t} onClick={() => addSection(t)} style={btnSmall()}>+ {t}</button>
        ))}
      </div>
    </div>
  );
}

function SectionEditor({ section, onChange }: { section: Section; onChange: (patch: Partial<Section>) => void }) {
  switch (section.type) {
    case "hero":
      return (
        <div style={grid()}>
          <Field label="Heading" value={section.heading ?? ""} onChange={(v) => onChange({ heading: v })} />
          <Field label="Body" value={section.body ?? ""} onChange={(v) => onChange({ body: v })} multiline />
          <Field label="Background image URL" value={section.backgroundImage ?? ""} onChange={(v) => onChange({ backgroundImage: v })} />
          <Field label="CTA label" value={section.cta?.label ?? ""} onChange={(v) => onChange({ cta: { label: v, href: section.cta?.href ?? "/contact" } })} />
        </div>
      );
    case "text":
    case "callout":
      return (
        <div style={grid()}>
          {section.type === "text" && (
            <Field label="Heading" value={section.heading ?? ""} onChange={(v) => onChange({ heading: v })} />
          )}
          <Field label="Body" value={section.body ?? ""} onChange={(v) => onChange({ body: v })} multiline />
        </div>
      );
    case "banner":
      return (
        <div style={grid()}>
          <Field label="Heading" value={section.heading ?? ""} onChange={(v) => onChange({ heading: v })} />
          <Field label="Body" value={section.body ?? ""} onChange={(v) => onChange({ body: v })} />
        </div>
      );
    case "stats": {
      const items = (section.items ?? []) as Array<{ label?: string; value?: number; suffix?: string; prefix?: string }>;
      return (
        <div>
          <Field label="Heading" value={section.heading ?? ""} onChange={(v) => onChange({ heading: v })} />
          {items.map((it, i) => {
            const k = `stat-${i}`;
            return (
              <div key={i} style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr auto", gap: "0.4rem", marginTop: "0.4rem", alignItems: "center" }}>
                <input id={`${k}-label`} name={`${k}-label`} aria-label={`Stat ${i + 1} label`} placeholder="label" value={it.label ?? ""} onChange={(e) => updateItem(items, i, { label: e.target.value }, onChange)} style={input()} />
                <input id={`${k}-value`} name={`${k}-value`} aria-label={`Stat ${i + 1} value`} type="number" placeholder="value" value={String(it.value ?? "")} onChange={(e) => updateItem(items, i, { value: Number(e.target.value) || 0 }, onChange)} style={input()} />
                <input id={`${k}-prefix`} name={`${k}-prefix`} aria-label={`Stat ${i + 1} prefix`} placeholder="prefix" value={it.prefix ?? ""} onChange={(e) => updateItem(items, i, { prefix: e.target.value }, onChange)} style={input()} />
                <input id={`${k}-suffix`} name={`${k}-suffix`} aria-label={`Stat ${i + 1} suffix`} placeholder="suffix" value={it.suffix ?? ""} onChange={(e) => updateItem(items, i, { suffix: e.target.value }, onChange)} style={input()} />
                <button onClick={() => onChange({ items: items.filter((_, j) => j !== i) })} style={btnSmall("#c44")}>✕</button>
              </div>
            );
          })}
          <button onClick={() => onChange({ items: [...items, { label: "", value: 0 }] })} style={{ ...btnSmall(), marginTop: "0.5rem" }}>+ stat</button>
        </div>
      );
    }
    case "cards": {
      const items = (section.items ?? []) as Array<{ title?: string; body?: string; badge?: string; accent?: boolean }>;
      return (
        <div>
          <Field label="Heading" value={section.heading ?? ""} onChange={(v) => onChange({ heading: v })} />
          {items.map((it, i) => {
            const k = `card-${i}`;
            return (
              <div key={i} style={{ display: "grid", gridTemplateColumns: "1fr 2fr 1fr auto auto", gap: "0.4rem", marginTop: "0.4rem", alignItems: "center" }}>
                <input id={`${k}-title`} name={`${k}-title`} aria-label={`Card ${i + 1} title`} placeholder="title" value={it.title ?? ""} onChange={(e) => updateItem(items, i, { title: e.target.value }, onChange)} style={input()} />
                <input id={`${k}-body`} name={`${k}-body`} aria-label={`Card ${i + 1} body`} placeholder="body" value={it.body ?? ""} onChange={(e) => updateItem(items, i, { body: e.target.value }, onChange)} style={input()} />
                <input id={`${k}-badge`} name={`${k}-badge`} aria-label={`Card ${i + 1} badge`} placeholder="badge" value={it.badge ?? ""} onChange={(e) => updateItem(items, i, { badge: e.target.value }, onChange)} style={input()} />
                <label htmlFor={`${k}-accent`} style={{ fontSize: "0.7rem", color: "var(--wp-text-dim)" }}>
                  <input id={`${k}-accent`} name={`${k}-accent`} type="checkbox" checked={!!it.accent} onChange={(e) => updateItem(items, i, { accent: e.target.checked }, onChange)} /> accent
                </label>
                <button onClick={() => onChange({ items: items.filter((_, j) => j !== i) })} style={btnSmall("#c44")}>✕</button>
              </div>
            );
          })}
          <button onClick={() => onChange({ items: [...items, { title: "", body: "" }] })} style={{ ...btnSmall(), marginTop: "0.5rem" }}>+ card</button>
        </div>
      );
    }
    case "gallery": {
      const images = section.images ?? [];
      return (
        <div>
          <Field label="Heading" value={section.heading ?? ""} onChange={(v) => onChange({ heading: v })} />
          {images.map((img, i) => {
            const obj = typeof img === "string" ? { src: img, alt: "" } : img;
            const k = `gallery-${i}`;
            return (
              <div key={i} style={{ display: "grid", gridTemplateColumns: "2fr 2fr auto", gap: "0.4rem", marginTop: "0.4rem", alignItems: "center" }}>
                <input id={`${k}-src`} name={`${k}-src`} aria-label={`Image ${i + 1} URL`} placeholder="image url" value={obj.src} onChange={(e) => onChange({ images: images.map((x, j) => (j === i ? { src: e.target.value, alt: obj.alt } : x)) })} style={input()} />
                <input id={`${k}-alt`} name={`${k}-alt`} aria-label={`Image ${i + 1} alt text`} placeholder="alt text" value={obj.alt ?? ""} onChange={(e) => onChange({ images: images.map((x, j) => (j === i ? { src: obj.src, alt: e.target.value } : x)) })} style={input()} />
                <button onClick={() => onChange({ images: images.filter((_, j) => j !== i) })} style={btnSmall("#c44")}>✕</button>
              </div>
            );
          })}
          <button onClick={() => onChange({ images: [...images, { src: "", alt: "" }] })} style={{ ...btnSmall(), marginTop: "0.5rem" }}>+ image</button>
        </div>
      );
    }
    case "quote":
      return (
        <div style={grid()}>
          <Field label="Quote" value={section.body ?? ""} onChange={(v) => onChange({ body: v })} multiline />
          <Field label="Attribution" value={section.attribution ?? ""} onChange={(v) => onChange({ attribution: v })} />
        </div>
      );
  }
}

function updateItem<T>(items: T[], i: number, patch: Partial<T>, onChange: (p: { items: T[] }) => void) {
  onChange({ items: items.map((it, j) => (j === i ? { ...it, ...patch } : it)) });
}

function Field({ label, value, onChange, multiline, idPrefix }: { label: string; value: string; onChange: (v: string) => void; multiline?: boolean; idPrefix?: string }) {
  const reactId = useId();
  // Stable, DOM-unique id from the (optional) prefix + label + React
  // useId counter. Gives us `brief-${prefix}-${slug(label)}-:r1:` which
  // survives re-renders, composes across nested instances, and never
  // collides. The name attribute mirrors the id so Chrome's form-field
  // warning shuts up.
  const fieldId = `brief-${idPrefix ?? "field"}-${slug(label)}-${reactId}`;
  return (
    <div style={{ display: "block" }}>
      <label htmlFor={fieldId} style={{ fontSize: "0.7rem", color: "var(--wp-text-dim)", marginBottom: "0.2rem", textTransform: "uppercase", letterSpacing: "0.05em", display: "block" }}>{label}</label>
      {multiline ? (
        <textarea id={fieldId} name={fieldId} value={value} onChange={(e) => onChange(e.target.value)} style={{ ...input(), minHeight: "60px", fontFamily: "inherit" }} />
      ) : (
        <input id={fieldId} name={fieldId} value={value} onChange={(e) => onChange(e.target.value)} style={input()} />
      )}
    </div>
  );
}

function input(): React.CSSProperties {
  return { width: "100%", padding: "0.45rem 0.6rem", background: "var(--wp-dark)", border: "1px solid var(--wp-border)", borderRadius: "5px", color: "var(--wp-text)", fontSize: "0.85rem" };
}
function card(): React.CSSProperties {
  return { padding: "0.75rem", background: "var(--wp-card)", border: "1px solid var(--wp-border)", borderRadius: "6px" };
}
function grid(): React.CSSProperties {
  return { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.5rem" };
}
function btn(): React.CSSProperties {
  return { padding: "0.4rem 0.8rem", background: "var(--wp-card)", color: "var(--wp-text)", border: "1px solid var(--wp-border)", borderRadius: "5px", fontSize: "0.75rem", cursor: "pointer" };
}
function btnSmall(color = "var(--wp-text)"): React.CSSProperties {
  return { padding: "0.25rem 0.5rem", background: "var(--wp-card)", color, border: "1px solid var(--wp-border)", borderRadius: "4px", fontSize: "0.7rem", cursor: "pointer" };
}
