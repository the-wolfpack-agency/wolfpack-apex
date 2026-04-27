/**
 * src/lib/ai — public barrel for the provider-neutral AI layer.
 *
 * Feature code should import getAIClient + the AICompleteRequest types
 * from here and never reach for a vendor SDK directly.
 */

export { getAIClient } from "./router";
export type {
  AIClient,
  AICompleteRequest,
  AICompleteResponse,
  AILatencyTarget,
  AIMessage,
  AIModelTier,
  AIProvider,
  AIRole,
  AISensitivity,
} from "./types";
export { NoProviderAvailableError, NotImplementedError } from "./types";
