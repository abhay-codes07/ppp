#!/usr/bin/env bash
# Run every upstream workflow and example, in order, and save the output under results/.
# Git Bash, at the root of the petri-flow clone, after `bun install && bun run build`.
#
#   bash labs/run-examples.sh                 # Part A + B need nothing; Part C needs the AZURE_* vars
#   SKIP_REAL=1 bash labs/run-examples.sh     # Parts A and B only (no model, no credentials)
#   INTERACTIVE=1 bash labs/run-examples.sh   # also run example 04 (asks y/n on the terminal)
#
# Part C requires labs/azure-examples.diff to be applied once (git apply labs/azure-examples.diff):
# it points the four example agents at labs/openai/_model.ts instead of Anthropic.
# Secrets are removed from the saved logs by labs/_redact.ts.
set -u
cd "$(dirname "$0")/.." || exit 1
STAMP=$(date +%Y-%m-%d_%H%M%S)
OUT="results/${STAMP}_examples"
mkdir -p "$OUT"
SUMMARY="$OUT/SUMMARY.txt"
echo "PetriFlow workflows and examples  $STAMP" > "$SUMMARY"
printf '%-34s %s\n' "step" "verdict" >> "$SUMMARY"
printf '%-34s %s\n' "---------------------------------" "------------------------------------------" >> "$SUMMARY"
OK=0; BAD=0; SKIP=0

run() {  # run <name> <must-match-regex or ''> <command...>
  local name="$1" expect="$2"; shift 2
  local log="$OUT/$name.log" rc verdict
  echo; echo "=================== $name"; echo "\$ $*"
  { echo "\$ $*"; echo; } > "$log"
  "$@" 2>&1 | tee -a "$log"
  rc=${PIPESTATUS[0]}
  verdict=ok
  [ "$rc" -ne 0 ] && verdict="exit=$rc"
  if [ -n "$expect" ] && ! grep -Eq -- "$expect" "$log"; then verdict="$verdict; missing: $expect"; fi
  if [ "$verdict" = ok ]; then OK=$((OK+1)); else BAD=$((BAD+1)); fi
  printf '%-34s %s\n' "$name" "$verdict" >> "$SUMMARY"
  echo "--> $verdict"
  [ "$verdict" = ok ]
}
skip() { printf '%-34s %s\n' "$1" "skipped: $2" >> "$SUMMARY"; SKIP=$((SKIP+1)); echo; echo "=================== $1  (skipped: $2)"; }

# ---- Part A. The six workflows: engine + scheduler + SQLite, no model ------------------------
run A1-workflow-coffee            'completed'                 bun workflows/coffee/index.ts
run A2-workflow-order-checkout    'completed'                 bun workflows/order-checkout/index.ts
run A3-workflow-contract-approval 'completed'                 bun workflows/contract-approval/index.ts
run A4-workflow-simple-agent      '"status": "completed"'     bun workflows/simple-agent/index.ts
run A5-workflow-agent-benchmark   '"status": "completed"'     bun workflows/agent-benchmark/index.ts
run A6-workflow-github-lookup     'completed'                 bun workflows/github-lookup/index.ts   # live call to api.github.com
run A7-analyse-all-strict         'Reachable states: 196'     bash -c 'for w in coffee order-checkout github-lookup contract-approval simple-agent agent-benchmark; do bun packages/cli/src/cli.ts analyse workflows/$w/index.ts --strict || exit 1; done'

# ---- Part B. The gate without a model: ops rules, playground, loopholes ------------------------
run B1-openclaw-ops-verify        'Total: 57 nets'            bun examples/05-openclaw-ops/verify.ts
run B2-openclaw-ops-gate-demo     'nets compiled : 56'        bun run labs/ops-rules-demo.ts
run B3-gate-playground            'BLOCK'                     bun run labs/gate-playground.ts
run B4-loopholes                  'Loophole 5'                bun run labs/loopholes.ts
run B5-example-tests              ' 0 fail'                   bun test examples      # needs labs/windows-test-fix.diff on Windows

# ---- Part C. The upstream example agents with the real model --------------------------------
if [ "${SKIP_REAL:-}" = "1" ]; then
  skip C-examples "SKIP_REAL=1"
elif ! grep -q "labs/openai/_model" examples/01-file-management/agent.ts; then
  skip C-examples "labs/azure-examples.diff not applied (examples still import @ai-sdk/anthropic)"
elif ! run C0-check-credentials 'Credentials work' bun run labs/openai/00-check-key.ts; then
  echo "Credentials check failed; Part C not run." >> "$SUMMARY"
else
  # example 01 works on /tmp/project (C:\tmp\project in Git Bash): create the two files it expects
  mkdir -p /tmp/project && printf 'temporary log\n' > /tmp/project/temp.log && printf 'pretend archive\n' > /tmp/project/old-backup.tar.gz
  run C1-example-01-file-management 'Final Response' bun examples/01-file-management/agent.ts
  ls -la /tmp/project | tee -a "$OUT/C1-example-01-file-management.log"
  rm -f examples/02-deployment/.deploy-state.json
  run C2-example-02-deployment      'Final Response' bun examples/02-deployment/agent.ts
  [ -f examples/02-deployment/.deploy-state.json ] && cat examples/02-deployment/.deploy-state.json | tee -a "$OUT/C2-example-02-deployment.log"
  if [ -n "${DISCORD_BOT_TOKEN:-}" ]; then
    run C3-example-03-discord-bot   'Final Response' bun examples/03-discord-bot/agent.ts
  else
    skip C3-example-03-discord-bot "needs DISCORD_BOT_TOKEN and DISCORD_GUILD_ID (a real Discord bot); its gate logic is covered by B5"
  fi
  if [ "${INTERACTIVE:-}" = "1" ]; then
    run C4-example-04-devops-assistant 'Final Response' bun examples/04-devops-assistant/agent.ts
  else
    skip C4-example-04-devops-assistant "INTERACTIVE=1 to run (asks y/n; web, Slack, Gmail, Resend tools error without their keys)"
  fi
fi

bun labs/_redact.ts "$OUT"
{ echo; echo "ok: $OK   not ok: $BAD   skipped: $SKIP"; echo "Review every file before committing; secrets were replaced by labs/_redact.ts."; } >> "$SUMMARY"
echo; cat "$SUMMARY"; echo; echo "Saved under $OUT"
[ "$BAD" -eq 0 ]
