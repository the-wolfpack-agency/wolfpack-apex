/**
 * products.ts: the Wolfpack product catalog.
 *
 * Backs the /products page, a plain-language explanation of what each product
 * is, the value it delivers, and where its parts could be reused. This is
 * curated reference content (versioned in git, one source of truth) rather than
 * a user-generated entity, so it lives in code, not the database. The same
 * catalog powers the current-engagements view via each product's `status`.
 *
 * Descriptions are grounded in each product's own repository docs. Keep them
 * accurate and jargon-light; never overstate what is built.
 */

/** Where a product sits in its lifecycle. Drives the engagements view + a chip. */
export type ProductStatus = "live" | "in_flight" | "preview" | "platform" | "client";

export const STATUS_LABELS: Record<ProductStatus, string> = {
  live: "Live in production",
  in_flight: "In flight",
  preview: "Private preview",
  platform: "Foundation platform",
  client: "Client engagement",
};

export interface Product {
  /** Stable slug (also the anchor id on the page). */
  id: string;
  /** Display name. */
  name: string;
  /** Product area key, matches the /releases milestone area for cross-linking. */
  area: string;
  /** One-line positioning. */
  tagline: string;
  /** A short paragraph: what it is and the value it delivers. */
  summary: string;
  /** Three to four concrete value points. */
  highlights: string[];
  /** Who it is for. */
  audience: string;
  /** Where the product, or pieces of it, could be reused beyond its first use. */
  potentialUses: string[];
  /** Lifecycle status. */
  status: ProductStatus;
  /** Public URL of the live product, when one exists. Omitted when there is no
   *  public site to link (internal-only or not yet published). */
  url?: string;
}

/**
 * The catalog. Order is roughly by maturity (live first) so the page reads as a
 * confident tour of what the team has shipped.
 */
