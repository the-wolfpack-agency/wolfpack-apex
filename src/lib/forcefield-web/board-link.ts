/**
 * Deep links into the Forcefield board (/admin/site-analytics, the "Agent
 * defense" tab), shared by the alert email (which builds them) and the board
 * page (which reads them on load). Pure and client-safe.
 *
 *   ?tab=forcefield        open the Agent defense tab
 *   &view=operator         the By-operator view (or severity)
 *   &find=<text>           prefill the operator finder: a session signature
 *                          (exact journey key), a target path or an operator key
 *   &days=7|30|90          the board range
 */
export const BOARD_PATH = "/admin/site-analytics";
export const BOARD_RANGES = [7, 30, 90] as const;

export interface BoardDeepLink {
  tab?: "usage" | "forcefield";
  view?: "operator" | "severity";
  find?: string;
  days?: (typeof BOARD_RANGES)[number];
}

/** Longest finder text accepted from a URL (a path or a key, never a payload). */
const MAX_FIND = 200;

/** The board path with the given deep-link params (relative; prefix a base URL
 *  for email). Params are emitted in a stable order. */
export function boardHref(link: BoardDeepLink = {}): string {
  const q = new URLSearchParams();
  if (link.tab) q.set("tab", link.tab);
  if (link.view) q.set("view", link.view);
  if (link.find) q.set("find", link.find.slice(0, MAX_FIND));
  if (link.days) q.set("days", String(link.days));
  const s = q.toString();
  return s ? `${BOARD_PATH}?${s}` : BOARD_PATH;
}

/** Parse a location.search string. Unknown or malformed values are dropped, so a
 *  crafted link can only ever select a known tab, view or range. */
export function parseBoardDeepLink(search: string): BoardDeepLink {
  const q = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const out: BoardDeepLink = {};
  const tab = q.get("tab");
  if (tab === "usage" || tab === "forcefield") out.tab = tab;
  const view = q.get("view");
  if (view === "operator" || view === "severity") out.view = view;
  const find = (q.get("find") ?? "").trim();
  if (find) out.find = find.slice(0, MAX_FIND);
  const days = Number(q.get("days"));
  if ((BOARD_RANGES as readonly number[]).includes(days)) out.days = days as BoardDeepLink["days"];
  return out;
}
