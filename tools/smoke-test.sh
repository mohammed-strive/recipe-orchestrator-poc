#!/bin/sh
# End-to-end check of the whole stack without Claude Code's UI:
# plans an automatic finance run, accepts the recommended plugin if a person is asked,
# approves the variance review, then evaluates, replays and verifies the audit chain.
# Needs: podman compose up, and the engine running (cd engine && npm start).
set -eu
cd "$(dirname "$0")/.."
mcp() { tools/mcp.sh engine "$1" "$2"; }
field() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const v=($1)(JSON.parse(s));console.log(typeof v==='object'?JSON.stringify(v):v)})"; }

echo "1. Plan an automatic run of quarterly-revenue-projection"
plan=$(mcp plan_run '{"recipe_id":"quarterly-revenue-projection","inputs":{"actuals_csv":"samples/actuals.csv"},"mode":"automatic"}')
run=$(printf "%s" "$plan" | field 'd=>d.run_id')
echo "   run $run: $(printf "%s" "$plan" | field 'd=>d.status')"

for _ in $(seq 1 60); do
  state=$(mcp get_run "{\"run_id\":\"$run\",\"wait_seconds\":20}")
  status=$(printf "%s" "$state" | field 'd=>d.status')
  case "$status" in
    needs_selection)
      step=$(printf "%s" "$state" | field 'd=>d.pending_selections[0].step_id')
      pick=$(printf "%s" "$state" | field 'd=>d.pending_selections[0].recommended')
      echo "2. A person is asked to choose a plugin for $step ($(printf "%s" "$state" | field 'd=>d.pending_selections[0].reason')). Choosing $pick"
      mcp select_component "{\"run_id\":\"$run\",\"step_id\":\"$step\",\"component_id\":\"$pick\",\"selected_by\":\"smoke-test\"}" >/dev/null ;;
    waiting_approval)
      step=$(printf "%s" "$state" | field 'd=>d.pending_approval.step_id')
      echo "3. Approval requested at $step: $(printf "%s" "$state" | field 'd=>d.pending_approval.message')"
      mcp approve_step "{\"run_id\":\"$run\",\"step_id\":\"$step\",\"decision\":\"approve\",\"note\":\"smoke test\",\"decided_by\":\"smoke-test\"}" >/dev/null ;;
    completed) break ;;
    failed) echo "Run failed: $(printf "%s" "$state" | field 'd=>d.error')"; exit 1 ;;
    *) echo "   ... $status" ;;
  esac
done

echo "4. Completed. Report: $(printf "%s" "$state" | field 'd=>d.report_markdown_path')"
printf "%s" "$state" | field 'd=>d.steps.map(s=>`   ${s.step.padEnd(28)} ${String(s.reproducibility).padEnd(11)} ${s.component||""}${s.fallback_from?"  (fallback from "+s.fallback_from+")":""}`).join("\n")'
# Assign each result before echoing it. On macOS /bin/sh is bash 3.2, which mis-parses quoted
# JSON inside "$(...)" nested in a double-quoted string and brace-expands it at the commas.
evaluation=$(mcp evaluate_run "{\"run_id\":\"$run\"}" | field 'd=>`confidence ${d.confidence}, passed ${d.passed}`')
echo "5. Evaluate: $evaluation"
replay=$(mcp replay_run "{\"run_id\":\"$run\"}" | field 'd=>`identical ${d.identical}`')
echo "6. Replay:   $replay"
audit=$(mcp get_audit_log "{\"run_id\":\"$run\",\"last\":1}" | field 'd=>`chain valid ${d.chain.valid}, ${d.chain.events} events`')
echo "7. Audit:    $audit"
