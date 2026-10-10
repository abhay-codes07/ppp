// Lab 2: a deployment agent with chained rules, a real human approval prompt, and a limit.
//   rehearse:  MOCK=1 AUTO_APPROVE=1 bun run labs/openai/02-deploy-agent.ts
//   real:      OPENAI_API_KEY=sk-... bun run labs/openai/02-deploy-agent.ts   (type y/n)
//   variant:   FAIL_TESTS=1 ...  makes the test tool fail, so deploy stays locked.
import { generateText, tool, stepCountIs } from "ai";
import { z } from "zod";
import { createInterface } from "node:readline";
import { compile } from "@petriflow/rules";
import { createPetriflowGate } from "@petriflow/vercel-ai";
import { getModel, banner, printSteps, explainError } from "./_model";

banner("Lab 2: deployment agent");

const { nets, verification } = compile(`
  require lint before test
  require test before deploy
  require human-approval before deploy
  limit deploy to 2 per session
`);
console.log("rules verified:",
  verification.map((v) => `${v.name}=${v.reachableStates}`).join(", "));

// Human approval: a terminal prompt, unless AUTO_APPROVE=1.
async function askApproval(title: string, message: string): Promise<boolean> {
  if (process.env.AUTO_APPROVE === "1") {
    console.log(`  [human] ${title} -> auto-approved (AUTO_APPROVE=1)`);
    return true;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`\n  [human] ${title}\n  ${message}\n  Approve? (y/n) `, (a) => {
      rl.close();
      resolve(a.trim().toLowerCase() === "y");
    });
  });
}

const gate = createPetriflowGate(nets, {
  isToolResultError: (_name, result) => (result as any)?.passed === false,
  confirm: askApproval,
  onDecision: (event, decision) => {
    const target = (event.input as any)?.environment;
    const env = target ? `(${target})` : "";
    console.log(decision?.block
      ? `  [gate] BLOCKED ${event.toolName}${env} -> ${decision.reason}`
      : `  [gate] allow ${event.toolName}${env}`);
  },
});

// Simulated pipeline. Nothing real is deployed anywhere.
const deployed: string[] = [];
const session = gate.wrapTools({
  lint: tool({
    description: "Run the linter",
    inputSchema: z.object({}),
    execute: async () => ({ passed: true, warnings: 0 }),
  }),
  test: tool({
    description: "Run the test suite",
    inputSchema: z.object({}),
    execute: async () => {
      const passed = process.env.FAIL_TESTS !== "1";
      return { passed, failed: passed ? 0 : 3 };
    },
  }),
  deploy: tool({
    description: "Deploy the current build to an environment",
    inputSchema: z.object({ environment: z.enum(["production", "staging"]) }),
    execute: async ({ environment }) => {
      deployed.push(environment);
      return { deployed: true, environment, version: `1.${deployed.length}.0` };
    },
  }),
  checkStatus: tool({
    description: "Check what is deployed where",
    inputSchema: z.object({}),
    execute: async () => ({ deployed }),
  }),
});

// Mock plan: tries to skip steps, gets corrected, hits the limit on the third deploy.
const model = getModel([
  { tool: "deploy", input: { environment: "production" } },  // blocked: no test
  { tool: "lint" },
  { tool: "test" },
  { tool: "deploy", input: { environment: "production" } },  // approval, then allowed
  { tool: "lint" },
  { tool: "test" },
  { tool: "deploy", input: { environment: "staging" } },     // allowed (2 of 2)
  { tool: "lint" },
  { tool: "test" },
  { tool: "deploy", input: { environment: "production" } },  // blocked: limit
  { text: "Deployed to production and staging. "
        + "A third deploy is blocked by the session limit." },
]);

const SYSTEM = "You are a deployment agent. Follow the pipeline rules. "
  + "If a tool is blocked, read the reason and do what it says.\n\n"
  + session.systemPrompt();
const PROMPT = "Deploy to production, then deploy to staging, "
  + "then deploy to production once more.";

try {
  const result = await generateText({
    model,
    system: SYSTEM,
    tools: session.tools,
    stopWhen: stepCountIs(16),
    prompt: PROMPT,
  });
  printSteps(result);
  console.log("\ndeployments that actually happened:", deployed);
  console.log("final net state:", session.formatStatus().replace(/\n/g, " | "));
} catch (e) {
  explainError(e);
  process.exit(1);
}
