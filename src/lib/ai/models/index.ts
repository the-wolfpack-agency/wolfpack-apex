/**
 * src/lib/ai/models - public barrel for the cost-aware model registry + router.
 *
 * The agent runtime imports from here and never reaches into the individual
 * files. Mirrors the crypto registry's surface: data + pure resolvers
 * (registry), a pure selection function (router), and the typed shapes.
 */

export type {
  CapabilityTier,
  ModelProvider,
  ModelSelection,
  ModelSelectionLogContext,
  ModelSpec,
  SelectOptions,
} from "./types";

export {
  MODEL_REGISTRY,
  TIER_ORDER,
  getModel,
  isModelAvailable,
  listModels,
} from "./registry";

export {
  estimateCostUsd,
  logModelSelection,
  selectModel,
} from "./router";
