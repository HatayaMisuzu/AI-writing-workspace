#!/usr/bin/env bash
# diag-hw1：只跑检查点相关单测，重复放大复现概率；红不中断，最后汇总
set -u
export INKSTONE_CP_DIAG=1
mkdir -p diag-out
G_ONLY=${G_ONLY:-10}; PAIR=${PAIR:-2}; FULL=${FULL:-1}
run() { local name=$1; shift; echo "::group::$name"; npx vitest run "$@" 2>&1 | tee "diag-out/$name.log"; local rc=${PIPESTATUS[0]}; echo "::endgroup::"; echo "$name rc=$rc" | tee -a diag-out/summary.txt; }
for i in $(seq 1 "$G_ONLY"); do run "g-only-$i" tests/checkpoint-release-p44.test.ts -t 'G：'; done
for i in $(seq 1 "$PAIR"); do run "pair-$i" tests/checkpoint-release-p44.test.ts tests/wal-checkpoint-p3.test.ts; done
for i in $(seq 1 "$FULL"); do run "full-$i"; done
echo "== summary"; cat diag-out/summary.txt
grep -h -E "first save after release|natural 1000ch|AssertionError|G[12]-first-save-end" diag-out/*.log | cut -c1-400
exit 0
