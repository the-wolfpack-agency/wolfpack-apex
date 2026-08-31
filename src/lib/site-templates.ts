/**
 * Sites — starter templates (Canva-style one-click picker).
 *
 * Pre-built briefs for non-technical team members (Max, Meghan) to start
 * from instead of filling out every section from scratch. Every template
 * is a realiztic `SiteBrief` that passes `validateBrief()` end-to-end
 * and shows off a mix of section types the platform supports.
 *
 * Contract:
 *   - `SITE_TEMPLATES` — single source of truth; freeze by convention.
 *   - `listTemplates()` — cheap metadata for the picker grid.
 *   - `getTemplateById()` — raw lookup; returns undefined on miss.
 *   - `applyTemplate(id, clientSlug)` — DEEP CLONE with `client` set to
 *     the given slug. Replaces `{{slug}}` placeholders (e.g. in the
 *     default product.domain) so the returned brief is ready to POST
 *     to `/api/sites` without further massaging. Returns null on miss.
 *
 * Do NOT mutate the exported template briefs. Callers always get a
 * deep clone. The tests in `__tests__/site-templates.test.ts` assert
 * this invariant holds for every template.
 */

import type { SiteBrief } from "@/lib/sites-schema";

export interface SiteTemplateMeta {
  id: string;
  name: string;
  description: string;
  thumbnail: string;
}

export interface SiteTemplate extends SiteTemplateMeta {
  /** The template brief. `client` is `"template"` and is overwritten by
   * `applyTemplate`. Any `{{slug}}` tokens in string fields are replaced
   * with the target client slug. */
  brief: SiteBrief;
}

// ---------------------------------------------------------------------------
// Templates
//
// Every template:
//   - uses `client: "template"` (overridden by applyTemplate)
//   - has product.name/tagline/domain (domain uses {{slug}} token)
//   - has at least 4 pages OR 4 sections on the home page
//   - uses a mix of section types — shows the platform's range
// ---------------------------------------------------------------------------

const PORTFOLIO: SiteTemplate = {
  id: "portfolio",
  name: "Creative Portfolio",
  description:
    "Photographer, designer, or writer. Hero + gallery grid + testimonial + final CTA, plus a contact page.",
  thumbnail: "/templates/portfolio.svg",
  brief: {
    client: "template",
    product: {
      name: "Your Studio",
      tagline: "Work that speaks for itself.",
      domain: "{{slug}}.com",
      supportEmail: "hello@{{slug}}.com",
    },
    pages: [
      {
        route: "/",
        title: "Home",
        sections: [
          {
            type: "hero",
            heading: "Portfolio that wins briefs.",
            body: "Selected work from the last two years. Photography, brand, and editorial.",
            cta: { label: "Start a project", href: "/contact" },
          },
          {
            type: "gallery",
            heading: "Selected work",
            images: [
              { src: "/portfolio/work-1.jpg", alt: "Project one — replace this placeholder" },
              { src: "/portfolio/work-2.jpg", alt: "Project two — replace this placeholder" },
              { src: "/portfolio/work-3.jpg", alt: "Project three — replace this placeholder" },
              { src: "/portfolio/work-4.jpg", alt: "Project four — replace this placeholder" },
            ],
          },
          {
            type: "quote",
            body: "They turned a vague idea into the cleanest brand launch we've ever run. Worth every dollar.",
            attribution: "Jamie Ortiz, Founder, Parallel Studio",
          },
          {
            type: "callout",
            heading: "Have a project in mind?",
            body: "Happy to talk through scope, timing, and budget. Usually book 6–8 weeks out.",
            cta: { label: "Send a brief", href: "/contact" },
          },
        ],
      },
      {
        route: "/contact",
        title: "Contact",
        sections: [
          {
            type: "hero",
            heading: "Get in touch",
            body: "Tell me about the project and what you're hoping to achieve. I'll reply within two business days.",
          },
          {
            type: "text",
            heading: "What to include",
            body: "Project type, timeline, budget range, and any references that capture the feel you want.",
          },
        ],
      },
    ],
    contactForm: { fields: ["name", "email", "message"] },
  },
};

