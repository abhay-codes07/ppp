// Lab 3: a localhost chat server. The gate is stateless; state comes from message history.
//   rehearse:  MOCK=1 bun run labs/openai/03-server.ts
//   real:      OPENAI_API_KEY=sk-... (or the AZURE_* vars) bun run labs/openai/03-server.ts
// Then, in a second Git Bash window:  bun run labs/openai/03-client.ts
import { generateText, tool, stepCountIs } from "ai";
import type { ModelMessage } from "ai";
import { z } from "zod";
import { compile } from "@petriflow/rules";
import { createPetriflowGate } from "@petriflow/vercel-ai";
import { MOCK, scriptedModel, realModel, describeMode, banner } from "./_model";

banner("Lab 3: localhost server with replay");
const PORT = Number(process.env.PORT ?? 3456);

// 1. Compile once at startup. The gate object holds no per-user state.
const { nets, verification } = compile(`
  require test before deploy
  limit deploy to 2 per session
`);
const gate = createPetriflowGate(nets, {
  isToolResultError: (_n, r) => (r as any)?.passed === false,
  onDecision: (event, decision) => {
    console.log(decision?.block
      ? `  [gate] BLOCKED ${event.toolName}: ${decision.reason}`
      : `  [gate] allow ${event.toolName}`);
  },
});

// 2. Tools shared by every request (they are pure, so sharing is safe).
const tools = {
  test: tool({
    description: "Run the test suite",
    inputSchema: z.object({}),
    execute: async () => ({ passed: true }),
  }),
  deploy: tool({
    description: "Deploy a version to production",
    inputSchema: z.object({ version: z.string() }),
    execute: async ({ version }) => ({ deployed: version }),
  }),
};

// 3. Pick the model. The mock reacts to the last user message.
function modelFor(prompt: string) {
  if (!MOCK) return realModel();
  const p = prompt.toLowerCase();
  if (p.includes("test")) {
    return scriptedModel([{ tool: "test" }, { text: "Tests passed." }]);
  }
  if (p.includes("deploy")) {
    return scriptedModel([
      { tool: "deploy", input: { version: "v1" } },
      { text: "Deploy attempted." },
    ]);
  }
  return scriptedModel([{ text: "I can run tests or deploy." }]);
}

if (!MOCK) realModel(); // fail fast if the provider config is missing

const SYSTEM_PREFIX = "You are a release assistant. Use the tools. "
  + "If a tool is blocked, explain the reason.\n\n";

// 4. The server. POST /chat {prompt, messages?} -> {text, blocked, status, messages}
const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/") {
      const mode = describeMode();
      return Response.json({ ok: true, rules: verification, mode });
    }
    if (req.method === "POST" && url.pathname === "/chat") {
      const body = (await req.json()) as { prompt: string; messages?: ModelMessage[] };
      const history: ModelMessage[] = body.messages ?? [];
      console.log(`\nPOST /chat  prompt="${body.prompt}"  history=${history.length}`);

      // Fresh session per request. Given history, replay advances the nets first.
      const session = gate.wrapTools(tools, { messages: history });
      console.log("  state after replay:", session.formatStatus().replace(/\n/g, " | "));

      const blocked: string[] = [];
      const messages: ModelMessage[] = [...history, { role: "user", content: body.prompt }];
      try {
        const result = await generateText({
          model: modelFor(body.prompt),
          system: SYSTEM_PREFIX + session.systemPrompt(),
          tools: session.tools,
          messages,
          stopWhen: stepCountIs(6),
        });
        for (const s of result.steps) {
          for (const p of (s.content ?? []) as any[]) {
            if (p.type === "tool-error") blocked.push(String(p.error?.message ?? p.error));
          }
        }
        return Response.json({
          text: result.text,
          blocked,
          status: session.formatStatus(),
          messages: [...messages, ...result.response.messages],
        });
      } catch (e: any) {
        const error = String(e?.message ?? e);
        return Response.json({ error, status: e?.statusCode ?? 500 }, { status: 500 });
      }
    }
    return new Response("not found", { status: 404 });
  },
});

console.log(`listening on http://localhost:${server.port}`);
console.log(`try:  curl http://localhost:${server.port}/`);
console.log("then: bun run labs/openai/03-client.ts   (other window). Ctrl+C stops.");
