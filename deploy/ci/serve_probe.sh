#!/usr/bin/env bash
# Start `forge serve` on a free loopback port, hit the three Live endpoints, then stop it.
#
#   deploy/ci/serve_probe.sh <rootDir> [--write]
#
# <rootDir> is the deployed workspace (contains bin/ and flows/). Without --write the
# probe is read-only: it expects at least one run in <rootDir>/.forge/runs and only
# reads /healthz, /snapshot, /events. With --write it first runs the fake-runner
# sample once (FORGE_FAKE=1) so the probe works on a freshly deployed tree.
#
# Exit 0 only when all three endpoints answered as contract A2.4/v2.4 §3.1 requires:
#   /healthz -> {"ok":true,"runs":[...]}
#   /snapshot -> runs[0] is the newest run, stages carry (stage, iteration>=1)
#   /events?run=<id>&since=0 -> first frame is seq 1 run.start of that run,
#                               and since=1 starts at seq 2.
# The port is allocated by the kernel (--port 0), so this never collides with a
# with a deployed instance such as 18982. Nothing is written outside <rootDir>/.forge.
set -euo pipefail
ROOT="${1:?usage: serve_probe.sh <rootDir> [--write]}"
WRITE="${2:-}"
[ -d "$ROOT/bin" ] || { echo "PROBE FAIL: $ROOT/bin not found"; exit 1; }
ROOT="$(cd "$ROOT" && pwd)"
LOG="$(mktemp "${TMPDIR:-/tmp}/forge-serve-probe.XXXXXX.log")"
PID=""
cleanup() { [ -n "$PID" ] && kill "$PID" 2>/dev/null || true; wait "$PID" 2>/dev/null || true; }
trap cleanup EXIT

if [ "$WRITE" = "--write" ] || [ ! -d "$ROOT/.forge/runs" ] || [ -z "$(ls -A "$ROOT/.forge/runs" 2>/dev/null)" ]; then
  (cd "$ROOT" && FORGE_ROOT="$ROOT" FORGE_FAKE=1 node bin/forge.js run --run probe-seed --flow flows/main.yaml) >/dev/null
fi

# Pick a free port first: `serve` reports the port it was given, so --port 0 would
# only ever print ":0". Holding then releasing the listener keeps the race tiny.
PORT="$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()')"
(cd "$ROOT" && FORGE_ROOT="$ROOT" exec node bin/forge.js serve --port "$PORT") >"$LOG" 2>&1 &
PID=$!
for _ in $(seq 1 50); do
  grep -q "http://127.0.0.1:$PORT" "$LOG" 2>/dev/null && break
  sleep 0.1
done
grep -q "http://127.0.0.1:$PORT" "$LOG" 2>/dev/null || { echo "PROBE FAIL: serve did not come up on :$PORT"; cat "$LOG"; exit 1; }
BASE="http://127.0.0.1:$PORT"

curl -fsS "$BASE/healthz" | python3 -c 'import sys,json;d=json.load(sys.stdin);assert d.get("ok") is True and isinstance(d.get("runs"),list),d' || { echo "PROBE FAIL: /healthz"; exit 1; }
RUN="$(curl -fsS "$BASE/snapshot" | python3 -c '
import sys,json
d=json.load(sys.stdin); runs=d.get("runs") or []
assert runs, "no runs in /snapshot"
s=runs[0]; assert s.get("run_id"), s
keys=[(t.get("stage"),t.get("iteration",1)) for r in runs for t in (r.get("stages") or [])]
assert all(isinstance(k[0],str) and isinstance(k[1],int) and k[1]>=1 for k in keys), keys
print(s["run_id"])')" || { echo "PROBE FAIL: /snapshot"; exit 1; }

FIRST="$(curl -sN --max-time 2 "$BASE/events?run=$RUN&since=0" 2>/dev/null | head -1 | sed 's/^data: //' || true)"
SECOND="$(curl -sN --max-time 2 "$BASE/events?run=$RUN&since=1" 2>/dev/null | head -1 | sed 's/^data: //' || true)"
FIRST="$FIRST" SECOND="$SECOND" RUN="$RUN" python3 -c '
import os,json
run=os.environ["RUN"]
a=json.loads(os.environ["FIRST"]); b=json.loads(os.environ["SECOND"])
assert a["seq"]==1 and a["type"]=="run.start" and a["run_id"]==run, ("first frame",a)
assert b["seq"]==2 and b["run_id"]==run, ("second frame",b)' || { echo "PROBE FAIL: /events first=$FIRST second=$SECOND"; exit 1; }

echo "PROBE OK: port=$PORT run=$RUN healthz ok, snapshot runs[0]=$RUN, events seq1 run.start + since=1 -> seq2"
