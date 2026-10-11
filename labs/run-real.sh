#!/usr/bin/env bash
# Run every PetriFlow demo in order and save the output under results/<date>_<mode>/.
# Git Bash, at the root of the petri-flow clone, after `bun install && bun run build`.
#
#   bash labs/run-real.sh              real model: AZURE_* (or OPENAI_API_KEY) exported first
#   MOCK=1 bash labs/run-real.sh       rehearsal: scripted model, no network, no cost
#
# Options (environment variables):
#   INTERACTIVE=1     lab 2 asks you y/n at each deploy (default: AUTO_APPROVE=1)
#   SKIP_TESTS=1      skip the full `bun test` (about a minute); the benchmark tests still run
#   REDACT_ENDPOINT=1 also replace the Azure endpoint host in the saved logs
#   PORT=3457         port for the lab 3 server (default 3456)
#
# What it writes (all plain text, safe to read before committing):
#   00-environment.txt   mode, bun version, commit, masked ids; never the secret
#   NN-<name>.log        one file per demo, exactly what the terminal showed
#   SUMMARY.txt          one line per demo: ok, or what went wrong
# Secrets are removed from every file by labs/_redact.ts before the script ends.
set -u
cd "$(dirname "$0")/.." || exit 1

MODE=real; [ "${MOCK:-}" = "1" ] && MODE=mock
STAMP=$(date +%Y-%m-%d_%H%M%S)
OUT="results/${STAMP}_${MODE}"
mkdir -p "$OUT"
SUMMARY="$OUT/SUMMARY.txt"
export PORT="${PORT:-3456}"
export BASE="http://localhost:$PORT"
[ "${INTERACTIVE:-}" = "1" ] || export AUTO_APPROVE=1

mask() { local v="${1:-}"; if [ -z "$v" ]; then echo "(not set)"; else echo "${v:0:4}...${v: -4}"; fi; }

{
  echo "PetriFlow demo run"
  echo "date       : $(date '+%Y-%m-%d %H:%M:%S %z')"
  echo "mode       : $MODE"
  echo "os         : $(uname -s) $(uname -m)"
  echo "bun        : $(bun --version)"
  echo "commit     : $(git rev-parse --short HEAD 2>/dev/null || echo '?') $(git log -1 --format='(%cd)' --date=short 2>/dev/null)"
  echo "endpoint   : ${AZURE_OPENAI_ENDPOINT:-(not set)}"
  echo "deployment : ${AZURE_OPENAI_DEPLOYMENT:-(not set)}"
  echo "tenant     : $(mask "${AZURE_TENANT_ID:-}")"
  echo "client id  : $(mask "${AZURE_CLIENT_ID:-}")"
  echo "secret     : $([ -n "${AZURE_CLIENT_SECRET:-}" ] && echo '(set, not recorded)' || echo '(not set)')"
  echo "azure key  : $([ -n "${AZURE_OPENAI_API_KEY:-}" ] && echo '(set, not recorded)' || echo '(not set)')"
  echo "openai key : $(mask "${OPENAI_API_KEY:-}")"
  echo "openai mdl : ${OPENAI_MODEL:-(default)}"
  echo "approvals  : $([ "${INTERACTIVE:-}" = "1" ] && echo 'interactive (y/n typed)' || echo 'AUTO_APPROVE=1')"
} > "$OUT/00-environment.txt"

echo "PetriFlow demo run  $STAMP  mode=$MODE" > "$SUMMARY"
echo "step                           verdict" >> "$SUMMARY"
echo "-----------------------------  ------------------------------------------" >> "$SUMMARY"

OK=0; BAD=0
# run <name> <must-match-regex or ''> <command...>
# Runs the command, shows it live, saves it, and records a verdict:
#   ok                      exit 0 and the invariant line was found
#   exit=N                  the command failed
#   missing: <regex>        ran, but the line that must appear for the demo to count is absent
run() {
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
  printf '%-30s %s\n' "$name" "$verdict" >> "$SUMMARY"
  echo "--> $verdict"
  [ "$verdict" = ok ]
}

