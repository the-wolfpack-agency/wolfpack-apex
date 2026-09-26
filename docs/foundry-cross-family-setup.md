# Cross-family model judging with Azure AI Foundry

Goal: run the code factory's independent judge (and, optionally, an executor
tier) on a **different model family** than the one that wrote the code, while
staying **inside the Azure boundary** (one tenant, one DPA, no external vendor).

Today the deployment has only Azure OpenAI models (`gpt-4o`, `gpt-4o-mini`),
which are the **same family** (OpenAI lineage). The judge correctly refuses to
let one OpenAI model grade another. Adding a genuinely different family
(DeepSeek or Llama, served by Azure AI Foundry) makes cross-family judging real.

## How it is wired (so the config below is the whole job)

- A Foundry serverless model is an **OpenAI-compatible** chat endpoint, so it is
  added through the router's compatible-provider convention (`AI_COMPAT_*`), the
  designed "add a vendor by configuration" path. No code change.
- The judge already recognizes `deepseek` and `llama` as distinct lineages, and
  already includes compatible providers as judge candidates, so once configured
  it is selected automatically as the independent judge for an OpenAI-lineage
  author.
- The compatible caller now speaks the Azure AI Inference format (the
  `/models/chat/completions?api-version=...` path) for `*.services.ai.azure.com`
  hosts, so the endpoint answers rather than returning 400.

> Note: the `AZURE_FOUNDRY_DEPLOYMENT_*` / `AZURE_AI_FOUNDRY_*` variables that
> appear elsewhere feed only the model-availability and health checks, not the
> caller. Use the `AI_COMPAT_*` variables below to actually route traffic.

## Step 1 - deploy a non-OpenAI model in Azure AI Foundry

1. Go to <https://ai.azure.com> and sign in with the account on the Wolfpack
   Azure subscription.
2. Open (or create) a **Project** - Foundry needs a hub/project; "Create
   project" provisions both.
3. Left nav -> **Model catalog** -> search **DeepSeek-V3** (or **Llama 3.3 70B
   Instruct**).
4. Open the model -> **Deploy** -> **Serverless API** (pay-as-you-go /
   Models-as-a-Service) -> name the deployment (e.g. `DeepSeek-V3`) -> agree to
   terms -> **Deploy**.

## Step 2 - collect three values

From the deployment page (My assets -> Models + endpoints -> your deployment):

| Value | Looks like |
|---|---|
| **Target URI / Endpoint** | `https://<resource>.services.ai.azure.com` (may show `.../models`) |
| **Key** (primary) | a long secret |
| **Model name** | what the endpoint expects in the request, e.g. `DeepSeek-V3` |

## Step 3 - set the environment variables

Provider id `foundry` (any lowercase id works; it only names the env vars):

```
AI_COMPAT_PROVIDERS=foundry
AI_COMPAT_FOUNDRY_BASE_URL=https://<resource>.services.ai.azure.com
AI_COMPAT_FOUNDRY_API_KEY=<primary key>

# Map the model to the tier the JUDGE runs at (cheap). Mapping a tier is what
# makes it a candidate at that tier; the judge runs at the cheap tier.
AI_COMPAT_FOUNDRY_MODEL_CHEAP=DeepSeek-V3

# Pricing (USD per 1k tokens). Optional but recommended so cost is reported, not
# guessed. DeepSeek-V3 list at time of writing:
AI_COMPAT_FOUNDRY_INPUT_PER_1K_CHEAP=0.00114
AI_COMPAT_FOUNDRY_OUTPUT_PER_1K_CHEAP=0.00456
```

Optional - also expose it as an executor tier (so the capability ladder can
author with it, not just judge with it): add `AI_COMPAT_FOUNDRY_MODEL_STANDARD`
/ `_PREMIUM` with matching pricing.

### Where to put them

- **Local:** append the lines to `.env.local` (next to the other Azure keys).
- **Vercel:** project `wolfpack-instinct` -> **Settings -> Environment
  Variables** -> add each for **Production + Preview**, then redeploy (it
  auto-deploys on the next push, or use Redeploy).

## Step 4 - verify

Local, against the live models:

```
npm run factory:ladder     # authors + executes a task cheapest-first
npm run a2a:proof          # cross-family handoff + independent judge
```

- In `a2a:proof`, with an OpenAI-lineage executor (Azure `gpt-4o`) and no
  Anthropic key configured, the independent judge should now resolve to
  **deepseek** (the Foundry model), and the judged leg should complete rather
  than degrade to "no independent judge."
- The router probe at `/admin/ai-router` should list the `foundry` provider as
  reachable.

If a call returns HTTP 400, re-check that `AI_COMPAT_FOUNDRY_BASE_URL` is the
`*.services.ai.azure.com` host (the caller adds the `/models/chat/completions`
path and the `api-version` query itself).
