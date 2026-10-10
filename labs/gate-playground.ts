// Lab: play with the gate without any API key.
// Run from the repo root:  bun run labs/gate-playground.ts
import { compile } from "@petriflow/rules";
import { createGateManager } from "@petriflow/gate";

// 1. Compile three rules. Each becomes one small Petri net.
const { nets, verification } = compile(`
  require backup before delete
  block rm
  limit push to 2 per session
`);
console.log("Compiled nets:", nets.map((n) => n.name));
console.log("Verification (reachable states per net):", verification);

// 2. Build a manager. "enforce" means blocked calls really get blocked.
const manager = createGateManager(nets, {
  mode: "enforce",
  onDecision: (event, decision) => {
    const verdict = decision?.block ? `BLOCK (${decision.reason})` : "allow";
    console.log(`  decision for ${event.toolName}: ${verdict}`);
  },
});
const ctx = { hasUI: false, confirm: async () => false };

function status() {
  return manager.formatStatus().replace(/\n/g, " | ");
}

async function call(id: string, toolName: string) {
  console.log(`\n> agent calls ${toolName}`);
  await manager.handleToolCall({ toolCallId: id, toolName, input: {} }, ctx);
  console.log("  state:", status());
}

// 3. Walk a scenario.
await call("c1", "delete");   // blocked: no backup yet
await call("c2", "backup");   // allowed, but deferred (not fired yet)
console.log("  (backup tool is running...)");
manager.handleToolResult({
  toolCallId: "c2", toolName: "backup", input: {}, isError: false,
});
console.log("  backup succeeded -> deferred transition fired");
console.log("  state:", status());
await call("c3", "delete");   // allowed now
await call("c4", "delete");   // blocked again: needs a new backup
await call("c5", "rm");       // always blocked
await call("c6", "push");     // 1 of 2
await call("c7", "push");     // 2 of 2
await call("c8", "push");     // over the limit
await call("c9", "ls");       // no net cares: passes

console.log("\nSystem prompt the LLM would see:");
console.log(manager.formatSystemPrompt());
