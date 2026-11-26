#!/usr/bin/env bash
# Deploy-side smoke (员工三号 550472e4 口径): after deploy, run the fake-runner sample flow once,
# then assert the new run shows up in /snapshot. Requires the deployed workspace to include flows/ + fixtures.
set -euo pipefail
ROOT="${FORGE_ROOT:-/srv/agentforge}/current"
PORT="${FORGE_PORT:-8787}"
BASE="http://127.0.0.1:$PORT"
before="$(curl -fsS "$BASE/snapshot" | python3 -c 'import sys,json;print(sorted(r["run_id"] for r in json.load(sys.stdin)["runs"]))')" 
# 写 run 必须钉在部署根（FORGE_ROOT），否则 FORGE_ROOT 指父目录时会写到 <FORGE_ROOT>/.forge 而不是 <ROOT>/.forge
(cd "$ROOT" && FORGE_ROOT="$ROOT" FORGE_FAKE="${FORGE_FAKE:-ok}" node bin/forge.js run flows/main.yaml) >/dev/null
after="$before"
# /snapshot 是下一次请求才重算的：给最多 5 秒、每 0.5 秒重读一次，而不是立刻读一次就判失败
for _ in $(seq 1 10); do
  after="$(curl -fsS "$BASE/snapshot" | python3 -c 'import sys,json;print(sorted(r["run_id"] for r in json.load(sys.stdin)["runs"]))')"
  [ "$before" != "$after" ] && break
  sleep 0.5
done
# 3) 硬失败之前先给诊断：run 目录、事件链、/snapshot 原文各一行，定位是「没写」还是「没读到」
if [ "$before" = "$after" ]; then
  echo "SMOKE DIAG: run dirs=$(ls -1 "$ROOT/.forge/runs" 2>/dev/null | wc -l) newest=$(ls -1t "$ROOT/.forge/runs" 2>/dev/null | head -1)"
  echo "SMOKE DIAG: verify-chain=$(cd "$ROOT" && FORGE_ROOT="$ROOT" node bin/forge.js verify-chain --run "$(ls -1t "$ROOT/.forge/runs" | head -1)" 2>&1 | tail -1)"
  echo "SMOKE DIAG: /snapshot=$(curl -fsS "$BASE/snapshot" | head -c 200)"
  echo "SMOKE DIAG: /healthz=$(curl -fsS "$BASE/healthz")"
  echo "SMOKE FAIL: no new run in /snapshot after 5s (before=$before)"
  exit 1
fi
NEWRUN="$(python3 -c 'import sys,json
def ids(x):
    return set(json.loads(x.replace(chr(39),chr(34))))
print(" ".join(sorted(ids(sys.argv[2])-ids(sys.argv[1]))))' "$before" "$after")"
echo "SMOKE OK: new run visible in /snapshot (new=$NEWRUN)"
# 回填部署报告（员工一号 2e900e13 要求的顺序）：新 run id + 部署目录里最新的 run 目录 + /events 两条
NEWEST_DIR="$(ls -1t "$ROOT/.forge/runs" 2>/dev/null | head -1)"
EV0="$(curl -sN --max-time 2 "$BASE/events?since=0&run=$NEWRUN" 2>/dev/null | head -2 | cut -c1-140 | tr '\n' ' ' || true)"
EV1="$(curl -sN --max-time 2 "$BASE/events?since=1&run=$NEWRUN" 2>/dev/null | head -1 | cut -c1-120 || true)"
echo "SMOKE: 部署目录最新 run 目录 = $NEWEST_DIR；/snapshot 新 run = $NEWRUN"
for rpt in "${ROOT%/*}"/deploy-report-*.md; do
  [ -f "$rpt" ] || continue
  NEWRUN="$NEWRUN" NEWEST_DIR="$NEWEST_DIR" EV0="$EV0" EV1="$EV1" python3 - "$rpt" <<'PY4'
import os,sys
p=sys.argv[1]; e=os.environ
L=open(p,encoding="utf-8").read().split("\n")
out=[]
for l in L:
    if "新 run id：`[待填]`" in l or ("新 run id" in l and "[待填]" in l):
        out.append("- 新 run id：`%s`（本部署目录上实跑，见 /snapshot）"%e["NEWRUN"])
    elif "run 目录最新" in l and "[待填]" in l:
        out.append("- 部署目录内 run 目录最新：`%s`（= /snapshot 里的新 run id）"%e["NEWEST_DIR"])
    elif "since=0&run=<新 run>" in l:
        out.append("- `GET /events?since=0&run=%s` → `%s`"%(e["NEWRUN"],e["EV0"]))
    elif "since=1&run=<新 run>" in l:
        out.append("- `GET /events?since=1&run=%s` → `%s`（严格 > since）"%(e["NEWRUN"],e["EV1"]))
    else:
        out.append(l)
open(p,"w",encoding="utf-8").write("\n".join(out))
PY4
done
# v2.3 投影 key = (stage, iteration)，iteration 缺省视为 1：显式写 1 与缺省必须得到同样的 stage 列表
python3 - "$BASE" <<'PY2'
import sys,json,urllib.request
base=sys.argv[1]
d=json.load(urllib.request.urlopen(base+"/snapshot"))
keys=[(s.get("stage"), s.get("iteration",1)) for r in d.get("runs",[]) for s in (r.get("stages") or [])]
assert all(isinstance(i,int) and i>=1 for _,i in keys), keys
print("SMOKE OK: stage/iteration keys valid (%d stages)"%len(keys))
PY2

# v2.4 §3.1（2026-11-26 新增）：/snapshot 的 runs[] 按「最新在前」，与「最新 run」同一三档
# （manifest.run_started_at > 目录 mtime > 目录名）。这是新契约：旧版（如 main@db73141）没有此行为，
# 判红时报告里标「契约新增，旧版无此行为」，不写成"回归"。
python3 - "$ROOT" "$BASE" <<'PY3'
import sys,json,os,glob,urllib.request
ws,base=sys.argv[1],sys.argv[2]
runs=json.load(urllib.request.urlopen(base+"/snapshot")).get("runs") or []
ids=[r["run_id"] for r in runs]   # v2.4 §3.1：runs[] 元素唯一用 run_id（不加 id 别名兜底）
if len(ids)<2:
    print("SMOKE UNVERIFIED [接口待定]: runs[] 只有 %d 个 run，无法判顺序（新契约 v2.4 §3.1）"%len(ids)); sys.exit(0)
best=None
for m in sorted(glob.glob(os.path.join(ws,".forge","runs","*","manifest.json"))):
    try: d=json.load(open(m))
    except Exception: continue
    t=d.get("run_started_at") if isinstance(d,dict) else None
    if isinstance(t,str) and t and (best is None or t>best[0]): best=(t,os.path.basename(os.path.dirname(m)))
if best: latest,src=best[1],"manifest.run_started_at"
else:
    ds=sorted(glob.glob(os.path.join(ws,".forge","runs","*/")),key=lambda p:os.path.getmtime(p))
    latest,src=(os.path.basename(ds[-1].rstrip("/")) if ds else None),"目录 mtime"
assert ids[0]==latest, "runs[0]=%s 但按 %s 的最新 run=%s（契约 v2.4 §3.1 最新在前；旧版无此行为）"%(ids[0],src,latest)
print("SMOKE OK: runs[0]=%s == 最新 run（判据 %s，共 %d 个 run）"%(ids[0],src,len(ids)))
PY3
