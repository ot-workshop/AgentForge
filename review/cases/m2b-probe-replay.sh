#!/usr/bin/env bash
# Read-only probes for docs/runtime-binding.md §4 (M2-B). Nothing under src/ is touched.
# usage: review/cases/m2b-probe-replay.sh [clean checkout at 5aecec7 or later]
#   (default: a fresh `git archive` of HEAD, so the checkout itself is never written)
set -euo pipefail
SRC="${1:-$(git rev-parse --show-toplevel)}"
WS="$(mktemp -d)"; git -C "$SRC" archive HEAD | tar -C "$WS" -x
probe="$(git -C "$SRC" rev-parse --show-toplevel)/review/m2b/probe"
echo "== source: $(git -C "$SRC" rev-parse HEAD)  workspace: $WS"

echo "== probe 1: a detached child keeps appending to events.jsonl after the stage returned (A5.8 boundary)"
node -e '
const { spawnSync } = require("child_process"); const fs = require("fs");
const ws = process.argv[1]; const f = ws + "/probe-events.jsonl"; fs.writeFileSync(f, "");
const t0 = Date.now(); const r = spawnSync(process.execPath, [ws + "/review/m2b/probe/stage.mjs", f], { encoding: "utf8" });
const now = fs.readFileSync(f, "utf8").split("\n").filter(Boolean).length;
setTimeout(() => { const later = fs.readFileSync(f, "utf8").split("\n").filter(Boolean).length;
  const verdict = later > now ? "STILL WRITABLE after the stage returned" : "not writable";
  console.log(`stage rc=${r.status} returned ${Date.now() - t0}ms after the stage was started (the file is read right after spawnSync returns); lines now=${now}; after 1.3s=${later} -> ${verdict}`); }, 1300);
' "$WS"

echo "== probe 2: the runner (cwd = run dir) can see checks.lock / context / events.jsonl"
cp "$probe/read-own-run.js" "$WS/fixtures/fake-runner.js"
(cd "$WS" && node bin/forge.js run --flow flows/main.yaml >/dev/null 2>&1)
RUN="$(ls "$WS/.forge/runs" | sort | tail -1)"
node -e '
const fs = require("fs"); const ev = fs.readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const end = ev.find((e) => e.seq === 3); console.log("stage.end payload.submit.summary:", end.payload.submit && end.payload.submit.summary);
' "$WS/.forge/runs/$RUN/events.jsonl"

echo "== probe 3: what the stage can touch on this machine"
D="$(mktemp -d)"; : > "$D/events.jsonl"; echo x > "$D/plan.md"; echo checks > "$D/checks.lock"
(cd "$D" && FORGE_EVENTS="$D/events.jsonl" FORGE_CHECKS_FILE="$D/checks.lock" FORGE_REPO="$WS" node "$WS/review/m2b/probe/probe-walls.cjs")
echo "(probe 3 runs in a throwaway dir $D; the repo copy is only read)"

echo "== note: probe 2 and 3 replace/copy fixtures only inside a temporary copy; the source checkout is unchanged"
