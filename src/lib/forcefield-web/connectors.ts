/**
 * Forcefield connector catalog - the "works with your system" registry.
 *
 * A connector is the DOOR a tenant uses to put Forcefield in front of its site.
 * Detection, the blocklist, and verdicts all live centrally and are unchanged; a
 * connector only decides how a given site's requests reach the engine and which
 * tailored setup the client is shown. One engine, thin doors.
 *
 * This registry is the single source for:
 *   - the per-tenant platform choice (validated against these keys),
 *   - the platform-TAILORED quick-start (which env/snippet + steps to show),
 *   - the supported-platforms catalog surfaced in-product (and later on the
 *     marketing site), which is itself a sales asset.
 *
 * Deterministic by construction: this module imports no model client and makes no
 * network call, so it is safe inside the AI-containment boundary for forcefield-web.
 */

/** The supported connector doors. 'generic' is the stack-agnostic shim fallback. */
export type ConnectorKey = "hosted" | "vercel" | "cloudflare" | "wordpress" | "generic";

/** available = shippable today; coming_soon = cataloged but not yet installable. */
export type ConnectorStatus = "available" | "coming_soon";

export interface ConnectorMeta {
  key: ConnectorKey;
  title: string;
  /** Client-facing one-liner: what this door is and the promise. */
  description: string;
  status: ConnectorStatus;
  /** Which quick-start config surfaces are relevant to this platform. */
  emits: {
    /** Next.js middleware env + wiring snippet. */
    next: boolean;
    /** Cloudflare Worker env. */
    cloudflare: boolean;
  };
  /** True when WE operate the edge for this tenant (a site we host): there is
   *  nothing for the client to install, onboarding is a toggle on our side. */
  managed: boolean;
  /** Short, ordered, non-technical setup steps shown to the client. */
  steps: readonly string[];
}

/** The default door for a tenant with no explicit platform: the stack-agnostic
 *  shim, which preserves the historical both-adapters quick-start. */
export const DEFAULT_CONNECTOR: ConnectorKey = "generic";

export const CONNECTORS: readonly ConnectorMeta[] = [
  {
    key: "hosted",
    title: "Hosted by us",
    description: "A site we build and host. Protection is turned on from your console with one toggle - nothing to install.",
    status: "available",
    emits: { next: false, cloudflare: false },
    managed: true,
    steps: [
      "Nothing to install: we host this site, so Forcefield is wired in already.",
      "Turn protection on from your console. It starts in watch mode.",
      "Flip to enforce when you are ready; a benign visitor is never turned away.",
    ],
  },
  {
    key: "vercel",
    title: "Vercel / Next.js",
    description: "A site on Vercel. One-click install adds the edge middleware and your key - no code to write.",
    status: "available",
    emits: { next: true, cloudflare: false },
    managed: false,
    steps: [
      "Add your site key to the project's environment variables.",
      "Deploy. The edge middleware forwards request shape to the engine in watch mode.",
      "Set FORCEFIELD_ENFORCE=on when ready to block.",
    ],
  },
  {
    key: "cloudflare",
    title: "Cloudflare",
    description: "Any site behind Cloudflare. Enable the Worker module on the edge you already run - no origin changes.",
    status: "available",
    emits: { next: false, cloudflare: true },
    managed: false,
    steps: [
      "Add the Worker env (your key + origin) to your Cloudflare project.",
      "Deploy the Worker route. It runs monitor-first and fail-open.",
      "Set FORCEFIELD_ENFORCE=on when ready to block.",
    ],
  },
  {
    key: "wordpress",
    title: "WordPress",
    description: "A WordPress site. Install the plugin and paste your key - a setup wizard does the rest.",
    status: "coming_soon",
    emits: { next: false, cloudflare: false },
    managed: false,
    steps: [
      "Install the OGIAM Forcefield plugin from your WordPress admin.",
      "Paste your site key and save; watch mode turns on automatically.",
      "Enable blocking from the plugin when ready.",
    ],
  },
  {
    key: "generic",
    title: "Other / any stack",
    description: "Any other stack. Drop in the thin shim with your key; it works anywhere requests pass through an edge.",
    status: "available",
    emits: { next: true, cloudflare: true },
    managed: false,
    steps: [
      "Pick the adapter closest to your stack (Next.js middleware or Cloudflare Worker).",
      "Set the env with your key and deploy. It runs watch-first and fail-open.",
      "Set FORCEFIELD_ENFORCE=on when ready to block.",
    ],
  },
];

/** Catalog listing for a UI or the marketing site. Returns copies (never the
 *  frozen source rows) so a caller cannot mutate the registry. */
export function listForcefieldConnectors(): ConnectorMeta[] {
  return CONNECTORS.map((c) => ({ ...c, emits: { ...c.emits }, steps: [...c.steps] }));
}

/** Look up one connector by key, or undefined for an unknown key. */
export function connectorByKey(key: string): ConnectorMeta | undefined {
  const c = CONNECTORS.find((x) => x.key === key);
  return c ? { ...c, emits: { ...c.emits }, steps: [...c.steps] } : undefined;
}

/** Type guard: is this a supported connector key? Used to validate untrusted
 *  input (provision + set-platform) before it ever reaches the database. */
export function isConnectorKey(v: unknown): v is ConnectorKey {
  return typeof v === "string" && CONNECTORS.some((c) => c.key === v);
}
