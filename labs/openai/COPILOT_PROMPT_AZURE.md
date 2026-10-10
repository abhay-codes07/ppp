# Copilot prompt: Azure OpenAI with a service principal for the PetriFlow labs

Paste everything below the line into GitHub Copilot Chat (agent mode) with the repo open.

---

You are working in the petri-flow repository: a Bun + TypeScript monorepo. Goal: let the
scripts in `labs/openai/` talk to **Azure OpenAI authenticated with a Microsoft Entra ID
service principal**, with the smallest possible change. Do NOT modify anything under
`packages/`, `workflows/`, `apps/`, `site/`, `comparisons/` or `examples/`. The PetriFlow
gate and engine are provider-agnostic; only the place where the model object is built changes.

## Context you can rely on

- The labs use the Vercel AI SDK (`ai@6`). A model is a `LanguageModel` object; the gate never
  sees it. `labs/openai/_model.ts` builds the model in `getModel(plan)`. Three scripts still
  call `createOpenAI` directly: `00-check-key.ts`, `03-server.ts`, `04-decision-provider.ts`.
- `@ai-sdk/azure@3` exports `createAzure(options)`. Relevant options: `baseURL`, `apiKey`,
  `tokenProvider: () => Promise<string>` (called on every request; the SDK adds
  `Authorization: Bearer <token>`). `apiKey` and `tokenProvider` must not both be set.
  A base URL ending in `/openai/v1` is used as-is. `createAzure(...)("<deployment>")` returns
  the model; the id is the Azure **deployment name**, not the model family.
- `@azure/identity` exports `DefaultAzureCredential` (reads `AZURE_TENANT_ID`,
  `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` or `AZURE_CLIENT_CERTIFICATE_PATH`, and falls back
  to `az login`) and `getBearerTokenProvider(credential, scope)` which returns a cached,
  auto-refreshing `() => Promise<string>`. Scope: `https://cognitiveservices.azure.com/.default`.

## Steps

1. At the repo root run: `bun add @ai-sdk/azure@^3 @azure/identity`
2. Edit `labs/openai/_model.ts`:
   a. Add imports: `createAzure` from `@ai-sdk/azure`; `DefaultAzureCredential` and
      `getBearerTokenProvider` from `@azure/identity`.
   b. `export const AZURE_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT;`
      `export const PROVIDER: "mock" | "azure" | "openai" =
        MOCK ? "mock" : AZURE_ENDPOINT ? "azure" : "openai";`
   c. `MODEL_ID`: in azure mode use `process.env.AZURE_OPENAI_DEPLOYMENT ?? ""`, otherwise keep
      `process.env.OPENAI_MODEL ?? "gpt-4o-mini"`.
   d. `export function azureTokenProvider()` returning
      `getBearerTokenProvider(new DefaultAzureCredential(), process.env.AZURE_OPENAI_SCOPE ??
      "https://cognitiveservices.azure.com/.default")`.
   e. `export function azureBaseURL(endpoint: string): string`: strip trailing slashes; if the
      URL has an empty path, append `/openai/v1`; otherwise return it unchanged (gateways and
      full `/openai/v1` URLs pass through).
   f. `export function realModel(): LanguageModel`:
      - azure: if `MODEL_ID` is empty, print "AZURE_OPENAI_DEPLOYMENT is not set" and exit(1).
        If `AZURE_OPENAI_API_KEY` is set use `createAzure({ baseURL, apiKey })`, else
        `createAzure({ baseURL, tokenProvider: azureTokenProvider() })`. Return `azure(MODEL_ID)`.
      - openai: unchanged behaviour (exit with a message if `OPENAI_API_KEY` is missing;
        mention `AZURE_OPENAI_ENDPOINT` and `MOCK=1` as alternatives).
   g. `getModel(plan)` becomes `MOCK ? scriptedModel(plan) : realModel()`.
   h. `export function describeMode(): string` returning one line, e.g.
      "MOCK (scripted model, no network)",
      "REAL (Azure OpenAI, deployment <name>, service principal (Entra ID))",
      "REAL (OpenAI gpt-4o-mini)". `banner()` prints `mode: ${describeMode()}`.
   i. `explainError`: read status from `e.statusCode ?? e.status`. Add branches:
      - message contains `AADSTS\d+` or `CredentialUnavailable`/`EnvironmentCredential`:
        say Entra login failed, name the AADSTS code, tell the user to check the three
        AZURE_* variables or run `az login --service-principal`. Special-case AADSTS7000215
        (bad secret), AADSTS700016 (client id not in tenant), AADSTS90002 (tenant not found).
      - 401/403 in azure mode: with `AZURE_OPENAI_API_KEY` say the key or endpoint is wrong;
        otherwise say the principal needs the role "Cognitive Services OpenAI User" on the
        resource.
      - 404 in azure mode: say to check `AZURE_OPENAI_DEPLOYMENT` (exact deployment name) and
        `AZURE_OPENAI_ENDPOINT`.
      - keep the existing OpenAI branches and the network branch (add `getaddrinfo`).
