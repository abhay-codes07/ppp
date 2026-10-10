// Lab 1: a file-cleanup agent with two rules, driven by OpenAI (or the mock).
//   rehearse:  MOCK=1 bun run labs/openai/01-file-agent.ts
//   real:      OPENAI_API_KEY=sk-... bun run labs/openai/01-file-agent.ts
import { generateText, tool, stepCountIs } from "ai";
import { z } from "zod";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { compile } from "@petriflow/rules";
import { createPetriflowGate } from "@petriflow/vercel-ai";
import { getModel, banner, printSteps, explainError } from "./_model";

banner("Lab 1: file cleanup agent");

// A scratch folder with two files. Nothing outside it is touched.
const WORKDIR = process.env.WORKDIR ?? "C:/tmp/petriflow-lab";
await fs.rm(WORKDIR, { recursive: true, force: true }); // start clean every run
await fs.mkdir(WORKDIR, { recursive: true });
await fs.writeFile(join(WORKDIR, "temp.log"), "temporary log\n");
await fs.writeFile(join(WORKDIR, "old-backup.tar.gz"), "pretend archive\n");
console.log(`work folder: ${WORKDIR}`);

// 1. Rules -> verified nets.
const { nets, verification } = compile(`
  require backup before delete
  block rm
`);
console.log("rules verified:",
  verification.map((v) => `${v.name}=${v.reachableStates} states`).join(", "));

// 2. The gate. Tools that return { ok: false } count as failures.
const blocked: string[] = [];
const gate = createPetriflowGate(nets, {
  isToolResultError: (_name, result) => (result as any)?.ok === false,
  onDecision: (event, decision) => {
    if (decision?.block) {
      blocked.push(`${event.toolName}: ${decision.reason}`);
      console.log(`  [gate] BLOCKED ${event.toolName} -> ${decision.reason}`);
    } else {
      console.log(`  [gate] allow ${event.toolName}`);
    }
  },
});

// 3. Tools, wrapped. listFiles and readFile are free because no rule names them.
const session = gate.wrapTools({
  listFiles: tool({
    description: "List files in the work folder",
    inputSchema: z.object({}),
    execute: async () => ({ ok: true, files: await fs.readdir(WORKDIR) }),
  }),
  readFile: tool({
    description: "Read a file in the work folder",
    inputSchema: z.object({ name: z.string() }),
    execute: async ({ name }) => {
      const content = await fs.readFile(join(WORKDIR, name), "utf-8");
      return { ok: true, content };
    },
  }),
  backup: tool({
    description: "Copy a file to <name>.bak before changing it",
    inputSchema: z.object({ name: z.string() }),
    execute: async ({ name }) => {
      await fs.copyFile(join(WORKDIR, name), join(WORKDIR, name + ".bak"));
      return { ok: true, backedUp: name + ".bak" };
    },
  }),
  delete: tool({
    description: "Delete a file (a backup must succeed first)",
    inputSchema: z.object({ name: z.string() }),
    execute: async ({ name }) => {
      await fs.unlink(join(WORKDIR, name));
      return { ok: true, deleted: name };
    },
  }),
  rm: tool({
    description: "Force-remove a file",
    inputSchema: z.object({ name: z.string() }),
    execute: async ({ name }) => {
      await fs.rm(join(WORKDIR, name), { force: true });
      return { ok: true, removed: name };
    },
  }),
});

// 4. What the mock model does if MOCK=1 (a realistic path, including one mistake).
const model = getModel([
  { tool: "listFiles" },
  { tool: "delete", input: { name: "temp.log" } },      // blocked: no backup yet
  { tool: "backup", input: { name: "temp.log" } },
  { tool: "delete", input: { name: "temp.log" } },      // allowed now
  { tool: "rm", input: { name: "old-backup.tar.gz" } }, // always blocked
  { text: "Deleted temp.log after backing it up. "
        + "I cannot use rm: it is blocked by policy." },
]);

// 5. Run the agent loop.
const SYSTEM = "You are a careful file-cleanup agent. Use the tools. "
  + "If a tool is blocked, read the reason and adapt.\n\n" + session.systemPrompt();
const PROMPT = "Clean up the work folder: list the files, delete temp.log, "
  + "and rm old-backup.tar.gz.";

try {
  const result = await generateText({
    model,
    system: SYSTEM,
    tools: session.tools,
    stopWhen: stepCountIs(10),
    prompt: PROMPT,
  });
  printSteps(result);
  console.log("\n--- Gate summary ---");
  console.log(`blocked calls: ${blocked.length}`);
  for (const b of blocked) console.log("  " + b);
  console.log("final net state:", session.formatStatus().replace(/\n/g, " | "));
  console.log("files left:", await fs.readdir(WORKDIR));
} catch (e) {
  explainError(e);
  process.exit(1);
}
