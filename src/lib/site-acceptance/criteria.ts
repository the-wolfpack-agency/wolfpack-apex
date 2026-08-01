/**
 * Acceptance criteria: the CONTRACT a generated site is measured against.
 *
 * WHY THIS EXISTS
 *
 * The wireframe path already works: drop an image or a PDF at /sites/new, get a
 * SiteBrief, scaffold a repo, deploy it. What was missing is the other half of
 * the loop. Nothing checked the deployed result against the thing it was built
 * from, so the operator did it by eye and re-prompted until it looked right. Two
 * costs follow from that. Every correction is a manual test cycle, and the
 * correction arrives as prose, which is the least reliable input a build can
 * take: two people describing the same requirement produce two different builds,
 * and the same person describing it twice does too.
 *
 * So the requirement stops being prose. It is this object: a fixed set of fields
 * with validated ranges, filled in on a form, stored with the project, and
 * evaluated by a machine. An operator can still be vague in a chat message; they
 * cannot be vague HERE, because a field is either a URL or it is not, and a
 * tolerance is either a number in range or it is rejected at the door.
 *
 * DESIGN RULES
 *
 *   - Every field has a default that means "check the thing everybody wants
 *     checked", so an operator who fills in nothing still gets a real gate.
 *   - Nothing here is advisory. If a criterion is present it is enforced, and an
 *     enforcement that could not run counts as a failure, never a pass (see
 *     evaluate.ts). Advisory checks train people to ignore results.
 *   - Pure: no database, no network, no clock. It parses and validates, so it is
 *     exercised by unit tests directly and reused unchanged by the API route,
 *     the cron runner and the UI.
 */

/** Viewport a comparison is measured at. Height matters as much as width: a hero
 *  sized in `vh` matches its prototype at one window height and not another. */
export interface AcceptanceViewport {
  width: number;
  height: number;
}

export interface AcceptanceCriteria {
  /**
   * The prototype the build must match, measured element by element. Optional
   * because plenty of intakes arrive as a wireframe image with no hosted
   * prototype; when it is absent the layout comparison is skipped and every
   * other check still runs.
   */
  prototypeUrl: string | null;
  /** Widths and heights the comparison runs at. */
  viewports: AcceptanceViewport[];
  /** Pixel slack per measured element before a difference counts. */
  tolerancePx: number;
  /**
   * Routes that must answer 2xx on the DEPLOYED site, as paths ("/", "/about").
   * A 200 is the bar, not "not a 500": an auth redirect or a 404 renders a blank
   * page to a client just as effectively as a crash does.
   */
  requiredRoutes: string[];
  /** Text that must appear in the deployed HTML (brand name, a legal line). */
  requiredContent: string[];
  /** Fail the build when the prototype's typeface is not the one being served. */
  requireFontParity: boolean;
  /**
   * Highest number of out-of-tolerance elements tolerated across all viewports.
   * Zero is the honest default; a conversion in progress can raise it
   * deliberately, which is a decision on the record rather than a silent pass.
   */
  maxLayoutDiffs: number;
}

export const DEFAULT_VIEWPORTS: AcceptanceViewport[] = [
  { width: 1512, height: 950 },
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
];

export const DEFAULT_CRITERIA: AcceptanceCriteria = {
  prototypeUrl: null,
  viewports: DEFAULT_VIEWPORTS,
  tolerancePx: 1.5,
  requiredRoutes: ["/"],
  requiredContent: [],
  requireFontParity: true,
  maxLayoutDiffs: 0,
};

/** Bounds. Wide enough for any real screen, narrow enough that a typo is caught
 *  at intake instead of becoming a browser that never starts. */
export const LIMITS = {
  minWidth: 320,
  maxWidth: 3840,
  minHeight: 400,
  maxHeight: 2400,
  maxViewports: 6,
  maxTolerancePx: 50,
  maxRoutes: 25,
  maxContent: 25,
  maxContentLength: 200,
  maxLayoutDiffs: 5000,
} as const;

export class CriteriaError extends Error {
  constructor(public readonly field: string, message: string) {
    super(message);
    this.name = "CriteriaError";
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function parseUrl(raw: unknown, field: string): string | null {
  if (raw == null || raw === "") return null;
  const value = String(raw).trim();
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CriteriaError(field, `${field} must be an absolute http(s) URL`);
  }
  // http(s) only. The runner additionally puts every URL through the shared SSRF
  // guard before navigating, so this is the shape check, not the safety check.
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new CriteriaError(field, `${field} must use http or https`);
  }
  return url.toString();
}