export const PRODUCTS: Product[] = [
  {
    id: "instinct",
    name: "Instinct",
    area: "Instinct",
    url: "https://wolfpack-instinct.vercel.app",
    tagline: "The agency's internal operating system",
    summary:
      "Instinct is the system the Wolfpack team runs on day to day: briefing, an AI assistant, knowledge, HR, clients, sites, and financials in one place. Its assistant answers from the company's own data first (email, calendar, documents, meetings) and only reaches for AI when it needs to, so answers stay grounded in what is actually true for the business.",
    highlights: [
      "One home for briefing, clients, HR, sites, knowledge, and financials",
      "An AI assistant grounded in your own Microsoft 365 data, not generic web answers",
      "Every action feeds a learning loop, so the system gets more useful over time",
    ],
    audience: "The whole Wolfpack team",
    potentialUses: [
      "The assistant, knowledge base, and learning 'Brain' pattern can power any company's internal operations hub",
      "The client, HR, and financial modules adapt to any professional-services firm that runs on Microsoft 365",
    ],
    status: "live",
  },
  {
    id: "auto",
    name: "Auto",
    area: "Auto",
    url: "https://wolfpack-auto.vercel.app",
    tagline: "A modern operating system for car dealerships",
    summary:
      "Wolfpack Auto is a full dealer operating system: inventory, leads, financing and F&I desking, service, accounting and payroll, and analytics, all in one multi-tenant platform. It gives independent and mid-market dealers the kind of end-to-end system usually reserved for the largest players.",
    highlights: [
      "Runs the whole dealership: inventory, leads, deals, service, accounting, and payroll",
      "Multi-tenant, so each dealer's data is isolated and secure",
      "Turns everyday activity into analytics that tell staff what to do next, in plain dealership language",
    ],
    audience: "Dealership operators: GM, sales, F&I, service, and accounting",
    potentialUses: [
      "The same engine adapts to other high-consideration retail: marine, RV, powersports, equipment, and luxury goods",
      "Individual modules stand on their own: the lead-scoring and follow-up engine, the accounting and payroll ledger, and the feed-ingest layer that normalizes messy data from any source",
    ],
    status: "in_flight",
  },
  {
    id: "agenticqa",
    name: "AgenticQA",
    area: "AgenticQA",
    tagline: "A trust and safety layer for AI systems",
    summary:
      "AgenticQA makes AI systems safe to ship and defensible to auditors. It hardens them against attacks, keeps a forensic record of every decision, checks them against regulations such as HIPAA, GDPR, and the EU AI Act, and catches problems like prompt injection and model drift, all from a single starting point and without needing AI for the governance itself.",
    highlights: [
      "Red-team hardening and prompt-injection detection before problems reach users",
      "A forensic, cryptographically-provable record of what an AI system did and why",
      "Compliance mapping for HIPAA, GDPR, and the EU AI Act built in",
    ],
    audience: "Any team shipping AI, and the people who have to sign off on it",
    potentialUses: [
      "Any regulated industry putting AI into production (healthcare, finance, legal) needs this governance and audit layer",
      "The scanner, compliance mapper, and agent-safety modules can be dropped into other AI products individually",
    ],
    status: "live",
  },
  {
    id: "ogiam",
    name: "OGIAM",
    area: "OGIAM",
    url: "https://ogiam.com",
    tagline: "A dependable AI agent workforce",
    summary:
      "OGIAM runs production AI agents that are deterministic first, grounded in a company's own data, and cost-controlled. Agents follow a shared rulebook that is enforced by tooling rather than trusted to memory, and they are built to drop into a company's existing CRM and prove their value on real work.",
    highlights: [
      "Deterministic first: predictable, auditable behavior instead of a black box",
      "Governed by an enforced rulebook, so every agent follows the same rules",
      "Routes each task to the cheapest capable model to keep costs down",
    ],
    audience: "Businesses that want AI agents doing real work inside their existing systems",
    potentialUses: [
      "A drop-in agent workforce for any CRM or business system",
      "The deterministic decision gate, cost router, and rulebook can govern any other agent deployment",
    ],
    status: "live",
  },
  {
    id: "beyond",
    name: "Beyond",
    area: "Beyond",
    url: "https://beyond-sku.vercel.app",
    tagline: "A content and commerce operating system for brands",
    summary:
      "Beyond gives a brand one place to manage its products, author interactive guides, and run public storefronts, with AI image generation built in. New capabilities mount on a shared backbone, so the platform grows without rebuilding the foundation each time.",
    highlights: [
      "Product catalog, guide authoring, and public storefronts in one platform",
      "A shared backbone with per-product modules, so it scales cleanly",
      "AI image generation for product and marketing content",
    ],
    audience: "Brands managing catalogs, content, and direct-to-customer storefronts",
    potentialUses: [
      "The module-on-a-shared-backbone architecture fits any brand's content and commerce needs",
      "The Guides engine works on its own as a storefront or knowledge product, and the catalog and image pipeline suit any e-commerce or DTC brand",
    ],
    status: "in_flight",
  },
  {
    id: "porsche-weekend",
    name: "Porsche Weekend",
    area: "Porsche Weekend",
    url: "https://weekendwithporsche.com",
    tagline: "A Weekend with Porsche, run end to end",
    summary:
      "Porsche Weekend is the Porsche build of the Weekend platform, plus an Experience OS that lets Porsche Centers run the program themselves: inviting guests, managing their journey, sending communications, and seeing results. It is currently a private preview for Porsche.",
    highlights: [
      "The Porsche-branded 'A Weekend with Porsche' guest experience",
      "A dealer Experience OS: guest intake, journeys, communications, resources, and analytics",
      "Lets each Porsche Center run its own program with its own guests",
    ],
    audience: "Porsche and its Centers",
    potentialUses: [
      "A template for any OEM or brand-specific experiential program",
      "The dealer Experience OS can serve other franchise or dealer networks that run programs locally",
    ],
    status: "live",
  },
  {
    id: "lms",
    name: "LMS",
    area: "LMS",
    url: "https://wolfpack-lms.vercel.app",
    tagline: "Training that adapts to the learner",
    summary:
      "Wolfpack LMS is a learning platform with an AI tutor that answers from the course material rather than the open internet, works with standard training formats, and closes the loop with analytics that show what learners actually absorb.",
    highlights: [
      "An AI tutor grounded in the actual course content",
      "Works with industry-standard training formats (SCORM, cmi5)",
      "Closed-loop analytics that measure real learning outcomes",
    ],
    audience: "Any organization that trains staff, partners, or customers",
    potentialUses: [
      "Corporate onboarding and compliance training, dealer or staff certification, and customer-education academies",
      "The AI-tutor and standards-compliant course engine can power any training product",
    ],
    status: "in_flight",
  },
  {
    id: "aidan-mulready",
    name: "Aidan Mulready",
    area: "Aidan Mulready",
    url: "https://aidanmulready.com",
    tagline: "A client site on the agency's production-grade substrate",
    summary:
      "Aidan Mulready is a client site built on Wolfpack's reusable site template, which ships with quality and safety built in from day one: automated QA, safe canary deploys with auto-rollback, analytics, and content controls. It shows how quickly the agency can stand up a polished, resilient client presence.",
    highlights: [
      "Built on a reusable template, so new client sites launch fast",
      "Ships with automated QA, canary deploys, and auto-rollback out of the box",
      "Analytics and content controls included from the start",
    ],
    audience: "Agency clients who need a fast, reliable web presence",
    potentialUses: [
      "The template substrate spins up any new client site with the same safety rails in place",
      "Individual pieces (canary deploys with auto-rollback, content gating, the auto-generated docs) can be reused across any project",
    ],
    status: "live",
  },
];

/** The full catalog. A function so the API and any future filtering share one path. */
export function listProducts(): Product[] {
  return PRODUCTS;
}
