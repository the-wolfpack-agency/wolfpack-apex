/**
 * Forcefield for the Web - public API.
 *
 * The deterministic foundation: classify an inbound web request, decide an
 * action under a watch-first posture, and generate invisible page traps. Pure
 * and I/O-free, so it drops into a middleware, an edge worker, or a route with
 * the site's config injected. The live adapters (event recording for the
 * dashboard, the network-edge enforcement seam) build ON this core; they are
 * not part of it.
 */
export {
  classifyWebRequest,
  type WebRequest,
  type WebClass,
  type WebVerdict,
  type KnownAgent,
  type SiteForcefieldConfig,
} from "./classify";
export {
  decideWebAction,
  type WebPosture,
  type WebAction,
  type WebPostureDecision,
} from "./posture";
export {
  makePageTrap,
  makePageTraps,
  TRAP_PATH_PREFIX,
  type PageTrap,
} from "./decoy";
export {
  observeRequest,
  type Observation,
  type ObserveInput,
  type ForcefieldEventType,
} from "./observe";
export {
  forcefieldMonitor,
  type MonitorRequestLike,
} from "./monitor";
export {
  fetchRuleset,
  coerceRuleset,
  DEFAULT_RULESET,
  type ForcefieldRuleset,
} from "./ruleset";
export {
  classifyClient,
  headerSignature,
  DEFAULT_TOOL_SIGNATURES,
  type ClientType,
  type ClientFingerprint,
  type ToolSignature,
} from "./fingerprint";