function parseViewports(raw: unknown): AcceptanceViewport[] {
  if (raw == null) return DEFAULT_VIEWPORTS;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new CriteriaError("viewports", "viewports must be a non-empty array");
  }
  if (raw.length > LIMITS.maxViewports) {
    throw new CriteriaError("viewports", `at most ${LIMITS.maxViewports} viewports`);
  }
  return raw.map((v) => {
    const width = Math.round(Number(isRecord(v) ? v.width : NaN));
    const height = Math.round(Number(isRecord(v) ? v.height : NaN));
    if (!Number.isFinite(width) || width < LIMITS.minWidth || width > LIMITS.maxWidth) {
      throw new CriteriaError("viewports", `viewport width must be ${LIMITS.minWidth} to ${LIMITS.maxWidth}`);
    }
    if (!Number.isFinite(height) || height < LIMITS.minHeight || height > LIMITS.maxHeight) {
      throw new CriteriaError("viewports", `viewport height must be ${LIMITS.minHeight} to ${LIMITS.maxHeight}`);
    }
    return { width, height };
  });
}

function parseStringList(raw: unknown, field: string, max: number, maxLength: number): string[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new CriteriaError(field, `${field} must be an array of strings`);
  if (raw.length > max) throw new CriteriaError(field, `at most ${max} ${field}`);
  const out: string[] = [];
  for (const item of raw) {
    const value = String(item ?? "").trim();
    if (!value) continue;
    if (value.length > maxLength) throw new CriteriaError(field, `each entry in ${field} must be under ${maxLength} characters`);
    if (!out.includes(value)) out.push(value);
  }
  return out;
}

/** Routes are paths, not URLs: they are resolved against whatever URL the deploy
 *  produced, so an intake cannot pin the check to a host that is not the build. */
function parseRoutes(raw: unknown): string[] {
  const list = parseStringList(raw, "requiredRoutes", LIMITS.maxRoutes, 512);
  if (list.length === 0) return ["/"];
  return list.map((r) => {
    if (/^https?:\/\//i.test(r)) {
      throw new CriteriaError("requiredRoutes", "requiredRoutes are paths like /about, not full URLs");
    }
    const path = r.startsWith("/") ? r : `/${r}`;
    if (path.includes("..")) throw new CriteriaError("requiredRoutes", "requiredRoutes must not contain ..");
    return path;
  });
}

/**
 * Validate and normalize whatever the form or the API sent. Throws CriteriaError
 * with the offending field so a route can answer 400 with something actionable,
 * rather than storing a half-valid criterion that fails opaquely at run time.
 */
export function parseCriteria(input: unknown): AcceptanceCriteria {
  if (input == null) return { ...DEFAULT_CRITERIA, viewports: [...DEFAULT_VIEWPORTS] };
  if (!isRecord(input)) throw new CriteriaError("criteria", "criteria must be an object");

  const tolerance = input.tolerancePx == null ? DEFAULT_CRITERIA.tolerancePx : Number(input.tolerancePx);
  if (!Number.isFinite(tolerance) || tolerance < 0 || tolerance > LIMITS.maxTolerancePx) {
    throw new CriteriaError("tolerancePx", `tolerancePx must be 0 to ${LIMITS.maxTolerancePx}`);
  }

  const maxLayoutDiffs = input.maxLayoutDiffs == null ? DEFAULT_CRITERIA.maxLayoutDiffs : Number(input.maxLayoutDiffs);
  if (!Number.isFinite(maxLayoutDiffs) || maxLayoutDiffs < 0 || maxLayoutDiffs > LIMITS.maxLayoutDiffs) {
    throw new CriteriaError("maxLayoutDiffs", `maxLayoutDiffs must be 0 to ${LIMITS.maxLayoutDiffs}`);
  }

  return {
    prototypeUrl: parseUrl(input.prototypeUrl, "prototypeUrl"),
    viewports: parseViewports(input.viewports),
    tolerancePx: tolerance,
    requiredRoutes: parseRoutes(input.requiredRoutes),
    requiredContent: parseStringList(input.requiredContent, "requiredContent", LIMITS.maxContent, LIMITS.maxContentLength),
    requireFontParity: input.requireFontParity == null ? DEFAULT_CRITERIA.requireFontParity : Boolean(input.requireFontParity),
    maxLayoutDiffs,
  };
}

/** How much of the contract an intake actually filled in, 0 to 1. Recorded with
 *  every run so "which intakes produce a first-pass-clean build" is answerable
 *  from data instead of memory. */
export function criteriaCompleteness(c: AcceptanceCriteria): number {
  const signals = [
    c.prototypeUrl != null,
    c.requiredRoutes.length > 1,
    c.requiredContent.length > 0,
    c.requireFontParity,
    c.viewports.length >= 2,
  ];
  return signals.filter(Boolean).length / signals.length;
}