const RACING_TEAM: SiteTemplate = {
  id: "racing_team",
  name: "Racing Team",
  description:
    "Motorsport team / driver page. Hero + season stats + partner banner + cards + photo gallery + highlight reel.",
  thumbnail: "/templates/racing-team.svg",
  brief: {
    client: "template",
    product: {
      name: "Wolfpack Racing",
      tagline: "Chasing podiums, one apex at a time.",
      domain: "{{slug}}.com",
      supportEmail: "team@{{slug}}.com",
    },
    pages: [
      {
        route: "/",
        title: "Home",
        sections: [
          {
            type: "hero",
            heading: "#44 Alex Rivera — 2026 Season",
            body: "GT4 championship campaign. Following a breakout rookie year with a full-season title push.",
            cta: { label: "Follow the season", href: "/contact" },
          },
          {
            type: "stats",
            heading: "2025 season by the numbers",
            items: [
              { label: "Races", value: 18 },
              { label: "Podiums", value: 7 },
              { label: "Wins", value: 2 },
              { label: "Fastest laps", value: 4 },
              { label: "Championship points", value: 312 },
            ],
          },
          {
            type: "banner",
            heading: "Partner with us",
            body: "Brand visibility at 18 races across 3 series. Ask about paddock hospitality and co-branded content.",
            cta: { label: "Sponsorship deck", href: "/contact" },
          },
          {
            type: "cards",
            heading: "Inside the garage",
            items: [
              {
                title: "The Driver",
                body: "Alex Rivera — five years karting, two podiums in rookie GT4 season.",
              },
              {
                title: "The Car",
                body: "BMW M4 GT4 running on Pirelli slicks. Maintained in-house between rounds.",
              },
              {
                title: "The Team",
                body: "Four-person crew including chief engineer, data engineer, and two mechanics.",
              },
            ],
          },
          {
            type: "gallery",
            heading: "From the paddock",
            images: [
              { src: "/racing/paddock-1.jpg", alt: "Car on grid — replace this placeholder" },
              { src: "/racing/paddock-2.jpg", alt: "Pit stop — replace this placeholder" },
              { src: "/racing/paddock-3.jpg", alt: "Podium — replace this placeholder" },
            ],
          },
          {
            type: "video",
            heading: "Season highlight reel",
            body: "Three minutes from Watkins Glen — the pole lap and final-corner pass for the win.",
            videoUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            provider: "youtube",
          },
        ],
      },
    ],
    contactForm: { fields: ["name", "email", "company", "message"] },
  },
};

