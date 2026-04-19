/**
 * Preview postMessage protocol — Stream P2 of Path C Phase 1.
 *
 * Strongly typed messages exchanged between the Sites edit page (parent
 * window) and the /sites/[id]/preview iframe (child window). The brief
 * remains the source of truth in the parent; the iframe emits intent
 * ("text.edit", "cta.edit", "hover") and the parent pushes the updated
 * brief back via "brief.push".
 *
 * Every message carries `origin: INSTINCT_EDIT_ORIGIN` so the listener
 * can distinguish Instinct messages from third-party ones (dev tools,
 * extensions, framework iframes, etc.). The listener MUST also verify
 * `event.origin === window.location.origin` AND
 * `event.source === expected window` before trusting the payload — see
 * the consumer code in `/sites/[id]/preview/page.tsx` and
 * `/(dashboard)/sites/[id]/edit/page.tsx` for the origin + source guards.
 *
 * Pure functions live here (no DOM, no React, no network) so the
 * protocol can be unit-tested without mounting a component.
 */

import type { SiteBrief } from "@/lib/sites-schema";

/** Brand used on every Instinct preview message. */
export const INSTINCT_EDIT_ORIGIN = "instinct.preview.v1" as const;

/**
 * Max postMessage payload size enforced before posting `brief.push`.
 * Large briefs fall back to the URL-hash draft reload path instead.
 * Browsers don't spec a hard cap, but Chrome's structured-clone limit
 * is in the hundreds of MB; 64KB is the product-side safety budget so
 * we never ship multi-megabyte messages per keystroke.
 */
export const MAX_POSTMESSAGE_BYTES = 64 * 1024;

export type TextField = "heading" | "body" | "tagline" | "quote" | "attribution";
export type CtaField = "label" | "href";

export type InlineEditMessage =
  | { origin: typeof INSTINCT_EDIT_ORIGIN; type: "ready" }
  | {
      origin: typeof INSTINCT_EDIT_ORIGIN;
      type: "text.edit";
      pageIndex: number;
      sectionIndex: number;
      field: TextField;
      /** Only set for testimonial items — which nested item was edited. */
      itemIndex?: number;
      value: string;
    }
  | {
      origin: typeof INSTINCT_EDIT_ORIGIN;
      type: "cta.edit";
      pageIndex: number;
      sectionIndex: number;
      field: CtaField;
      value: string;
    }
  | {
      origin: typeof INSTINCT_EDIT_ORIGIN;
      type: "brief.push";
      /** Source of truth lives in the parent; the iframe re-renders. */
      brief: unknown;
    }
  | {
      origin: typeof INSTINCT_EDIT_ORIGIN;
      type: "hover";
      pageIndex: number;
      sectionIndex: number;
      sectionType: string;
    };

/**
 * Runtime type guard. `event.data` arrives as `unknown` — we never trust
 * its shape without this check. Validates required fields per message
 * type so downstream handlers can destructure without optional chaining.
 */
export function isInstinctEditMessage(m: unknown): m is InlineEditMessage {
  if (!m || typeof m !== "object") return false;
  const obj = m as Record<string, unknown>;
  if (obj.origin !== INSTINCT_EDIT_ORIGIN) return false;
  const t = obj.type;
  if (typeof t !== "string") return false;
  switch (t) {
    case "ready":
      return true;
    case "text.edit": {
      return (
        typeof obj.pageIndex === "number" &&
        typeof obj.sectionIndex === "number" &&
        typeof obj.value === "string" &&
        typeof obj.field === "string" &&
        ["heading", "body", "tagline", "quote", "attribution"].includes(
          obj.field as string,
        ) &&
        (obj.itemIndex === undefined || typeof obj.itemIndex === "number")
      );
    }
    case "cta.edit": {
      return (
        typeof obj.pageIndex === "number" &&
        typeof obj.sectionIndex === "number" &&
        typeof obj.value === "string" &&
        (obj.field === "label" || obj.field === "href")
      );
    }
    case "brief.push":
      // brief is `unknown` by design — the consumer runs `validateBrief`
      // before merging. We just assert the envelope is well-formed.
      return "brief" in obj;
    case "hover": {
      return (
        typeof obj.pageIndex === "number" &&
        typeof obj.sectionIndex === "number" &&
        typeof obj.sectionType === "string"
      );
    }
    default:
      return false;
  }
}

/**
 * Deep-clone the subset of a brief we mutate in `applyInlineEdit` so we
 * never write through to the caller's object graph. Tree is small
 * (single page + section shell); JSON round-trip is fast and safe.
 */
function cloneBrief(brief: SiteBrief): SiteBrief {
  return JSON.parse(JSON.stringify(brief)) as SiteBrief;
}

