#!/bin/sh
# One tuning-loop round in about the time of its slowest task: one bench process per task, all
# at once (tasks that continue an earlier one must not be split; use the runner for those).
# Usage: sh bench/loop.sh <suite> <arm[,arm]> <task> [<task> ...]   (profile: $PROFILE, default claude-haiku)
suite=$1; arms=$2; shift 2
mkdir -p "bench/results/$suite"
for task in "$@"; do
  npm run bench -- --tasks "$task" --arms "$arms" --profile "${PROFILE:-claude-haiku}" --suite "$suite" > "bench/results/$suite/$task.log" 2>&1 &
done
wait
grep -h "RESOLVED\|unresolved" "bench/results/$suite"/*.log
npx tsx bench/runner/loop-report.ts "$suite"
