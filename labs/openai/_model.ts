// Shared helper for the LLM labs. Three ways to get a model, picked by env vars:
//
//   mock mode  : MOCK=1. A scripted fake model that returns the tool calls you give it.
//                No network, no key, no cost. Use it to rehearse a lab before paying.
//   azure mode : AZURE_OPENAI_ENDPOINT is set. Auth is a service principal
//                (AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET) via Entra ID,
//                or AZURE_OPENAI_API_KEY if you were given a key instead.
//   openai mode: otherwise. Needs OPENAI_API_KEY. Model from OPENAI_MODEL.
import { createOpenAI } from "@ai-sdk/openai";
import { createAzure } from "@ai-sdk/azure";
import { DefaultAzureCredential, getBearerTokenProvider } from "@azure/identity";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModel } from "ai";

export const MOCK = process.env.MOCK === "1";
export const AZURE_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT;
export const PROVIDER: "mock" | "azure" | "openai" =
  MOCK ? "mock" : AZURE_ENDPOINT ? "azure" : "openai";

// Azure: the "model" is the DEPLOYMENT NAME your admin created, not the model family.
export const MODEL_ID = PROVIDER === "azure"
  ? (process.env.AZURE_OPENAI_DEPLOYMENT ?? "")
  : (process.env.OPENAI_MODEL ?? "gpt-4o-mini");

// Token audience for Azure OpenAI. Rarely needs changing.
const AZURE_SCOPE = process.env.AZURE_OPENAI_SCOPE ?? "https://cognitiveservices.azure.com/.default";

export type PlanStep =
  | { tool: string; input?: Record<string, unknown> }
  | { text: string };

function usage(input: number, output: number) {
  return {
    inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: output, text: output, reasoning: 0 },
    raw: undefined,
  };
}

/** A fake model that replays a fixed plan: one step per model call. */
export function scriptedModel(plan: PlanStep[]): LanguageModel {
  let i = 0;
  return new MockLanguageModelV3({
    provider: "mock",
    modelId: "scripted",
    doGenerate: async () => {
      const step = plan[Math.min(i, plan.length - 1)]!;
      i++;
      if ("text" in step) {
        return {
          content: [{ type: "text", text: step.text }],
          finishReason: { unified: "stop", raw: undefined },
          usage: usage(0, 0),
          warnings: [],
        };
      }
      return {
        content: [{
          type: "tool-call",
          toolCallId: `mock-${i}`,
          toolName: step.tool,
          input: JSON.stringify(step.input ?? {}),
        }],
        finishReason: { unified: "tool-calls", raw: undefined },
        usage: usage(0, 0),
        warnings: [],
      };
    },
  }) as unknown as LanguageModel;
}

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

/** Entra ID token source. DefaultAzureCredential reads AZURE_TENANT_ID, AZURE_CLIENT_ID
 *  and AZURE_CLIENT_SECRET (or AZURE_CLIENT_CERTIFICATE_PATH), and falls back to
 *  `az login` if those are absent. Tokens are cached and refreshed automatically. */
export function azureTokenProvider() {
  return getBearerTokenProvider(new DefaultAzureCredential(), AZURE_SCOPE);
}

/** Normalise what the admin gave you into a base URL the AI SDK accepts.
 *  "https://foo.openai.azure.com" -> "https://foo.openai.azure.com/openai/v1"
 *  Anything with a path (gateway / APIM / already /openai/v1) is kept as-is. */
export function azureBaseURL(endpoint: string): string {
  const trimmed = endpoint.replace(/\/+$/, "");
  const path = new URL(trimmed).pathname.replace(/\/+$/, "");
  return path === "" ? `${trimmed}/openai/v1` : trimmed;
}

/** The real model for the current provider. Exits with a clear message if config is missing. */
export function realModel(): LanguageModel {
  if (PROVIDER === "azure") {
    if (!MODEL_ID) die("AZURE_OPENAI_DEPLOYMENT is not set (the deployment name, e.g. gpt-4o-mini).");
    const apiKey = process.env.AZURE_OPENAI_API_KEY;
    const azure = createAzure(apiKey
      ? { baseURL: azureBaseURL(AZURE_ENDPOINT!), apiKey }
      : { baseURL: azureBaseURL(AZURE_ENDPOINT!), tokenProvider: azureTokenProvider() });
    return azure(MODEL_ID);
  }
  const key = process.env.OPENAI_API_KEY;
  if (!key) die("OPENAI_API_KEY is not set. Export it, set AZURE_OPENAI_ENDPOINT, or run with MOCK=1.");
  return createOpenAI({ apiKey: key })(MODEL_ID);
}