/**
 * Apply a single text.edit or cta.edit message to a brief, returning a
 * new brief with the field updated. Out-of-range indexes or invalid
 * shapes return the ORIGINAL brief unchanged — never throws. The edit
 * page uses this directly; the preview page relies on the parent's
 * brief.push to sync the DOM rather than calling this itself.
 */
export function applyInlineEdit(
  brief: SiteBrief,
  msg: InlineEditMessage,
): SiteBrief {
  if (msg.type !== "text.edit" && msg.type !== "cta.edit") {
    return brief;
  }
  const pages = Array.isArray(brief.pages) ? brief.pages : [];
  if (msg.pageIndex < 0 || msg.pageIndex >= pages.length) {
    return brief;
  }
  const page = pages[msg.pageIndex];
  const sections = Array.isArray(page?.sections) ? page.sections : [];
  if (msg.sectionIndex < 0 || msg.sectionIndex >= sections.length) {
    return brief;
  }

  const next = cloneBrief(brief);
  const section = next.pages[msg.pageIndex].sections[msg.sectionIndex];

  if (msg.type === "text.edit") {
    switch (msg.field) {
      case "heading":
        section.heading = msg.value;
        break;
      case "body":
        // For testimonial items, "body" carries the quote; otherwise it's
        // the section-level body. We split via the itemIndex sentinel —
        // present → item-scoped; absent → section-scoped.
        if (typeof msg.itemIndex === "number" && Array.isArray(section.items)) {
          if (msg.itemIndex < 0 || msg.itemIndex >= section.items.length) {
            return brief;
          }
          section.items[msg.itemIndex].body = msg.value;
        } else {
          section.body = msg.value;
        }
        break;
      case "tagline":
        // tagline lives on brief.product, not on a section. We accept the
        // message only when sectionIndex 0 on pageIndex 0 AND the section
        // is a hero — the only place we surface tagline inline today.
        if (
          msg.pageIndex === 0 &&
          msg.sectionIndex === 0 &&
          section.type === "hero"
        ) {
          next.product = { ...next.product, tagline: msg.value };
        } else {
          return brief;
        }
        break;
      case "quote":
        if (typeof msg.itemIndex === "number" && Array.isArray(section.items)) {
          if (msg.itemIndex < 0 || msg.itemIndex >= section.items.length) {
            return brief;
          }
          section.items[msg.itemIndex].quote = msg.value;
        } else {
          // Quote section stores the pull quote in `body` (per schema);
          // callers addressing the quote section without itemIndex land
          // here — write through to body so the message works either way.
          section.body = msg.value;
        }
        break;
      case "attribution":
        if (typeof msg.itemIndex === "number" && Array.isArray(section.items)) {
          if (msg.itemIndex < 0 || msg.itemIndex >= section.items.length) {
            return brief;
          }
          const item = section.items[msg.itemIndex];
          // For testimonial items, attribution splits across authorName +
          // authorTitle. The overlay sends separate edits; here we treat
          // a free-form attribution write as authorName (the more load-
          // bearing field).
          item.authorName = msg.value;
        } else {
          section.attribution = msg.value;
        }
        break;
      // All TextField variants handled above. No default — an unknown
      // field would fail the `isInstinctEditMessage` guard before
      // reaching this function.
    }
  } else if (msg.type === "cta.edit") {
    if (!section.cta) {
      section.cta = { label: "", href: "" };
    }
    if (msg.field === "label") {
      section.cta.label = msg.value;
    } else {
      section.cta.href = msg.value;
    }
  }

  return next;
}

/**
 * Safe serializer for brief.push. Returns null when the encoded payload
 * exceeds `MAX_POSTMESSAGE_BYTES`; the caller falls back to the URL-hash
 * draft reload path in that case.
 */
export function encodeBriefPush(brief: unknown): string | null {
  try {
    const json = JSON.stringify({
      origin: INSTINCT_EDIT_ORIGIN,
      type: "brief.push",
      brief,
    });
    if (json.length > MAX_POSTMESSAGE_BYTES) return null;
    return json;
  } catch {
    return null;
  }
}

/**
 * Build a testimonial-item-scoped text.edit message. Split out so the
 * overlay doesn't have to know the exact field-to-item mapping.
 */
export function buildTestimonialEditMessage(args: {
  pageIndex: number;
  sectionIndex: number;
  itemIndex: number;
  field: "quote" | "attribution";
  value: string;
}): InlineEditMessage {
  return {
    origin: INSTINCT_EDIT_ORIGIN,
    type: "text.edit",
    pageIndex: args.pageIndex,
    sectionIndex: args.sectionIndex,
    itemIndex: args.itemIndex,
    field: args.field,
    value: args.value,
  };
}
