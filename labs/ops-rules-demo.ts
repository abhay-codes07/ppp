// examples/05-openclaw-ops without OpenClaw: load the 56-rule policy, show what the
// compiler "verified", then push shell commands through the composed gate.
// No model, no network. Run from the repo root:  bun run labs/ops-rules-demo.ts
import { loadRules } from "@petriflow/rules";
import { createGateManager } from "@petriflow/gate";
import type { GateContext } from "@petriflow/gate";
import { join } from "node:path";

const rulesPath = join(import.meta.dir, "..", "examples", "05-openclaw-ops", "ops-assistant.rules");
const { nets, verification } = await loadRules(rulesPath);

const byKind = { require: 0, approve: 0, block: 0, limit: 0 };
for (const n of nets) {
  if (n.name.startsWith("require-")) byKind.require++;
  else if (n.name.startsWith("approve-")) byKind.approve++;
  else if (n.name.startsWith("block-")) byKind.block++;
  else if (n.name.startsWith("limit-")) byKind.limit++;
}
console.log(`=== examples/05-openclaw-ops/ops-assistant.rules ===`);
console.log(`nets compiled : ${nets.length}  (${byKind.require} sequence, ${byKind.approve} approval, ${byKind.block} block, ${byKind.limit} limit)`);
const counts = new Map<number, number>();
for (const v of verification) counts.set(v.reachableStates, (counts.get(v.reachableStates) ?? 0) + 1);
console.log(`"verification" : only a reachable-state count per net ->`,
  [...counts.entries()].sort((a, b) => a[0] - b[0]).map(([s, c]) => `${c} nets with ${s} states`).join(", "));
console.log(`largest        : ${verification.reduce((a, b) => (b.reachableStates > a.reachableStates ? b : a)).name}`);
console.log("");

// The OpenClaw adapter always runs headless: hasUI false, so every approval rule is a hard block.
const ctx: GateContext = { hasUI: false, confirm: async () => false };
const manager = createGateManager(nets, { mode: "enforce" });
let n = 0;
async function exec(command: string) {
  const id = `call-${++n}`;
  const d = await manager.handleToolCall({ toolCallId: id, toolName: "exec", input: { command } }, ctx);
  console.log(`exec "${command}"`.padEnd(46) + (d?.block ? `-> BLOCK  ${d.reason}` : "-> allow"));
  if (!d?.block) manager.handleToolResult({ toolCallId: id, toolName: "exec", input: { command }, isError: false });
}
async function call(toolName: string, input: Record<string, unknown> = {}) {
  const id = `call-${++n}`;
  const d = await manager.handleToolCall({ toolCallId: id, toolName, input }, ctx);
  console.log(`${toolName} ${JSON.stringify(input)}`.padEnd(46) + (d?.block ? `-> BLOCK  ${d.reason}` : "-> allow"));
  if (!d?.block) manager.handleToolResult({ toolCallId: id, toolName, input, isError: false });
}

console.log("--- hard blocks (place 'locked' never gets a token)");
await exec("rm -rf build/");
await exec("sudo apt install x");
await exec("git push --force origin main");
await exec("terraform destroy");

console.log("\n--- sequencing: git-diff AND git-add before git-commit, git-commit before git-push");
await exec("git commit -m 'x'");          // blocked: neither diff nor add yet
await exec("git diff");
await exec("git commit -m 'x'");          // still blocked: git-add missing
await exec("git add .");
await exec("git commit -m 'x'");          // allowed
await exec("git push origin main");       // allowed (commit done), consumes limit-git-push-5 budget
await exec("git push origin main");       // blocked: push needs a new commit (cycle reset)

console.log("\n--- file deletion: cp-file before rm-file");
await exec("rm notes.txt");               // blocked
await exec("cp notes.txt notes.bak");     // allowed, deferred: fires on the success result above
await exec("rm notes.txt");               // allowed

console.log("\n--- approval rules are hard blocks when there is no UI (OpenClaw adapter passes hasUI:false)");
await exec("npm publish");                // caught first by 'require npm-build before npm-publish' (phase 1 runs before approvals)
await call("message", { to: "team", text: "hi" });   // only an approval rule covers 'message': blocked for lack of a UI

console.log("\n--- regex mapping decides everything: the same intent, different spelling");
await exec("rm -r -f build/");            // 'rm -rf' pattern needs the literal -rf; this maps to rm-file instead
await exec("/bin/rm -rf build/");         // \brm\s+-rf matches after the slash
await exec("find build -delete");         // no map matches: plain exec, allowed

console.log("\n--- limits: exec is capped at 50 per session; this run used " + n + " calls");
console.log(manager.formatStatus().split("\n").filter((l) => /limit-exec-50|limit-git-push-5|require-git-commit-before-git-push|require-cp-file-before-rm-file/.test(l)).join("\n"));