# ---- Part A. No model needed: the mathematics and the gate alone --------------------------
run 01-analyse-coffee          "Reachable states: 5"   bun packages/cli/src/cli.ts analyse workflows/coffee/index.ts --strict
run 02-analyse-order-checkout  "holds"                  bun packages/cli/src/cli.ts analyse workflows/order-checkout/index.ts --strict
run 03-analyse-agent-benchmark "Reachable states: 196" bun packages/cli/src/cli.ts analyse workflows/agent-benchmark/index.ts --strict
run 04-benchmark-property-tests " 0 fail"              bun test workflows/agent-benchmark
run 05-gate-playground         "BLOCK"                 bun run labs/gate-playground.ts
run 06-loopholes               "Loophole 5"            bun run labs/loopholes.ts

# ---- Part B. The model drives the gate -----------------------------------------------------
if [ "$MODE" = real ]; then
  if ! run 10-check-credentials "Credentials work" bun run labs/openai/00-check-key.ts; then
    echo; echo "Credentials check failed. Fix it (see docs chapter 13, part 7) and run again."
    echo "Nothing below was run." >> "$SUMMARY"
    bun labs/_redact.ts "$OUT"
    exit 1
  fi
fi

# Lab 1 invariant: rm never executes, so old-backup.tar.gz is still there at the end.
run 11-lab1-file-agent   'files left: \[.*old-backup\.tar\.gz' bun run labs/openai/01-file-agent.ts
# Lab 2 invariant: at most two deployments happen whatever the model asks for.
run 12-lab2-deploy-agent 'deployments that actually happened:' bun run labs/openai/02-deploy-agent.ts
if grep -E 'deployments that actually happened:' "$OUT/12-lab2-deploy-agent.log" | grep -Eq '(production|staging).*(production|staging).*(production|staging)'; then
  printf '%-30s %s\n' "12-lab2-deploy-limit" "FAILED: three deployments happened" >> "$SUMMARY"; BAD=$((BAD+1))
else
  printf '%-30s %s\n' "12-lab2-deploy-limit" "ok (two or fewer deployments)" >> "$SUMMARY"; OK=$((OK+1))
fi

# Lab 3: server in the background, then the honest client, then the forged history.
echo; echo "=================== 13-lab3-server (background on port $PORT)"
bun run labs/openai/03-server.ts > "$OUT/13-lab3-server.log" 2>&1 &
SRV=$!
for _ in $(seq 1 40); do curl -s "$BASE/" >/dev/null 2>&1 && break; sleep 0.5; done
if curl -s "$BASE/" >/dev/null 2>&1; then
  run 14-lab3-client "deploy requires a successful call to test first"           bun run labs/openai/03-client.ts
  run 15-lab3-spoof  'forged request blocked : false'                           bun run labs/openai/03-spoof.ts
else
  printf '%-30s %s\n' "13-lab3-server" "FAILED to start (see 13-lab3-server.log; port busy? PORT=3457)" >> "$SUMMARY"; BAD=$((BAD+1))
fi
kill "$SRV" 2>/dev/null; wait "$SRV" 2>/dev/null
echo "(server log saved: $OUT/13-lab3-server.log)"

# Lab 4: the model chooses transitions inside the engine.
run 16-lab4-decision-provider '"status":"completed"' bun run labs/openai/04-decision-provider.ts

# ---- Part C. Optional: the whole test suite --------------------------------------------------
if [ "${SKIP_TESTS:-}" != "1" ]; then
  run 20-full-test-suite 'pass' bun test
fi

# ---- Finish ---------------------------------------------------------------------------------
bun labs/_redact.ts "$OUT"
{
  echo
  echo "ok: $OK   not ok: $BAD"
  echo "approvals: $([ "${INTERACTIVE:-}" = "1" ] && echo "typed by hand" || echo "AUTO_APPROVE=1")"
  echo "Review every file in this folder before committing. Secrets were replaced by labs/_redact.ts;"
  echo "the token counts and model text are the real ones."
} >> "$SUMMARY"
echo; cat "$SUMMARY"
echo; echo "Saved under $OUT"
[ "$BAD" -eq 0 ]
