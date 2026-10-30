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
  withEnforcement,
  isStaticAsset,
  type Observation,
  type ObserveInput,
  type ForcefieldEventType,
  type EnforcementOutcome,
} from "./observe";
export {
  forcefieldMonitor,
  forcefieldGuard,
  isSyntheticMonitor,
  SYNTHETIC_HEADER,
  type MonitorRequestLike,
  type ForcefieldArgs,
} from "./monitor";
export {
  decideEnforcement,
  detectPayload,
  detectHeaderAttack,
  type EnforcementDecision,
  type BlockReasonKind,
} from "./enforce";
export { verifyAgentByRanges, type AgentVerification } from "./hosting";
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
export {
  detectCampaign,
  categorizeStep,
  type OperatorStep,
  type StepCategory,
  type CampaignSignature,
  type CampaignSignatureId,
  type CampaignVerdict,
  type CampaignOptions,
} from "./campaign";
export {
  stateChangeOf,
  accountabilityVerdict,
  applyPrincipalToAction,
  DEFAULT_STATE_CHANGE_RULES,
  type AccountabilityClass,
  type AccountabilityVerdict,
  type StateChangeRules,
  type ActionRoute,
} from "./accountability";
export { verifyAgentSignature, type AgentSignatureResult, type SignatureVerdict } from "./web-bot-auth";