/** Real model, or the scripted mock when MOCK=1. */
export function getModel(plan: PlanStep[]): LanguageModel {
  if (MOCK) return scriptedModel(plan);
  return realModel();
}

export function describeMode(): string {
  if (PROVIDER === "mock") return "MOCK (scripted model, no network)";
  if (PROVIDER === "azure") {
    const auth = process.env.AZURE_OPENAI_API_KEY ? "api key" : "service principal (Entra ID)";
    return `REAL (Azure OpenAI, deployment ${MODEL_ID || "?"}, ${auth})`;
  }
  return `REAL (OpenAI ${MODEL_ID})`;
}

export function banner(title: string) {
  console.log(`=== ${title} ===`);
  console.log(`mode: ${describeMode()}`);
  console.log("");
}

/** Print every step of a generateText result: tool calls, tool results, text. */
export function printSteps(result: { steps: any[]; text: string; usage?: any }) {
  console.log("\n--- Steps ---");
  result.steps.forEach((s, n) => {
    const parts: any[] = s.content ?? [];
    for (const p of parts) {
      if (p.type === "tool-call") {
        console.log(`${n + 1}. model called ${p.toolName}(${JSON.stringify(p.input)})`);
      } else if (p.type === "tool-result") {
        console.log(`   -> result: ${JSON.stringify(p.output).slice(0, 120)}`);
      } else if (p.type === "tool-error") {
        const msg = String(p.error?.message ?? p.error).slice(0, 140);
        console.log(`   -> ERROR returned to model: ${msg}`);
      } else if (p.type === "text" && p.text) {
        console.log(`   model said: ${p.text.slice(0, 200)}`);
      }
    }
  });
  console.log("\n--- Final answer ---");
  console.log(result.text || "(no text)");
  if (result.usage) {
    const u = result.usage;
    console.log(`\ntokens: input=${u.inputTokens ?? "?"} output=${u.outputTokens ?? "?"}`);
  }
}

/** Friendly explanation of common OpenAI / Azure errors. */
export function explainError(e: any) {
  const status = e?.statusCode ?? e?.status;
  const msg = String(e?.message ?? e);
  console.error("\nERROR:", msg.slice(0, 400));
  const aad = /AADSTS\d+/.exec(msg)?.[0];
  if (aad || /CredentialUnavailable|EnvironmentCredential/i.test(msg)) {
    console.error(`=> Entra ID login failed${aad ? ` (${aad})` : ""}.`);
    console.error("   Check AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET (all three),");
    console.error("   or run: az login --service-principal -u <clientId> -p <secret> --tenant <tenantId>");
    if (aad === "AADSTS7000215") console.error("   AADSTS7000215 = the client secret is wrong or expired.");
    if (aad === "AADSTS700016") console.error("   AADSTS700016 = client id not found in that tenant.");
    if (aad === "AADSTS90002") console.error("   AADSTS90002 = tenant id not found.");
  } else if (status === 401 || status === 403) {
    if (PROVIDER !== "azure") {
      console.error("=> The key is wrong or revoked. Check OPENAI_API_KEY.");
    } else if (process.env.AZURE_OPENAI_API_KEY) {
      console.error("=> Azure rejected the key. Check AZURE_OPENAI_API_KEY and AZURE_OPENAI_ENDPOINT.");
    } else {
      console.error("=> Entra issued a token but the resource refused it. The service principal needs\n"
        + "   the role 'Cognitive Services OpenAI User' on the Azure OpenAI resource (ask the admin).");
    }
  } else if (status === 429) {
    console.error("=> Rate limit or quota exhausted. Wait, or ask for more TPM on the deployment.");
  } else if (status === 404) {
    console.error(PROVIDER === "azure"
      ? `=> Not found. Is AZURE_OPENAI_DEPLOYMENT='${MODEL_ID}' the exact deployment name,\n`
        + `   and is AZURE_OPENAI_ENDPOINT the resource URL (${AZURE_ENDPOINT})?`
      : `=> Model '${MODEL_ID}' not found. Try OPENAI_MODEL=gpt-4o-mini.`);
  } else if (/ENOTFOUND|ECONNRESET|ETIMEDOUT|fetch failed|getaddrinfo/i.test(msg)) {
    console.error("=> Network. Set HTTPS_PROXY if your company uses a proxy; check the endpoint host.");
  }
}
