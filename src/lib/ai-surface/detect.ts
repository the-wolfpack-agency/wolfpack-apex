/**
 * AI Surface detectors — precision-first discovery of AI usage in source.
 *
 * Mirrors the platform-scan detector philosophy (src/lib/platform-scan/static/
 * detectors.ts): match KNOWN signatures only (named SDK modules, known provider
 * hostnames, provider key formats), never a generic "ai"/"gpt" regex that would
 * flood the inventory with noise. Each detector is a pure function over one
 * SourceFile returning AiSurface[]. False positives erode the whole "here is
 * every AI touchpoint" claim, so the bar is signature-grade.
 */
import type { AiSurface, AiSurfaceRisk } from "./types";

export interface SourceFile {
  path: string;
  content: string;
}

/** Known LLM SDK module specifiers -> provider slug. Import/require of one of
 *  these is a direct AI integration. */
const SDK_MODULES: ReadonlyArray<{ re: RegExp; provider: string }> = [
  { re: /@anthropic-ai\/sdk|(?:^|['"\s])anthropic(?:['"\s])/, provider: "anthropic" },
  { re: /@azure\/openai|openai\.azure\.com/, provider: "azure-openai" },
  { re: /(?:^|['"\s])openai(?:['"\s])|openai-node/, provider: "openai" },
  { re: /@google\/generative-ai|google-generativeai|@google-cloud\/vertexai|vertexai/, provider: "google" },
  { re: /@langchain\/|(?:^|['"\s])langchain(?:['"\s])/, provider: "langchain" },
  { re: /(?:^|['"\s])llamaindex(?:['"\s])|llama-index/, provider: "llamaindex" },
  { re: /(?:^|['"\s])cohere-ai(?:['"\s])|(?:^|['"\s])cohere(?:['"\s])/, provider: "cohere" },
  { re: /@mistralai\/|(?:^|['"\s])mistralai(?:['"\s])/, provider: "mistral" },
  { re: /(?:^|['"\s])groq-sdk(?:['"\s])|(?:^|['"\s])groq(?:['"\s])/, provider: "groq" },
  { re: /(?:^|['"\s])replicate(?:['"\s])/, provider: "replicate" },
  { re: /@huggingface\/|huggingface_hub/, provider: "huggingface" },
  { re: /(?:^|['"\s])ollama(?:['"\s])/, provider: "ollama" },
];

const IMPORT_LINE = /\b(?:import\b|require\s*\(|from\s+)/;

/** Known provider API hostnames -> provider slug. */
const PROVIDER_ENDPOINTS: ReadonlyArray<{ re: RegExp; provider: string }> = [
  { re: /api\.openai\.com/, provider: "openai" },
  { re: /[a-z0-9-]+\.openai\.azure\.com/, provider: "azure-openai" },
  { re: /api\.anthropic\.com/, provider: "anthropic" },
  { re: /generativelanguage\.googleapis\.com|aiplatform\.googleapis\.com/, provider: "google" },
  { re: /api\.cohere\.(?:ai|com)/, provider: "cohere" },
  { re: /api\.mistral\.ai/, provider: "mistral" },
  { re: /api\.groq\.com/, provider: "groq" },
  { re: /api\.replicate\.com/, provider: "replicate" },
  { re: /api-inference\.huggingface\.co/, provider: "huggingface" },
  { re: /api\.together\.(?:ai|xyz)/, provider: "together" },
];

/** Provider API-key signatures (reuses the precision-first secret philosophy:
 *  a real provider token format, never a generic high-entropy guess). */
export const KEY_SIGNATURES: ReadonlyArray<{ re: RegExp; provider: string }> = [
  { re: /\bsk-ant-[A-Za-z0-9_-]{24,}\b/, provider: "anthropic" },
  // Negative lookahead so an Anthropic key (sk-ant-...) is not double-counted as
  // OpenAI: sk-ant- is otherwise a syntactic subset of the OpenAI sk- format.
  { re: /\bsk-(?!ant-)(?:proj-)?[A-Za-z0-9_-]{32,}\b/, provider: "openai" },
  { re: /\bAIza[0-9A-Za-z_-]{35}\b/, provider: "google" },
];

function maskKey(match: string): string {
  return match.length <= 8 ? "****" : `${match.slice(0, 4)}…${match.slice(-2)}`;
}

function surface(
  kind: AiSurface["kind"],
  provider: string,
  file: string,
  line: number,
  risk: AiSurfaceRisk,
  evidence: Record<string, string | number | boolean | null>,
): AiSurface {
  return { kind, provider, location: `${file}:${line + 1}`, governed: false, risk, evidence };
}

/** Detect imports/requires of a known LLM SDK. */
export function aiSdkUsage(file: SourceFile): AiSurface[] {
  const out: AiSurface[] = [];
  const lines = file.content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!IMPORT_LINE.test(line)) continue;
    const seen = new Set<string>();
    for (const { re, provider } of SDK_MODULES) {
      if (seen.has(provider)) continue;
      if (re.test(line)) {
        seen.add(provider);
        out.push(surface("ai_sdk", provider, file.path, i, "medium", { snippet: line.trim().slice(0, 160) }));
      }
    }
  }
  return out;
}

/** Detect a hardcoded model-provider API endpoint. */
export function providerEndpoint(file: SourceFile): AiSurface[] {
  const out: AiSurface[] = [];
  const lines = file.content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const seen = new Set<string>();
    for (const { re, provider } of PROVIDER_ENDPOINTS) {
      if (seen.has(provider)) continue;
      const m = lines[i].match(re);
      if (m) {
        seen.add(provider);
        out.push(surface("provider_endpoint", provider, file.path, i, "medium", { host: m[0] }));
      }
    }
  }
  return out;
}

/** Detect a provider API key (precision-first signatures). Key exposure is the
 *  highest-risk AI surface: a leaked key is unmetered, ungoverned model access. */
export function aiApiKey(file: SourceFile): AiSurface[] {
  const out: AiSurface[] = [];
  const lines = file.content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const seen = new Set<string>();
    for (const { re, provider } of KEY_SIGNATURES) {
      if (seen.has(provider)) continue;
      const m = lines[i].match(re);
      if (m) {
        seen.add(provider);
        out.push(surface("api_key", provider, file.path, i, "critical", { hint: maskKey(m[0]) }));
      }
    }
  }
  return out;
}

const DETECTORS = [aiSdkUsage, providerEndpoint, aiApiKey];

/** Run every AI-surface detector over one file. */
export function detectAiSurfaces(file: SourceFile): AiSurface[] {
  return DETECTORS.flatMap((d) => d(file));
}
