/**
 * src/lib/ai/azure-openai-provider — STUB.
 *
 * This is the shape the router will route to once
 *   AZURE_OPENAI_ENDPOINT + AZURE_OPENAI_API_KEY are configured (BAA-
 *   covered path for PHI workloads). complete() throws today; the router
 *   only points traffic here once the env vars are present.
 *
 * Tier-to-deployment map is the contract the deployment names will
 * follow. Swap the body of complete() with a real fetch against
 *   POST {endpoint}/openai/deployments/{deployment}/chat/completions
 *      ?api-version=2024-08-01-preview
 * when the credentials land.
 */

import type {
  AICompleteRequest,
  AICompleteResponse,
  AIModelTier,
  AIProvider,
} from "./types";
import { NotImplementedError } from "./types";

const TIER_TO_DEPLOYMENT: Record<AIModelTier, string> = {
  cheap: "gpt-4o-mini-deployment",
  standard: "gpt-4o-deployment",
  premium: "gpt-4-turbo-deployment",
};

export function isAzureConfigured(): boolean {
  return Boolean(
    process.env.AZURE_OPENAI_ENDPOINT && process.env.AZURE_OPENAI_API_KEY,
  );
}

export class AzureOpenAIProvider implements AIProvider {
  readonly name = "azure-openai";

  supportsTier(_tier: AIModelTier): boolean {
    return true;
  }

  async complete(_req: AICompleteRequest): Promise<AICompleteResponse> {
    // Tagged with status 503 so the router treats this as a transient
    // upstream failure and falls back to Anthropic. When Azure ships
    // for real, replace this body with a chat/completions fetch.
    const err = new NotImplementedError(
      "Azure OpenAI provider stub. Implement when AZURE_OPENAI_ENDPOINT + AZURE_OPENAI_API_KEY are configured.",
    );
    (err as NotImplementedError & { status: number }).status = 503;
    throw err;
  }
}

export const AZURE_TIER_TO_DEPLOYMENT = TIER_TO_DEPLOYMENT;
