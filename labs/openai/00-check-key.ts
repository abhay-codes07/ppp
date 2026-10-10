// Step 0: prove the credentials work and see how many tokens a tiny call costs.
//   OpenAI : OPENAI_API_KEY=sk-... bun run labs/openai/00-check-key.ts
//   Azure  : export AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_DEPLOYMENT,
//            AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET
//            bun run labs/openai/00-check-key.ts
import { generateText } from "ai";
import {
  PROVIDER, MODEL_ID, AZURE_ENDPOINT, azureBaseURL, azureTokenProvider,
  describeMode, realModel, explainError,
} from "./_model";

function mask(v: string | undefined) {
  return v ? `${v.slice(0, 4)}...${v.slice(-4)}` : "(not set)";
}

console.log(`mode: ${describeMode()}`);
if (PROVIDER === "azure") {
  console.log(`endpoint  : ${AZURE_ENDPOINT}  ->  ${azureBaseURL(AZURE_ENDPOINT!)}`);
  console.log(`deployment: ${MODEL_ID || "(not set)"}`);
  console.log(`tenant    : ${mask(process.env.AZURE_TENANT_ID)}`);
  console.log(`client id : ${mask(process.env.AZURE_CLIENT_ID)}`);
  console.log(`secret    : ${process.env.AZURE_CLIENT_SECRET ? "(set)" : "(not set)"}`);
  if (!MODEL_ID) {
    console.error("AZURE_OPENAI_DEPLOYMENT is not set. Ask the admin for the deployment name.");
    process.exit(1);
  }
  if (!process.env.AZURE_OPENAI_API_KEY) {
    // Step A: get a token from Entra ID. This proves tenant/client/secret.
    try {
      const t0 = Date.now();
      const token = await azureTokenProvider()();
      console.log(`entra token: OK, ${token.length} chars (${Date.now() - t0} ms)`);
    } catch (e) {
      explainError(e);
      process.exit(1);
    }
  }
} else if (PROVIDER === "openai") {
  console.log(`key: ${mask(process.env.OPENAI_API_KEY)}  model: ${MODEL_ID}`);
} else {
  console.log("MOCK=1 makes no sense here: this script exists to test real credentials.");
  process.exit(1);
}

// Step B: one tiny completion. This proves the role on the resource and the deployment name.
try {
  const t0 = Date.now();
  const r = await generateText({
    model: realModel(),
    prompt: "Reply with exactly the two letters: OK",
  });
  console.log(`reply: ${JSON.stringify(r.text)}  (${Date.now() - t0} ms)`);
  console.log(`tokens: input=${r.usage.inputTokens} output=${r.usage.outputTokens}`);
  console.log("Credentials work. You can run the other labs without MOCK=1.");
} catch (e) {
  explainError(e);
  process.exit(1);
}