const SERVICE_BUSINESS: SiteTemplate = {
  id: "service_business",
  name: "Local Service Business",
  description:
    "Plumber, electrician, or consulting firm. Hero + three services + trust stats + customer testimonial + estimate CTA, plus /services and /contact pages.",
  thumbnail: "/templates/service-business.svg",
  brief: {
    client: "template",
    product: {
      name: "Reliable Services",
      tagline: "Licensed, insured, and on time.",
      domain: "{{slug}}.com",
      supportEmail: "hello@{{slug}}.com",
    },
    pages: [
      {
        route: "/",
        title: "Home",
        sections: [
          {
            type: "hero",
            heading: "Expert help when you need it.",
            body: "Fully licensed team serving the metro area since 2008. Same-week appointments and no-surprise pricing.",
            cta: { label: "Get a free estimate", href: "/contact" },
          },
          {
            type: "cards",
            heading: "What we do",
            items: [
              {
                title: "Residential service",
                body: "Routine maintenance, urgent repairs, and small renovations for homes and condos.",
              },
              {
                title: "Commercial contracts",
                body: "Scheduled service agreements for offices, retail, and property managers.",
              },
              {
                title: "Emergency response",
                body: "24/7 on-call line for burst pipes, power loss, and other after-hours emergencies.",
              },
            ],
          },
          {
            type: "stats",
            heading: "Why customers stay",
            items: [
              { label: "Years in business", value: 18 },
              { label: "Customers served", value: 4200 },
              { label: "Same-week response rate", value: 98, suffix: "%" },
              { label: "5-star reviews", value: 640 },
            ],
          },
          {
            type: "quote",
            body: "Showed up when they said they would, fixed it right the first time, and the invoice matched the estimate. Rare combo.",
            attribution: "Priya Shah, longtime customer",
          },
          {
            type: "callout",
            heading: "Get a free estimate",
            body: "Tell us about the job and we'll get back to you within one business day with a clear quote.",
            cta: { label: "Request estimate", href: "/contact" },
          },
        ],
      },
      {
        route: "/services",
        title: "Services",
        sections: [
          {
            type: "hero",
            heading: "Full-service, honestly priced.",
            body: "From quick fixes to full installs — here's what we handle.",
          },
          {
            type: "cards",
            heading: "Popular services",
            items: [
              { title: "Diagnostic visit", body: "Flat-rate on-site assessment with written recommendations." },
              { title: "Repairs", body: "Parts and labor warrantied for one year on every repair we perform." },
              { title: "New installs", body: "Permit handling, code compliance, and manufacturer warranties." },
              { title: "Maintenance plans", body: "Priority scheduling and discounted rates for plan members." },
            ],
          },
        ],
      },
      {
        route: "/contact",
        title: "Contact",
        sections: [
          {
            type: "hero",
            heading: "Let's talk",
            body: "Call, email, or fill out the form. We reply within one business day.",
          },
          {
            type: "text",
            heading: "Hours",
            body: "Monday–Friday 8am–6pm. 24/7 emergency line for existing customers.",
          },
        ],
      },
    ],
    contactForm: { fields: ["name", "email", "phone", "message"] },
  },
};

export const SITE_TEMPLATES: readonly SiteTemplate[] = Object.freeze([
  PORTFOLIO,
  RACING_TEAM,
  SERVICE_BUSINESS,
]);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Cheap metadata for the picker grid. No brief payload. */
export function listTemplates(): SiteTemplateMeta[] {
  return SITE_TEMPLATES.map(({ id, name, description, thumbnail }) => ({
    id,
    name,
    description,
    thumbnail,
  }));
}

/** Raw lookup. Returns `undefined` on miss — prefer `applyTemplate` for
 * the full apply+clone flow. */
export function getTemplateById(id: string): SiteTemplate | undefined {
  return SITE_TEMPLATES.find((t) => t.id === id);
}

/**
 * Deep clone of the template's brief with `client` set to `clientSlug`
 * and every `{{slug}}` token replaced. Returned object is safe to mutate
 * without corrupting the template library.
 *
 * Returns `null` if the template id doesn't exist.
 */
export function applyTemplate(
  templateId: string,
  clientSlug: string,
): { brief: SiteBrief; display_name: string } | null {
  const tpl = getTemplateById(templateId);
  if (!tpl) return null;
  const cloned = deepClone(tpl.brief);
  substituteSlug(cloned, clientSlug);
  cloned.client = clientSlug;
  return { brief: cloned, display_name: cloned.product.name };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Structured-clone-style deep clone with no dependencies. `structuredClone`
 * exists in modern Node but ts-jest under our current config runs on a
 * CJS path where the global isn't always present — do it by hand and
 * avoid the flake. The brief is pure JSON (strings/numbers/arrays/nested
 * objects), so JSON round-trip is correct and lossless.
 */
function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Walk the cloned brief and replace every `{{slug}}` token in every
 * string field with the given slug. Numbers, booleans, and undefined
 * are left as-is. Exists so templates can point at the correct
 * apex domain without forcing callers to post-process.
 */
function substituteSlug(node: unknown, slug: string): void {
  if (node === null || typeof node !== "object") return;
  const record = node as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const v = record[key];
    if (typeof v === "string") {
      if (v.includes("{{slug}}")) {
        record[key] = v.replace(/\{\{slug\}\}/g, slug);
      }
    } else if (Array.isArray(v)) {
      for (const item of v) substituteSlug(item, slug);
    } else if (v !== null && typeof v === "object") {
      substituteSlug(v, slug);
    }
  }
}