3. Rewrite `labs/openai/00-check-key.ts`: print `describeMode()`; in azure mode print the
   endpoint, the normalised base URL, the deployment, masked tenant and client ids (first 4 and
   last 4 characters) and whether the secret is set, never its value. Exit if the deployment is
   missing. In service-principal mode first call `await azureTokenProvider()()` and print
   "entra token: OK" with the token length and elapsed ms (on failure: `explainError`, exit 1).
   Then one `generateText({ model: realModel(), prompt: "Reply with exactly the two letters: OK" })`
   and print reply, elapsed ms and `r.usage.inputTokens` / `outputTokens`.
   In openai mode keep the old behaviour. With `MOCK=1` print a note and exit 1.
4. Edit `labs/openai/03-server.ts` and `labs/openai/04-decision-provider.ts`:
   - delete the `createOpenAI` import; import `realModel` (and `describeMode` in 03) from
     `./_model` instead of `MODEL_ID`;
   - replace `createOpenAI({ apiKey: process.env.OPENAI_API_KEY ?? "" })(MODEL_ID)` with
     `realModel()`;
   - replace the `if (!MOCK && !process.env.OPENAI_API_KEY) {...exit...}` guard with
     `if (!MOCK) realModel(); // fail fast if the provider config is missing`;
   - in 03, the GET / health response uses `mode: describeMode()`.
5. Do not touch `01-file-agent.ts`, `02-deploy-agent.ts`, `03-client.ts`.
6. Update `labs/openai/README.md`: provider order (MOCK, then AZURE_OPENAI_ENDPOINT, then
   OpenAI) and the Azure variables: `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_DEPLOYMENT`,
   `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, optional
   `AZURE_OPENAI_API_KEY`, optional `AZURE_OPENAI_SCOPE`; note the required role.

## Constraints

- Keep every line under 100 characters. Keep `MOCK=1` behaviour identical.
- Never print, log or write a secret. No new files. No changes outside `labs/openai/`,
  `package.json` and `bun.lock`.
- Show me the full diff before applying it.

## Acceptance (run all of these; all must pass)

```bash
bunx tsc --noEmit --strict --skipLibCheck --target es2022 --module esnext \
  --moduleResolution bundler --types bun --allowImportingTsExtensions labs/openai/*.ts
MOCK=1 bun run labs/openai/01-file-agent.ts                 # ends with "blocked calls: 2"
MOCK=1 AUTO_APPROVE=1 bun run labs/openai/02-deploy-agent.ts
MOCK=1 bun run labs/openai/04-decision-provider.ts          # ends with "status":"completed"
# wiring test with FAKE credentials: must fail with AADSTS90002 and the friendly explanation
AZURE_OPENAI_ENDPOINT=https://x.openai.azure.com AZURE_OPENAI_DEPLOYMENT=d \
AZURE_TENANT_ID=11111111-2222-3333-4444-555555555555 \
AZURE_CLIENT_ID=66666666-7777-8888-9999-000000000000 AZURE_CLIENT_SECRET=x \
bun run labs/openai/00-check-key.ts
```
