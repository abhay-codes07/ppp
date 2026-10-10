// Lab 4: the engine side. OpenAI chooses which transition fires at a choice point.
//   rehearse:  MOCK=1 bun run labs/openai/04-decision-provider.ts
//   real:      OPENAI_API_KEY=sk-... (or the AZURE_* vars) bun run labs/openai/04-decision-provider.ts
import { generateText, tool } from "ai";
import { z } from "zod";
import { Database } from "bun:sqlite";
import { Scheduler, createExecutor, sqliteAdapter } from "@petriflow/engine";
import type { DecisionProvider } from "@petriflow/engine/decision";
import { definition } from "../../workflows/simple-agent/definition";
import { MOCK, realModel, banner, explainError } from "./_model";

banner("Lab 4: OpenAI as the engine's decision provider");

type Provider = DecisionProvider<string, Record<string, unknown>>;

// The mock chooses 'iterate' while budget remains, then 'generate'.
const mockProvider: Provider = {
  async choose(req) {
    const names = req.enabled.map((t) => t.name);
    const budget = (req.marking as any).iterationBudget ?? 0;
    const pick = names.includes("iterate") && budget > 0 ? "iterate" : names[0]!;
    const reasoning = `mock: budget=${budget}, options=${names.join("/")}`;
    return { transition: pick, reasoning };
  },
};

// The real provider asks OpenAI to pick one enabled transition via a forced tool call.
const openaiProvider: Provider = {
  async choose(req) {
    const names = req.enabled.map((t) => t.name) as [string, ...string[]];
    const marking = Object.entries(req.marking)
      .filter(([, v]) => (v as number) > 0)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
    const enabled = req.enabled
      .map((t) => `${t.name} [${t.inputs}] -> [${t.outputs}]`)
      .join("; ");
    const result = await generateText({
      model: realModel(),
      system: `You control the workflow "${req.workflowName}". `
        + "Prefer to iterate once to gather more tool results, then generate. "
        + "Pick exactly one transition.",
      prompt: `Marking: ${marking}\nContext: ${JSON.stringify(req.context)}\n`
        + `Enabled: ${enabled}`,
      tools: {
        pickTransition: tool({
          description: "Choose the transition to fire next",
          inputSchema: z.object({ transition: z.enum(names), reasoning: z.string() }),
        }),
      },
      toolChoice: { type: "tool", toolName: "pickTransition" },
    });
    const input = result.toolCalls[0]!.input as any;
    return { transition: input.transition, reasoning: input.reasoning };
  },
};

if (!MOCK) realModel(); // fail fast if the provider config is missing

const db = new Database(":memory:");
const executor = createExecutor(definition as any, {
  decisionProvider: MOCK ? mockProvider : openaiProvider,
});
const scheduler = new Scheduler(executor, { adapter: sqliteAdapter(db, definition.name) }, {
  onDecision: (_id, name, reasoning, candidates) => {
    console.log(`  [llm] chose ${name} from [${candidates.join(", ")}]: ${reasoning}`);
  },
  onFire: (_id, name) => console.log(`fired: ${name}`),
  onComplete: (id) => console.log(`${id} completed`),
  onError: (_id, err) => explainError(err),
});

await scheduler.createInstance("agent-llm");
for (let i = 0; i < 40; i++) {
  const n = await scheduler.tick();
  if (n === 0) break;
}
const state = await scheduler.inspect("agent-llm");
console.log("\nfinal:", JSON.stringify({
  marking: state.marking,
  iteration: (state.context as any).iteration,
  status: state.status,
}));
