// Remove credential values from every file in a results folder, in place.
//   bun labs/_redact.ts results/2026-10-11_101500_real
// Replaces the VALUE of each secret-bearing variable with <REDACTED:NAME>, so a log that
// accidentally echoed a secret (an error message, a URL) can still be committed.
// With REDACT_ENDPOINT=1 the Azure endpoint host is replaced too.
import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
if (!dir) { console.error("usage: bun labs/_redact.ts <results folder>"); process.exit(2); }

const names = ["AZURE_CLIENT_SECRET", "AZURE_OPENAI_API_KEY", "OPENAI_API_KEY", "AZURE_CLIENT_ID", "AZURE_TENANT_ID"];
const pairs: [string, string][] = [];
for (const n of names) {
  const v = process.env[n];
  if (v && v.length >= 8) pairs.push([n, v]);
}
if (process.env.REDACT_ENDPOINT === "1" && process.env.AZURE_OPENAI_ENDPOINT) {
  try { pairs.push(["AZURE_OPENAI_ENDPOINT", new URL(process.env.AZURE_OPENAI_ENDPOINT).host]); } catch {}
}

let touched = 0, hits = 0;
for (const f of readdirSync(dir)) {
  const p = join(dir, f);
  if (!statSync(p).isFile()) continue;
  let text = readFileSync(p, "utf-8");
  let changed = false;
  for (const [n, v] of pairs) {
    if (text.includes(v)) {
      hits += text.split(v).length - 1;
      text = text.split(v).join(`<REDACTED:${n}>`);
      changed = true;
    }
  }
  if (changed) { writeFileSync(p, text); touched++; }
}
console.log(`redact: ${pairs.length} value(s) checked across ${dir}; ${hits} occurrence(s) replaced in ${touched} file(s)`);
