# LLM labs for PetriFlow (OpenAI or Azure OpenAI)

Four runnable agents that drive the PetriFlow gate with a real model, plus a credentials check.
Every lab also runs with `MOCK=1`: a scripted fake model, no network, no cost.

Setup (once, at the repo root):
- `bun add @ai-sdk/openai@^3 @ai-sdk/azure@^3 @azure/identity`
- Revert later with `git checkout -- package.json bun.lock`.

Provider is chosen from the environment, in this order:
1. `MOCK=1`                    scripted model (no network)
2. `AZURE_OPENAI_ENDPOINT` set Azure OpenAI
3. otherwise                   OpenAI with `OPENAI_API_KEY`

Azure OpenAI with a service principal (what a company usually hands out):
- `AZURE_OPENAI_ENDPOINT`    e.g. `https://<resource>.openai.azure.com`
- `AZURE_OPENAI_DEPLOYMENT`  the deployment name the admin created (not the model family)
- `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`  the service principal
- optional `AZURE_OPENAI_API_KEY`  if you were given a key instead of a principal
- optional `AZURE_OPENAI_SCOPE`    default `https://cognitiveservices.azure.com/.default`
- The principal needs the role "Cognitive Services OpenAI User" on the resource.
- Alternative to the three AZURE_* auth vars: `az login --service-principal ...`
  (DefaultAzureCredential picks up the Azure CLI login).

OpenAI:
- `OPENAI_API_KEY`  required
- `OPENAI_MODEL`    default `gpt-4o-mini`

Other variables:
- `WORKDIR`         lab 1 scratch folder, default `C:/tmp/petriflow-lab`
- `PORT` / `BASE`   lab 3 server port (default 3456) and client base URL

Files:
- `_model.ts`               provider switch: getModel / realModel / scriptedModel
- `00-check-key.ts`         credentials work, token usage (real mode only)
- `01-file-agent.ts`        require backup before delete, block rm
- `02-deploy-agent.ts`      lint -> test -> deploy, human approval (y/n), limit 2
- `03-server.ts`            localhost server, per-request sessions, replay from history
- `03-client.ts`            sends three requests to the server
- `04-decision-provider.ts` the model picks transitions inside the workflow engine
- `03-spoof.ts`             forged history unlocks deploy (run against 03-server.ts)
- `azure.env.example`       template for ~/.petriflow-azure.env (copy OUTSIDE the repo)
- `../run-real.sh`          runs every demo and saves the output under results/ (MOCK=1 to rehearse)
- `../_redact.ts`           removes credential values from a results folder (run-real.sh calls it)

Rehearse for free:
- `MOCK=1 bun run labs/openai/01-file-agent.ts`
- `MOCK=1 AUTO_APPROVE=1 bun run labs/openai/02-deploy-agent.ts`
- `MOCK=1 bun run labs/openai/03-server.ts` then `bun run labs/openai/03-client.ts`
- `MOCK=1 bun run labs/openai/04-decision-provider.ts`

Real: export the variables for your provider, drop `MOCK=1`, start with `00-check-key.ts`.
