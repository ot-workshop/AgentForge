#!/usr/bin/env bash
# start or restart the forge serve process for the current deploy
# contract: GET /healthz -> 200 {"ok":true}
#           GET /snapshot -> 200, event-source readable (run list; may be empty at bootstrap)
#           GET /events?since=<seq> -> SSE, strictly > since
set -euo pipefail
PORT="${FORGE_PORT:-8787}"
PY="${PY:-python3}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PIDF="$ROOT/.forge-serve.pid"
LOG="$ROOT/.forge-serve.log"
for f in "$ROOT"/.forge-serve.pid "$(readlink -f "$0")/../.forge-serve.pid"; do
  [ -f "$f" ] || continue
  pid="$(cat "$f")"; kill "$pid" 2>/dev/null || true
done
for i in $(seq 1 10); do ss -ltn 2>/dev/null | grep -q ":$PORT " || break; sleep 0.5; done
ss -ltn 2>/dev/null | grep -q ":$PORT " && { echo "port $PORT still in use"; exit 1; }
cd "$ROOT"
# 显式把部署根交给服务（cli 优先读 FORGE_ROOT，否则取 cwd）；两者都钉死才不受调用者 cwd 影响
FORGE_ROOT="$ROOT" nohup node bin/forge.js serve --port "$PORT" >"$LOG" 2>&1 &
echo $! > "$PIDF"
sleep 1
if ! kill -0 "$(cat "$PIDF")" 2>/dev/null; then echo "process exited immediately"; tail -n 20 "$LOG" || true; exit 1; fi
for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 \
     && curl -fsS "http://127.0.0.1:$PORT/snapshot" | $PY -c 'import sys,json;d=json.load(sys.stdin);assert isinstance(d.get("runs"),list)' 2>/dev/null; then
    echo "healthy on $PORT (/healthz + /snapshot parsed; run count=$(curl -fsS "http://127.0.0.1:$PORT/snapshot" | $PY -c 'import sys,json;print(len(json.load(sys.stdin)["runs"]))'))"; exit 0; fi
  sleep 1
done
echo "health check failed (/healthz 200 and /snapshot returning a runs[] array required)"; tail -n 40 "$LOG" || true; exit 1
