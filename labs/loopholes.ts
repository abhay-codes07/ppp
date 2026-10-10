// Four loopholes you can watch happen, with no LLM and no API key.
// Each one is a property of the design, not a bug in one line.
//   bun run labs/loopholes.ts
import { compile } from "@petriflow/rules";
import { createGateManager } from "@petriflow/gate";

type Decision = { block: boolean; reason?: string };

function makeGate(rules: string) {
  const { nets, verification } = compile(rules);
  let last: Decision = { block: false };
  const manager = createGateManager(nets, {
    mode: "enforce",
    onDecision: (_event, decision) => {
      last = decision?.block ? { block: true, reason: decision.reason } : { block: false };
    },
  });
  const ctx = { hasUI: false, confirm: async () => false };
  let n = 0;
  async function call(toolName: string, input: Record<string, unknown> = {}, succeed = true) {
    const toolCallId = `c${++n}`;
    await manager.handleToolCall({ toolCallId, toolName, input }, ctx);
    const verdict = last.block ? `BLOCKED (${last.reason})` : "allowed";
    console.log(`  ${toolName}(${JSON.stringify(input)}) -> ${verdict}`);
    if (!last.block) {
      manager.handleToolResult({ toolCallId, toolName, input, isError: !succeed });
      if (!succeed) console.log(`    (tool reported failure)`);
    }
    return !last.block;
  }
  return { call, verification, status: () => manager.formatStatus().replace(/\n/g, " | ") };
}

console.log("=== Loophole 1: any backup unlocks any delete ===");
console.log("rule: require backup before delete");
{
  const g = makeGate("require backup before delete");
  await g.call("backup", { name: "readme.txt" });
  await g.call("delete", { name: "production.db" });
  console.log("  The net counts tool NAMES. It has no idea what was backed up.");
}

console.log("\n=== Loophole 2: tool mapping is a regular expression ===");
console.log("rules: map bash.command rm as delete / block delete");
{
  const g = makeGate("map bash.command rm as delete\nblock delete");
  await g.call("bash", { command: "rm -rf /data" });
  await g.call("bash", { command: "find /data -delete" });
  await g.call("bash", { command: "python -c \"import shutil; shutil.rmtree('/data')\"" });
  await g.call("bash", { command: "CMD=rm; $CMD -rf /data" });
  console.log("  The word 'rm' is caught wherever it appears; synonyms are not. Deny-list problem, one layer down.");
}

console.log("\n=== Loophole 3: two 'verified' rules that block everything ===");
console.log("rules: require a before b / require b before a");
{
  const g = makeGate("require a before b\nrequire b before a");
  console.log("  compile() verification:", JSON.stringify(g.verification));
  await g.call("a");
  await g.call("b");
  console.log("  Each net is analysed alone. Their combination is never analysed, so a dead policy passes.");
}

console.log("\n=== Loophole 4: a limit counts attempts, not successes ===");
console.log("rule: limit push to 2 per session");
{
  const g = makeGate("limit push to 2 per session");
  await g.call("push", { branch: "main" }, false);
  await g.call("push", { branch: "main" }, false);
  await g.call("push", { branch: "main" }, true);
  console.log("  state:", g.status());
  console.log("  Two failed pushes spent the budget. The limit template is not deferred.");
}

console.log("\n=== Loophole 5: the website's headline example does not run as shown ===");
console.log("rule: limit whatsapp.send to 1 per whatsapp.lookup   (site: 'Agent calls lookup -> OK')");
{
  const g = makeGate("limit whatsapp.send to 1 per whatsapp.lookup");
  await g.call("whatsapp", { action: "lookup" });   // site says OK; the net says blocked
  await g.call("whatsapp", { action: "send" });
  await g.call("whatsapp", { action: "send" });
  await g.call("whatsapp", { action: "lookup" });   // refill works only after a send
  console.log("  The refill transition needs a 'spent' token, so the first lookup is blocked while");
  console.log("  the budget is full. The net has jurisdiction over lookup, so it cannot abstain.");
}
