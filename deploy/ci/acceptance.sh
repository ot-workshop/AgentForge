#!/usr/bin/env bash
# Appendix A acceptance runner (员工四号 部署侧证据). usage: acceptance.sh <workspace_dir>
# CLI 契约（员工三号 msg d6f7df6f）：--run <run_id>；--from <run 目录>；单文件用 --from-events-file
# 输出 PASS / FAIL / UNVERIFIED；UNVERIFIED 分 [P0范围外] 与 [接口待定]；FAIL>0 才非 0 退出。
set -uo pipefail
WS="${1:?usage: acceptance.sh <workspace_dir>}"
PY="${PY:-python3}"
PORT="${FORGE_PORT:-8787}"
EV=""   # 事件端点，取到 RUN_ID 后设为 "$BASE/events"（a24f_check 等函数里用）
BASE="http://127.0.0.1:$PORT"
# 端口：显式 FORGE_PORT 优先；否则取工作区 .forge-serve.pid 背后那台 serve 的 --port；都取不到就用 8787 并显式提示。
if [ -z "${FORGE_PORT:-}" ] && [ -f "$WS/.forge-serve.pid" ]; then
  PORT=8787
  for p in $(cat "$WS/.forge-serve.pid" 2>/dev/null) $(pgrep -P "$(cat "$WS/.forge-serve.pid" 2>/dev/null)" 2>/dev/null || true); do
    [ -r "/proc/$p/cmdline" ] || continue
    a=$(tr '\0' ' ' < "/proc/$p/cmdline" 2>/dev/null || true)
    case "$a" in *forge.js*serve*) PORT=$(printf '%s' "$a" | sed -n 's/.*--port[= ]\([0-9][0-9]*\).*/\1/p'); break;; esac
  done
  echo "port: $PORT (from .forge-serve.pid; 显式 FORGE_PORT 可覆盖)"
fi

FORGE="node $WS/bin/forge.js"
SSE="$WS/deploy/ci/sse_json.py"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
PASS=0; FAIL=0; SKIP=0
row(){ printf '%-11s %s\n' "$1" "$2"; }
ok(){ PASS=$((PASS+1)); row PASS "$1"; }
no(){ FAIL=$((FAIL+1)); row FAIL "$1"; }
skip(){ SKIP=$((SKIP+1)); row UNVERIFIED "$1"; }
# 区分"脚本跑不通/命令缺失"(接口待定) 与"实现缺陷"(FAIL)：stderr 一行进报告
run_forge(){ "$@" >"$TMP/out" 2>"$TMP/err"; local rc=$?; if [ $rc -eq 127 ] || grep -qiE 'command not found|E_UNKNOWN_FLAG|unknown option|unexpected argument' "$TMP/err" 2>/dev/null; then return 127; fi; return $rc; }
pyj(){ $PY -c "$@"; }

# 若工程里还没有任何 run，先用正常假 runner 跑一次（作为 A1/A5 的只读证据源；不改动被测工程）
if [ -z "$(ls -d "$WS"/.forge/runs/*/ 2>/dev/null)" ]; then
  (cd "$WS" && FORGE_FAKE=1 $FORGE run --run "baseline-$(date +%s)" --flow flows/main.yaml) >/dev/null 2>&1 || true
fi
# 只读证据源：优先 baseline-*（正常 run），避免被后续 A4/A5.8 的失败/崩溃 run 抢到
if [ -z "${RUN_DIR:-}" ]; then
  RUN_DIR=$(ls -d "$WS"/.forge/runs/baseline-*/ 2>/dev/null | sort | tail -1)
  [ -n "$RUN_DIR" ] || RUN_DIR=$(ls -d "$WS"/.forge/runs/*/ 2>/dev/null | sort | tail -1)
fi
RUN_DIR="${RUN_DIR%/}"
if [ -z "$RUN_DIR" ] || [ ! -f "$RUN_DIR/events.jsonl" ]; then
  skip "[接口待定] 前置：找不到 .forge/runs/<id>/events.jsonl"
  echo "RESULT: PASS=$PASS FAIL=$FAIL UNVERIFIED=$SKIP"; exit 1
fi
RUN_ID="$(basename "$RUN_DIR")"; RUN="$RUN_DIR/events.jsonl"
echo "workspace=$WS run_id=$RUN_ID"
EV="$BASE/events"

# ---------- 函数与非函数部分的分界：上面是顶部初始化，下面是函数定义与执行 ----------
env_ok(){ curl -fsS --max-time 3 "$BASE/healthz" >/dev/null 2>&1 || return 1
  curl -fsS --max-time 3 "$BASE/snapshot" 2>/dev/null | $PY -c 'import sys,json;assert isinstance(json.load(sys.stdin).get("runs"),list)' 2>/dev/null || return 1
  curl -sN --max-time 3 "$BASE/events?run=$RUN_ID&since=0" 2>/dev/null | grep -q '^data:' ; }
UB_OK=0; UB_FAIL=0; UB_SKIP=0
u_ok(){ UB_OK=$((UB_OK+1)); row PASS "$1"; }
u_no(){ UB_FAIL=$((UB_FAIL+1)); row FAIL "$1"; }
u_skip(){ UB_SKIP=$((UB_SKIP+1)); row UNVERIFIED "$1"; }
tail_or_err(){ [ -s "$TMP/err" ] && echo "  stderr: $(tail -1 "$TMP/err")"; }

# ---------- 部署侧 ----------
smoke(){ curl -fsS "$BASE/healthz" >/dev/null && curl -fsS "$BASE/snapshot" | pyj 'import sys,json;assert isinstance(json.load(sys.stdin).get("runs"),list)' 2>/dev/null; }
smoke && ok "DEPLOY.0 /healthz + /snapshot(runs[]) 可达" || no "DEPLOY.0 /healthz 或 /snapshot 不可用"

# ---------- A2 索引 / A2.4 SSE（第一轮：单 run 阶段） ----------
a2_check
a24_check

# ---------- A2.4f 跨 run 隔离（员工一号 ddd25693/4d4ec6e4；员工二号「seq 严格递增 + run_id 单一」判法） ----------
# f1 ?run=<id> → 帧 run_id 唯一且 == id；f2 省略 ?run= → 只含最新 run 且 seq 严格递增；
# f3 ?run=<较旧> → seq 严格递增且与 replay 一致；f4 未知 run → 4xx + 结构化 code；f5 ?run&since=k → 严格 > k。
# 前提不足（工作区 <2 个 run）记 UNVERIFIED，不记 PASS。
a24f_check(){
  local ok=u_ok no=u_no skip=u_skip
  if ! smoke; then skip "[接口待定] A2.4f (serve 不可达)"; return; fi
  # "最新 run"三档口径（员工一号 7aae7732 定）：① manifest.json 里最新一次 run.start 的时间 → ② run 目录 mtime → ③ 目录名排序。
  # 三档并列打印；f2 按第①档（有 manifest 时）判，没有 manifest 才往下回落，并在证据行写明用了哪一档。
  # 唯一键（员工一号 f14e6592 / 0156fd33 定，进 v2.4）：manifest.run_started_at（ISO-8601 UTC，= 该 run 第一条 run.start 的 ts）。
  # 缺该字段时显式打 `manifest=缺 run_started_at` 并走第②档，不保留候选名兼容层。
  pyj 'import sys,json,os,glob
ws=sys.argv[1]
best=None
for r in sorted(glob.glob(os.path.join(ws,".forge","runs","*","manifest.json"))):
    try: d=json.load(open(r))
    except Exception: continue
    t=d.get("run_started_at") if isinstance(d,dict) else None
    if not isinstance(t,str) or not t: continue
    rid=os.path.basename(os.path.dirname(r))
    if best is None or t>best[0]: best=(t,rid,t)
print(best[1] if best else "")' "$WS" > "$TMP/newest_manifest" 2>/dev/null
  mnewest=$(cat "$TMP/newest_manifest" 2>/dev/null)
  tnewest=$(ls -dt "$WS"/.forge/runs/*/ 2>/dev/null | head -1); tnewest=$(basename "${tnewest:-}")
  snewest="$(ls -d "$WS"/.forge/runs/*/ 2>/dev/null | xargs -r -n1 basename | sort | tail -1)"
  # 判据自检（员工一号 d6652635）：manifest 第①档被采用时，它记的 run_started_at 必须 == 该 run 第一条 run.start 的 ts，
  # 否则「最新 run」建立在没被证实的事实上 → 这一条 FAIL，且下面 f2 的结论降为「不成立（期望未证实）」。
  if [ -n "$mnewest" ]; then
    first_ts=$(pyj 'import sys,json
for l in open(sys.argv[1]):
  if not l.strip(): continue
  e=json.loads(l)
  if e.get("type")=="run.start": print(e.get("ts") or ""); break' "$WS/.forge/runs/$mnewest/events.jsonl" 2>/dev/null)
    mts=$(pyj 'import sys,json;d=json.load(open(sys.argv[1]));print(d.get("run_started_at") or "")' "$WS/.forge/runs/$mnewest/manifest.json" 2>/dev/null)
  fi
  if [ -n "$mnewest" ]; then newest="$mnewest"; src="manifest.run_started_at"
  elif [ -n "$tnewest" ]; then newest="$tnewest"; src="目录 mtime（无 manifest）"
  else newest="$snewest"; src="目录名排序"; fi
  [ -n "$mnewest" ] && mshow="$mnewest（run_started_at）" || mshow="缺 run_started_at"
  echo "  A2.4f 最新 run 三档：manifest=$mshow | mtime=$tnewest | 目录名=$snewest → 采用 $src → $newest"
  if [ -n "$mnewest" ] && { [ "$mnewest" != "$tnewest" ] || [ "$mnewest" != "$snewest" ]; }; then
    echo "  note: A2.4f 三档口径不一致（manifest=$mnewest mtime=$tnewest 目录名=$snewest），f2 按 $src 判，分歧可据此复算"
  fi
  f2_valid=1
  if [ -n "$mnewest" ]; then
    if [ -n "$mts" ] && [ "$mts" = "$first_ts" ]; then
      ok "A2.4f 最新 run 判据：manifest.run_started_at == 首条 run.start.ts（$mts）"
    else
      no "A2.4f 最新 run 判据：manifest.run_started_at=[$mts] != 首条 run.start.ts=[$first_ts]（同源不成立）"
      f2_valid=0
    fi
  fi
  older="$(N="$RUN_ID"; ls -d "$WS"/.forge/runs/*/ 2>/dev/null | xargs -r -n1 basename | sort | grep -vx "$N" | tail -1)"
  nrun=$(ls -d "$WS"/.forge/runs/*/ 2>/dev/null | wc -l)
  curl -sN --max-time 2 "$EV?run=$RUN_ID&since=0" > "$TMP/x1.bin" 2>/dev/null
  $PY "$SSE" "$TMP/x1.bin" > "$TMP/x1.jsonl" 2>/dev/null
  pyj 'import sys,json
L=[json.loads(l) for l in open(sys.argv[1]) if l.strip()]
ids={e.get("run_id") or e.get("run") for e in L}
assert ids and ids=={sys.argv[2]}, "?run=%s 返回的 run_id 集合=%s"%(sys.argv[2],ids)' "$TMP/x1.jsonl" "$RUN_ID" \
    && ok "A2.4f ?run=<id> 帧 run_id 唯一且等于所请求 run" || no "A2.4f ?run=$RUN_ID 的帧里出现别的 run（或为空）"
  if [ "${nrun:-0}" -ge 2 ]; then
    curl -sN --max-time 2 "$EV?since=0" > "$TMP/x2.bin" 2>/dev/null
    $PY "$SSE" "$TMP/x2.bin" > "$TMP/x2.jsonl" 2>/dev/null
    # f2 期望来源与 f3 一致：用 replay --run <最新> 生成期望，再与不带 ?run= 的 SSE 逐项比对（多余帧也算失败）
    $FORGE replay --run "$newest" --format jsonl > "$TMP/x2_rep.jsonl" 2>/dev/null
    pyj 'import sys,json
L=[json.loads(l) for l in open(sys.argv[1]) if l.strip()]
ids={e.get("run_id") or e.get("run") for e in L}
assert ids=={sys.argv[2]}, "省略 ?run= 的 run_id 集合=%s（应为 {%s}）"%(ids,sys.argv[2])
s=[e["seq"] for e in L]
assert all(b>a for a,b in zip(s,s[1:])), "seq 非严格递增: %s"%s
try: r=[json.loads(l)["seq"] for l in open(sys.argv[3]) if l.strip()]
except Exception: r=[]
assert s==r, "省略 ?run= 的序列 %s != replay --run %s 的 %s"%(s,sys.argv[2],r)' "$TMP/x2.jsonl" "$newest" "$TMP/x2_rep.jsonl" \
      && { if [ "${f2_valid:-1}" = "1" ]; then ok "A2.4f 省略 ?run= → 只有最新 run（$newest，期望=replay）、seq 严格递增且逐项相等"
           else skip "[判据不成立] A2.4f f2：帧与 replay --run $newest 一致，但「最新 run」判据红，此绿不算通过"; fi; } \
      || no "A2.4f 省略 ?run= 多 run 混流 / 与 replay --run $newest 不一致"
    if [ -n "$older" ]; then
      curl -sN --max-time 2 "$EV?run=$older&since=0" > "$TMP/x3.bin" 2>/dev/null
      $PY "$SSE" "$TMP/x3.bin" > "$TMP/x3.jsonl" 2>/dev/null
      $FORGE replay --run "$older" --format jsonl > "$TMP/x3_rep.jsonl" 2>/dev/null
      pyj 'import sys,json
a=[json.loads(l) for l in open(sys.argv[1]) if l.strip()]
ids={e.get("run_id") or e.get("run") for e in a}
assert ids=={sys.argv[2]}, "?run=%s 帧 run_id 集合=%s"%(sys.argv[2],ids)
s=[e["seq"] for e in a]
assert all(b>a2 for a2,b in zip(s,s[1:])), "seq 非严格递增: %s"%s
r=[json.loads(l)["seq"] for l in open(sys.argv[3]) if l.strip()]
assert s==r, "?run 序列 %s != replay %s"%(s,r)' "$TMP/x3.jsonl" "$older" "$TMP/x3_rep.jsonl" \
        && ok "A2.4f ?run=<较旧 run> → seq 严格递增且与 replay 一致（$older）" || no "A2.4f ?run=$older 与 replay --run 不一致或乱序"
    else skip "[接口待定] A2.4f 较旧 run 一致性（工作区里没有第二个 run）"; fi
    curl -sN --max-time 2 "$EV?run=$older&since=2" > "$TMP/x5.bin" 2>/dev/null
    $PY "$SSE" "$TMP/x5.bin" > "$TMP/x5.jsonl" 2>/dev/null
    pyj 'import sys,json
s=[json.loads(l)["seq"] for l in open(sys.argv[1]) if l.strip()]
assert all(x>2 for x in s), "since=2 仍返回 <=2 的帧: %s"%s' "$TMP/x5.jsonl" \
      && ok "A2.4f ?run&since=2 → 严格 > 2（既有 since 语义不回归）" || no "A2.4f ?run 下 since 语义被破坏（返回了 <= since 的帧）"
  else skip "[接口待定] A2.4f f2/f3/f5（工作区只有 ${nrun:-0} 个 run，需 ≥2 才能判；不记 PASS）"; fi
  code=$(curl -s --max-time 2 -o "$TMP/x4.json" -w '%{http_code}' "$EV?run=definitely-not-a-run&since=0" 2>/dev/null)
  if [ "${code:0:1}" = "4" ] && grep -qE '"code"\s*:\s*"E_[A-Z_]+"' "$TMP/x4.json" 2>/dev/null; then
    ok "A2.4f ?run=<不存在> → $code + 结构化 code"
  elif [ -s "$TMP/x4.json" ] && grep -q '^data:' "$TMP/x4.json" 2>/dev/null; then
    no "A2.4f ?run=<不存在> 返回了事件帧（静默给了别的 run 的事件）"
  else no "A2.4f ?run=<不存在> 未明确报错（code=$code，应为 4xx + E_* code）"; fi
}


# ---------- A1 投影只有一份 ----------
seqs_gt(){ pyj 'import sys,json
s=int(sys.argv[1])
for l in sys.stdin:
  l=l.strip()
  if l and json.loads(l).get("seq",0)>s: sys.stdout.write(l.rstrip("\n")+"\n")' "$1"; }
$FORGE replay --run "$RUN_ID" --format jsonl > "$TMP/rep_all.jsonl" 2>"$TMP/e1"; rc=$?
$FORGE incremental --run "$RUN_ID" --since 0 > "$TMP/inc0.jsonl" 2>"$TMP/e2"; rc2=$?
grep -qiE 'command not found|unknown option|unexpected argument' "$TMP/e1" "$TMP/e2" 2>/dev/null && rc=127
if [ $rc -eq 127 ] || [ $rc2 -eq 127 ]; then skip "[接口待定] A1.1 (CLI: replay/incremental)"; tail_or_err
elif [ $rc -eq 0 ] && [ $rc2 -eq 0 ]; then
  diff -q "$TMP/inc0.jsonl" "$TMP/rep_all.jsonl" >/dev/null && ok "A1.1 replay(全量) == incremental(--since 0)" || no "A1.1 全量/增量不一致"
else no "A1.1 replay/incremental 失败 rc(replay=$rc, incremental=$rc2)"; fi
$FORGE incremental --run "$RUN_ID" --since 7 > "$TMP/i.jsonl" 2>/dev/null && seqs_gt 7 < "$TMP/rep_all.jsonl" > "$TMP/r.jsonl" 2>/dev/null \
  && diff -q "$TMP/i.jsonl" "$TMP/r.jsonl" >/dev/null && ok A1.2 || no A1.2
# A1.3 执行命令可配置：以实现的 bundle 说明为准（员工一号 d00ff307）
A13_CMD="${A13_CMD:-node --test --test-name-pattern 'A1\.3' test/}"
(cd "$WS" && eval "$A13_CMD") >/dev/null 2>&1 && ok "A1.3 单测：只有一处投影实现（$A13_CMD）" || no "A1.3 未通过（命令：$A13_CMD）"
LAST=$(pyj 'import sys,json;print(max(json.loads(l)["seq"] for l in open(sys.argv[1]) if l.strip()))' "$RUN")
out=$($FORGE incremental --run "$RUN_ID" --since "$LAST" 2>/dev/null); [ -z "$out" ] && ok A1.4 || no A1.4
out=$($FORGE incremental --run "$RUN_ID" --since 999999 2>/dev/null); [ -z "$out" ] && ok A1.5 || no A1.5

a2_check(){
  # ---------- A2 索引可丢（只走 GET /snapshot） ----------
  if curl -fsS "$BASE/snapshot" > "$TMP/s1.json" 2>/dev/null; then
    cp -a "$RUN_DIR/.." "$TMP/runs_backup" 2>/dev/null
    rm -rf "$WS"/.forge/index* 2>/dev/null; rm -rf "$WS"/.forge/*.index* 2>/dev/null
    bash "$WS/deploy/start.sh" >/dev/null 2>&1 || true
    curl -fsS "$BASE/snapshot" > "$TMP/s2.json" 2>/dev/null
    diff -q "$TMP/s1.json" "$TMP/s2.json" >/dev/null && ok "A2.1/A2.2 删索引重启后 /snapshot 不变" || no "A2.1/A2.2 删索引后 /snapshot 变了"
    grep -qi 'index rebuilt' "$WS/.forge-serve.log" 2>/dev/null && ok "A2.3 删索引启动日志含 index rebuilt" || skip "[P0范围外] A2.3 有索引层那一步（实现无索引层，v2.4 明确不补；三份 snapshot 全等与事件源不变仍判）"
    [ "$(sha256sum "$RUN" | cut -d' ' -f1)" = "$(sha256sum "$TMP/runs_backup/$RUN_ID/events.jsonl" 2>/dev/null | cut -d' ' -f1)" ] && ok "A2 事件源未被索引操作改动" || no "A2 事件源在索引操作中被改动"
  else skip "[接口待定] A2 (GET /snapshot 不可用)"; fi
}

a24_check(){
  local ok=u_ok no=u_no skip=u_skip
  # 断线 = 客户端 close（curl --max-time 到期）；报告三行：断线方式/本项覆盖/未覆盖。
  if smoke; then
    # cut=0（首次连接没读到任何完整帧）→ 采样无效，最多重采 2 次
    for attempt in 1 2 3; do
      curl -sN --max-time 2 "$BASE/events?run=$RUN_ID&since=0" > "$TMP/sse_raw.bin" 2>/dev/null; rc=$?
      head -c 200 "$TMP/sse_raw.bin" > "$TMP/sse_head200.txt"
      $PY "$SSE" "$TMP/sse_raw.bin" > "$TMP/sse_cut.jsonl" 2>"$TMP/sse.err"; sse_rc=$?
      cut_n=$(pyj 'import sys,json
  n=0
  for l in open(sys.argv[1]):
    if l.strip(): n=max(n,json.loads(l)["seq"])
  print(n)' "$TMP/sse_cut.jsonl" 2>/dev/null || echo 0)
      [ "$cut_n" != "0" ] && break
    done
    $FORGE replay --run "$RUN_ID" --format jsonl > "$TMP/rep_all.jsonl" 2>/dev/null
    seqs_gt "$cut_n" < "$TMP/rep_all.jsonl" > "$TMP/rep_rest.jsonl" 2>/dev/null
    curl -sN --max-time 3 "$BASE/events?run=$RUN_ID&since=$cut_n" > "$TMP/sse_rest.bin" 2>/dev/null; rc2=$?
    # curl 18/52 = 服务端主动关闭/传输中断，长连接下正常；不记失败
    $PY "$SSE" "$TMP/sse_rest.bin" > "$TMP/sse_rest.jsonl" 2>>"$TMP/sse.err"; sse_rc2=$?
    if [ "$cut_n" = "$LAST" ]; then
      # cut == 末 seq → 空集分支：200 + 零帧 + 服务端主动关闭（curl 0/18 算已关闭，28 记 FAIL）
      curl -sN --max-time 3 -o "$TMP/sse_empty2.bin" -w '%{http_code}' "$BASE/events?run=$RUN_ID&since=$cut_n" > "$TMP/sse_empty_code" 2>/dev/null; erc=$?
      hc=$(cat "$TMP/sse_empty_code" 2>/dev/null)
      if [ "$hc" != "200" ]; then no "A2.4e since=末seq 期望 200，实际 $hc"
      elif [ $erc -eq 28 ]; then no "A2.4e since=末seq 连接挂住（curl 超时）"
      elif [ -s "$TMP/sse_empty2.bin" ]; then no "A2.4e since=末seq 返回了帧"
      else ok "A2.4e since=末seq → 200 + 零帧 + 服务端主动关闭"; fi
    elif [ "$cut_n" = "0" ] && [ "$attempt" = "3" ]; then skip "[接口待定] A2.4 三次采样 cut=0（首帧延迟；证据见 tmp）"
    elif [ "$cut_n" = "0" ]; then skip "[采样无效] A2.4 单次 cut=0，抖动，丢弃该次采样"
    elif [ ! -s "$TMP/rep_rest.jsonl" ] && [ ! -s "$TMP/sse_cut.jsonl" ]; then skip "[接口待定] A2.4 (无事件或 SSE 不可读)"; tail_or_err
    elif [ $sse_rc -eq 3 ] || [ $sse_rc2 -eq 3 ]; then no "A2.4 SSE 出现坏帧: $(grep 'bad frame' "$TMP/sse.err" | head -1)"
    elif [ -s "$TMP/sse_cut.jsonl" ] && ! grep -q 'data:' "$TMP/sse_head200.txt"; then no "A2.4 SSE 帧不符标准（前 200 字节无 data:）"
    else
      cp "$TMP/sse_rest.jsonl" "$TMP/sse_rest_seq.jsonl"
      # 收尾（v2.4 附录 A2.4 注记，员工一号 3fb35718 / 员工五号 7d9d420b）：
      # 判"重连拿到的集合是否正确"，不判"服务端推得够久"；早停用期望集前缀比对，读满 --max-time 才全等；
      # closedBy 写进证据供审计。仅凭 curl 退出码区分不了"早停"与"读满"，故同时记录退出码与前缀/全等结论。
      if [ "${rc2:-0}" -eq 28 ]; then
        pyj 'import sys,json
  cut=int(sys.argv[3])
  got=[json.loads(l)["seq"] for l in open(sys.argv[1]) if l.strip()]
  exp=[json.loads(l)["seq"] for l in open(sys.argv[2]) if l.strip()]
  assert not [s for s in got if s<=cut], "旧帧被补发: %s"%[s for s in got if s<=cut]
  assert got==exp, "重连集合 %s != 从头重放集合 %s"%(got,exp)' "$TMP/sse_rest.jsonl" "$TMP/rep_rest.jsonl" "$cut_n" \
          && ok "A2.4 断线+重连 == 从头重放 (since=$cut_n, 读到 --max-time)" || no "A2.4 断线+重连 != 从头重放 (since=$cut_n)"
      else
        pyj 'import sys,json
  cut=int(sys.argv[3])
  got=[json.loads(l)["seq"] for l in open(sys.argv[1]) if l.strip()]
  exp=[json.loads(l)["seq"] for l in open(sys.argv[2]) if l.strip()]
  assert not [s for s in got if s<=cut], "旧帧被补发: %s"%[s for s in got if s<=cut]
  assert got and got==exp[:len(got)], "前缀不符: %s"%got' "$TMP/sse_rest.jsonl" "$TMP/rep_rest.jsonl" "$cut_n" \
          && ok "A2.4 断线+重连（实现提前关闭，前缀一致）" || no "A2.4 断线+重连前缀不一致 (since=$cut_n)"
        echo "  note: 服务端提前关闭连接（P0 未规定非空集关闭时机；curl rc=$rc2）"
      fi
      # A2.4c 并发两条连接互不影响（不需要假 serve：两次并行 since=0，解析后的 seq 序列必须相同）
      curl -sN --max-time 2 "$BASE/events?run=$RUN_ID&since=0" > "$TMP/c1.bin" 2>/dev/null & C1=$!
      curl -sN --max-time 2 "$BASE/events?run=$RUN_ID&since=0" > "$TMP/c2.bin" 2>/dev/null & C2=$!
      wait $C1 $C2 2>/dev/null
      $PY "$SSE" "$TMP/c1.bin" > "$TMP/c1.jsonl" 2>/dev/null
      $PY "$SSE" "$TMP/c2.bin" > "$TMP/c2.jsonl" 2>/dev/null
      if [ -s "$TMP/c1.jsonl" ] && [ -s "$TMP/c2.jsonl" ]; then
        pyj 'import sys,json
  a=[json.loads(l)["seq"] for l in open(sys.argv[1]) if l.strip()]
  b=[json.loads(l)["seq"] for l in open(sys.argv[2]) if l.strip()]
  assert a==b' "$TMP/c1.jsonl" "$TMP/c2.jsonl" && ok "A2.4c 两条并发连接 seq 序列相同（互不影响）" || no "A2.4c 并发连接结果不一致"
      else skip "[接口待定] A2.4c (并发连接未读到完整帧)"; fi
      # 断开期间写入 + 补发：需事件注入入口
      skip "[接口待定] A2.4c-补发（需 forge append --event-file）"
      # A2.4a④ since 非数字 → 400 + E_INVALID_QUERY
      code=$(curl -s -o "$TMP/badq.json" -w '%{http_code}' "$BASE/events?since=abc" 2>/dev/null)
      [ "$code" = "400" ] && grep -q 'E_INVALID_QUERY' "$TMP/badq.json" && ok "A2.4a④ since=abc → 400 + E_INVALID_QUERY" || no "A2.4a④ 非法 since 未返回 400/E_INVALID_QUERY (code=$code)"
      # 空结果连接必须正常结束（不挂到超时）
      curl -sN --max-time 3 "$BASE/events?run=$RUN_ID&since=999999" > "$TMP/sse_empty.bin" 2>/dev/null; erc=$?
      [ $erc -ne 28 ] && [ ! -s "$TMP/sse_empty.bin" ] && ok "A2.4b since>末seq → 零帧且连接正常结束" || no "A2.4b 空结果连接挂住或发了帧 (curl rc=$erc)"
      { echo "A2.4 证据：断线方式=客户端 close（非网络中断）；本项覆盖=服务端按 since 补发；未覆盖=网络中断期间的写出失败处理 [P0范围外]";
        echo "SSE 原始前 200 字节："; head -c 200 "$TMP/sse_head200.txt"; echo; } > "$TMP/a24_evidence.txt"
    fi
  else skip "[接口待定] A2.4 (serve 不可达)"; fi
}

# ---------- 造第二个 run，再跑一轮 A2.4：A2.4f 的 f2/f3/f5 只有 ≥2 个 run 时才能判 ----------
PRE_RUNS=$(ls -d "$WS"/.forge/runs/*/ 2>/dev/null | wc -l)
(cd "$WS" && FORGE_FAKE=1 $FORGE run --run "a24f-2nd-$(date +%s%N)" --flow flows/main.yaml) >/dev/null 2>&1; r2rc=$?
POST_RUNS=$(ls -d "$WS"/.forge/runs/*/ 2>/dev/null | wc -l)
if [ $r2rc -eq 0 ] && [ "$POST_RUNS" -gt "$PRE_RUNS" ]; then
  echo "A2.4f 第二轮前提：新起 run 后工作区共 $POST_RUNS 个 run（第二轮 A2.4/A2.4f 结果如下）"
  a24_check; a24f_check
else
  echo "A2.4f 第二轮前提：新 run 未产生（rc=$r2rc，runs $PRE_RUNS → $POST_RUNS），f2/f3/f5 记 UNVERIFIED"
  a24f_check
fi
UB_OK=${UB_OK:-0}; UB_FAIL=${UB_FAIL:-0}; UB_SKIP=${UB_SKIP:-0}
PASS=$((PASS+UB_OK)); FAIL=$((FAIL+UB_FAIL)); SKIP=$((SKIP+UB_SKIP))


# ---------- A3 同一校验器 / 结构化错误 ----------
assert_errs(){ $PY -c '
import sys,json
KEYS={"code","severity","locatable","path","ids","fix"}
d=json.load(sys.stdin); errs=d.get("errors") or ([d] if "code" in d else [])
assert errs, "no errors"
for e in errs: assert KEYS<=set(e), "missing %s in %s"%(KEYS-set(e), e.get("code"))'; }
(cd "$WS" && run_forge $FORGE validate flows/main.yaml); rc=$?
if [ $rc -eq 127 ]; then skip "[接口待定] A3.1 (validate 命令不可用)"; tail_or_err
elif [ $rc -eq 0 ] && pyj 'import sys,json;assert json.load(open(sys.argv[1])).get("errors",[])==[]' "$TMP/out" 2>/dev/null; then ok A3.1
else no "A3.1 合法 flow 校验失败"; fi
if [ -f "$WS/fixtures/cycle.yaml" ]; then
  run_forge $FORGE validate "$WS/fixtures/cycle.yaml" --json; rc=$?
  if [ $rc -eq 127 ]; then skip "[接口待定] A3.2 (validate --json 不可用)"; tail_or_err
  elif [ $rc -ne 0 ] && pyj 'import sys,json
e=json.load(open(sys.argv[1])).get("errors",[])
assert e, "no errors"
for x in e:
    assert x.get("code") and x.get("path"), "missing code/path: %s"%x
    if x.get("locatable", True): assert x.get("ids") or x.get("nodeId") or x.get("edgeId"), "locatable error without id: %s"%x.get("code")' "$TMP/out" 2>/dev/null; then ok "A3.2 结构化错误（locatable=true 者均带 id）"
  elif [ $rc -eq 0 ]; then no "A3.2 非法 flow 竟通过校验"
  else no "A3.2 错误缺 code/path/id"; tail_or_err; fi
else skip "[接口待定] A3.2 (无 fixtures/cycle.yaml)"; fi
# 期望 code 的固定映射在 fixtures/expected-codes.tsv（从 v2 附录 A 的 A3.3 表抄来；首行须为 `# source: agentforge-v2.md §A3.3`）
EXPECT_MAP="${EXPECT_MAP:-$WS/fixtures/expected-codes.tsv}"
if [ -f "$EXPECT_MAP" ]; then
  while IFS=$'\t' read -r name expected; do
    [ -n "${name:-}" ] || continue; case "$name" in \#*) continue;; esac
    f="$WS/fixtures/$name"
    [ -f "$f" ] || { no "A3.3 $name 缺失（映射表要求）"; continue; }
    $FORGE validate "$f" --json >"$TMP/o" 2>/dev/null; rc=$?
    if [ $rc -eq 127 ]; then skip "[接口待定] A3.3 $name"; continue; fi
    [ $rc -eq 1 ] && pyj 'import sys,json;d=json.load(open(sys.argv[1]));print(" ".join(e.get("code","") for e in (d.get("errors") or [])))' "$TMP/o" 2>/dev/null | grep -qw "$expected" \
      && ok "A3.3 $name ($expected)" || no "A3.3 $name 期望 $expected 未出现 (rc=$rc)"
  done < "$EXPECT_MAP"
  # 双向：码表 fixture 列点名的文件必须在映射表里有行 → 否则 FAIL（员工一号 0218cd15）：
  #   只要求「码表点名的文件」；未被点名的 fixture（P0.5 素材如 limit-*、静态约束 p0-unsupported-*）
  #   不要求登记，避免「P0 夹具」和「P0.5 素材」混判。
  for n in $(sed -n 's/^| *`\(E_[A-Z_]*\)` *|.*| *`\(fixtures\/[^`]*\)`.*/\2/p' "$WS/docs/error-codes.md" 2>/dev/null | xargs -r -n1 basename); do
    grep -qE "^${n//./\\.}[[:space:]]" "$EXPECT_MAP" || no "A3.3 $n 在映射表中缺失（码表 fixture 列点名）"
  done
  # 完备性（v2.4 A3.3 注记，员工一号 95977093）：只比对「规则类」码。
  #   规则类：tsv 有 fixture 行，或 tsv 有 `# doc-only:` 登记；未登记 → 缺失。
  #   序列类 / 运行期请求期类：两边都排除，不要求登记。
  #   类别优先取表格行里的类别列/说明；取不到类别按规则类判（保守）。
  if [ -f "$WS/docs/error-codes.md" ]; then
    $PY - "$WS/docs/error-codes.md" "$EXPECT_MAP" "$TMP" <<'P6'
import re,sys,os
doc,tsv,tmp=sys.argv[1],sys.argv[2],sys.argv[3]
# v2.4 A3.3 固定表头（员工一号 b52a1237/9c02981f）：
#   | code | severity | locatable | fix | class | fixture |   class ∈ rule|sequence|runtime
# 按表头名取列，不按位置；缺失/拼错 class 按 rule 保守判。
SEQ={"E_EVENT_CORRUPT","E_CHAIN_HASH_MISMATCH","E_EVENT_SEQ_GAP","E_REF_DRIFT_ORDER",
     "E_ILLEGAL_STAGE_WRITE","E_STAGE_FAILED","E_BLOCK_CONTENT_DRIFT","E_FLOW_CONTENT_DRIFT"}
RUN={"E_EVENTS_LOCKED","E_INVALID_QUERY","E_FILE_NOT_FOUND","E_INVALID_ARGS"}
def cells(line):
    return [c.strip().strip("`") for c in line.strip().strip("|").split("|")]
cat={}; doc_codes=set(); header=None; tsv_codes_hint=set()
for line in open(doc,encoding="utf-8"):
    if not line.lstrip().startswith("|"): continue
    cols=cells(line)
    if header is None and "code" in [c.lower() for c in cols]:
        header=[c.lower() for c in cols]; continue
    if not cols or not re.fullmatch(r"E_[A-Z_]+",cols[0]): continue
    code=cols[0]; doc_codes.add(code)
    cls=None
    raw=None
    if header and "class" in header and len(cols)>header.index("class"):
        raw=cols[header.index("class")].lower()
    if header and "fixture" in header and len(cols)>header.index("fixture"):
        fx=cols[header.index("fixture")]
        if fx.startswith("fixtures/"): tsv_codes_hint.add(fx.split("/",1)[1])
        elif fx not in ("—","-",""):
            # fixture 列不是路径（写了说明文字）：行是坏的，报前置失败。
            open(os.path.join(tmp,"badfix"),"a").write("BADFIXTURE %s=%r\n" % (code, fx[:80]))
    cls=raw
    if cls is None:
        # class 列缺失 → 按规则类保守判（v2.4，员工一号 ea530d68）；
        # 旧表（无 class 列）走回退：固定三组常量 + 说明列文本，再兜底 rule。
        if header and "class" in header: cls="rule"
        else:
            rest=line.lower()
            cls = "sequence" if ("序列" in rest or "sequence" in rest) else ("runtime" if ("运行期" in rest or "请求期" in rest or "runtime" in rest or "request" in rest) else "rule")
            if code in SEQ: cls="sequence"
            elif code in RUN: cls="runtime"
    cat[code]=cls

# class 列拼错 / fixture 列不是路径：读表方拒绝解析（员工一号 ea530d68），整表不判（前置失败，退出码 9）
bad=[]
for line in open(doc,encoding="utf-8"):
    if not line.lstrip().startswith("|"): continue
    cols=cells(line)
    if not cols or not re.fullmatch(r"E_[A-Z_]+",cols[0]):
        if "code" in [c.lower() for c in cols]: _hdr=[c.lower() for c in cols]
        continue
    if "_hdr" in globals() and "class" in _hdr and len(cols)>_hdr.index("class"):
        raw=cols[_hdr.index("class")].lower()
        if raw and raw not in ("rule","sequence","runtime"): bad.append(("BADCLASS",cols[0],raw))
    if "_hdr" in globals() and "fixture" in _hdr and len(cols)>_hdr.index("fixture"):
        fx=cols[_hdr.index("fixture")]
        if not (fx.startswith("fixtures/") or fx in ("—","-","")): bad.append(("BADFIXTURE",cols[0],fx[:80]))
if bad:
    open(os.path.join(tmp,"badclass"),"a").write("\n".join("%s %s=%r"%b for b in bad)+"\n"); sys.exit(9)
if os.path.exists(os.path.join(tmp,"badfix")):
    sys.exit(9)

open(os.path.join(tmp,"fixture_hint"),"w").write("\n".join(sorted(tsv_codes_hint)))
def kind(c):
    # 权威：class 列；回退：固定三组（v2.4 class 列落地前的临时路径，员工一号 915452bd）
    return cat.get(c) or ("sequence" if c in SEQ else "runtime" if c in RUN else "rule")
tsv_codes=set(); doconly=set()
for line in open(tsv,encoding="utf-8"):
    if line.startswith("#"):
        doconly.update(re.findall(r"E_[A-Z_]+",line)); continue
    f=line.rstrip("\n").split("\t")
    if len(f)>1 and re.fullmatch(r"E_[A-Z_]+",f[1]): tsv_codes.add(f[1])
rule_doc={c for c in doc_codes if kind(c)=="rule"}
covered=tsv_codes|doconly
missing=sorted(c for c in rule_doc if c not in covered)
extra=sorted(c for c in tsv_codes if c not in doc_codes)
open(os.path.join(tmp,"missing"),"w").write(" ".join(missing))
open(os.path.join(tmp,"extra"),"w").write(" ".join(extra))
open(os.path.join(tmp,"detail"),"w").write(
  "规则类缺失=%d %s\n非规则类从两边排除：序列类 %d、运行期类 %d\n多余(tsv有文档无)=%d %s\n表头=%s\n" % (
   len(missing), missing,
   len([c for c in doc_codes if kind(c)=="sequence"]), len([c for c in doc_codes if kind(c)=="runtime"]),
   len(extra), extra, header))
P6
    p6rc=$?
    # 文档 fixture 列登记过、但 tsv 没有行的 fixture：按「tsv 行」等价核对（正式仍要员工三号补 tsv 行）
    if [ -s "$TMP/fixture_hint" ]; then
      while read -r n; do
        [ -n "$n" ] || continue
        grep -qE "^${n//./\\.}[[:space:]]" "$EXPECT_MAP" || no "A3.3 $n 在映射表中缺失（文档 fixture 列已登记，tsv 无行）"
      done < "$TMP/fixture_hint"
      echo "  A3.3 note: 文档 fixture 列登记的 $(grep -c . "$TMP/fixture_hint") 个 fixture 已逐个核对 tsv 行"
    fi
    # 9 = 前置失败（码表不可解析），不是 A3.3 判据 FAIL；报告里单列
    # 前置失败时 P6 在写 detail 前退出，detail 不生成；合成一行，保证明细行永远可读
    if [ ! -s "$TMP/detail" ]; then
      if [ -s "$TMP/badclass" ]; then printf "前置失败(码表不可解析) 未做完备性比对; 问题行: %s\n" "$(tr '\n' ' ' < "$TMP/badclass")" > "$TMP/detail"
      elif [ -s "$TMP/badfix" ]; then printf "前置失败(码表不可解析) 未做完备性比对; 问题行: %s\n" "$(tr '\n' ' ' < "$TMP/badfix")" > "$TMP/detail"
      else printf "前置失败 rc=%s，未做完备性比对\n" "$p6rc" > "$TMP/detail"; fi
    fi
    if [ "$p6rc" -eq 9 ] && [ -s "$TMP/badfix" ]; then no "[前置失败] 码表 fixture 列不是 fixture 路径（写了说明文字），表格行不成立：$(tr '\n' ' ' < "$TMP/badfix" | head -c 200)"
    elif [ "$p6rc" -eq 9 ]; then no "[前置失败] 码表 class 列有非法值（拼错或非 rule|sequence|runtime），拒绝解析：$(tr '\n' ' ' < "$TMP/badclass" 2>/dev/null | head -c 200)"
    elif [ "$p6rc" -ne 0 ]; then no "A3.3 完备性：解析码表失败 (rc=$p6rc)"
    elif [ -s "$TMP/missing" ] || [ -s "$TMP/extra" ]; then
      no "A3.3 完备性（仅规则类）：$(head -c 220 "$TMP/detail" | tr '\n' ' ')"
    else ok "A3.3 完备性（仅规则类）：文档规则类 == tsv ∪ doc-only"; fi
    echo "  A3.3 明细：$(tr '\n' '|' < "$TMP/detail")"
  else skip "[接口待定] A3.3 完备性（缺 docs/error-codes.md）"; fi
else skip "[接口待定] A3.3 (缺 fixtures/expected-codes.tsv，随 v2 附录 A 提供)"; fi
skip "[P0范围外] A3.4 画布无损还原（P0.5）"
skip "[P0范围外] A3.5 画布与 CLI 错误列表一致（P0.5）"

# ---------- A4 推进墙 / 判分墙 / 锁守卫 ----------
for pair in "A4.2 no-evidence" "A4.3 bad-submit"; do
  set -- $pair; id=$1; mode=$2
  (cd "$WS" && env FORGE_FAKE=$mode $FORGE run --run "a4-$mode-$(date +%s%N)" --flow flows/main.yaml) >/dev/null 2>&1 && no "$id 假 runner=$mode 竟成功" || ok "$id 假 runner=$mode 失败"
done
# A4.4 越权四条合取（v2.4 注记）：(check.result=fail 或 stage.end=failed) 且 结构化越权 error(path 指 checks.lock) 且 **runner 没改成 tampered** 且 退出码非 0
# 探针有效性前置（员工一号 a7590379）：先确认 fake runner 会写、且写的就是本包保护的那个 <run>/checks.lock。
# 「sha 不变」的比对基准 = run 自己在 stage 前重建的那份 lock（员工一号 8b3e3017 裁定）：探针预置的种子文件一定会被重建覆盖，
# 所以判「被保护文件未被改坏」= 运行后内容仍是重建值，不得是 'tampered'（员工四号 42736c8a 实测：修好 fixture 后 after 就是 tampered）。
# 探针没命中 → UNVERIFIED（探针无效），不判实现 FAIL。
T4ID="a4-touch-$(date +%s%N)"
T4DIR="$WS/.forge/runs/$T4ID"; mkdir -p "$T4DIR"; printf 'original-checker\n' > "$T4DIR/checks.lock"
T4EXIST1=$([ -e "$T4DIR/checks.lock" ] && echo yes || echo no)
T4SHA1=$(sha256sum "$T4DIR/checks.lock" | cut -d' ' -f1)
(cd "$WS" && env FORGE_FAKE=touch-checks FORGE_CHECKS_FILE=".forge/runs/$T4ID/checks.lock" $FORGE run --run "$T4ID" --flow flows/main.yaml) >/dev/null 2>&1; t4rc=$?
T4EXIST2=$([ -e "$T4DIR/checks.lock" ] && echo yes || echo no)
T4SHA2=$(sha256sum "$T4DIR/checks.lock" | cut -d' ' -f1)
echo "  A4.4 探针证据: 被保护文件 <run>/checks.lock 运行前存在=$T4EXIST1 sha=${T4SHA1:0:16}；运行后存在=$T4EXIST2 sha=${T4SHA2:0:16}；rc=$t4rc"
T4EV="$T4DIR/events.jsonl"
T4PROBE=0
[ -f "$T4EV" ] && pyj 'import sys,json
L=[]
for l in open(sys.argv[1]):
    if l.strip():
        try: L.append(json.loads(l))
        except json.JSONDecodeError: pass
failed=any((e.get("payload") or {}).get("status")=="failed" for e in L if e.get("type") in ("stage.end","check.result"))
viol=[e for e in L if "code" in json.dumps(e.get("payload") or {}) and "checks.lock" in json.dumps(e.get("payload") or {})]
sys.exit(0 if failed and viol else 1)' "$T4EV" 2>/dev/null && T4PROBE=1
# 探针命中判定（员工一号 a7590379；基线按 8b3e3017 裁定，员工四号 691670e6 修）：
#   run 启动必重建 checks.lock，探针预置的种子 sha 必变，所以「sha 不变」不能拿种子当 before；
#   「被保护文件未被写坏」= 运行后内容不是 runner 写的 tampered。
T4TAMPERED=0
[ "$T4EXIST2" = yes ] && [ -f "$T4DIR/checks.lock" ] && [ "$(cat "$T4DIR/checks.lock" 2>/dev/null)" = "tampered" ] && T4TAMPERED=1
echo "  A4.4 判定: 越权 error+失败态=$T4PROBE tampered=$T4TAMPERED rc=$t4rc"
if [ "$t4rc" -eq 0 ]; then
  skip "[探针无效] A4.4 实现未拒绝越权写（rc=0；可能是 FORGE_CHECKS_FILE 漏传导致的探针未命中，不判实现 FAIL）"
elif [ "$T4PROBE" -eq 1 ] && [ "$T4TAMPERED" -eq 1 ]; then
  # 员工二号 a0f3e9a5：fake runner 先写 tampered 再交 Submit、编排器同步比对，
  # 「检测到 + 报码 + 文件不变」在此时序下不可同时成立 ⇒ 拆成两行：检测 PASS + 「内容不变」[探针无效]。
  ok "A4.4 越权被检测并报码（失败态 / E_PERMISSION_GAP 指 checks.lock / rc=$t4rc）"
  skip "[探针无效] A4.4 「checker 文件 sha 不变」（after=tampered；当前 fixture 先写后交，无法观测事前拒绝，不记实现缺陷）"
elif [ "$T4PROBE" -eq 1 ]; then
  ok "A4.4 越权四条全中（失败态 / 越权 error 指 checks.lock / 被保护文件未被写坏 / rc=$t4rc）"
else
  no "A4.4 越权四条未全中：失败态/越权 error 缺失（rc=$t4rc）"
fi

T1ID="a4-forge-stage-end-$(date +%s%N)"
(cd "$WS" && env FORGE_FAKE=forge-stage-end $FORGE run --run "$T1ID" --flow flows/main.yaml) >/dev/null 2>&1; t1rc=$?
if [ -f "$WS/.forge/runs/$T1ID/events.jsonl" ]; then
  pyj 'import sys,json
L=[json.loads(l) for l in open(sys.argv[1]) if l.strip()]
sys.exit(0 if any(e.get("type")=="E_ILLEGAL_STAGE_WRITE" or json.dumps(e).find("E_ILLEGAL_STAGE_WRITE")>=0 for e in L) else 1)' "$WS/.forge/runs/$T1ID/events.jsonl" \
    && ok "A4.1 假 runner 越权写 stage.end 被拒（记结构化 error，rc=$t1rc）" || no "A4.1 越权写未被识别 (rc=$t1rc)"
  $FORGE verify-chain --from-events-file "$WS/.forge/runs/$T1ID/events.jsonl" >/dev/null 2>&1 && ok "A4.1-链 该 run 链完好" || no "A4.1-链 链损坏"
else skip "[接口待定] A4.1 (无事件流)"; fi
skip "[P0范围外] A4.5 checker 子进程观测"
# A5.12/A4.6a 锁守卫（v2.4 附录 A A5.12 新原文，员工一号 2a74bb9c）：
#   探针必须针对实现实际使用的锁（本包为原子目录锁 <run>/.events.lock），且 forge run / forge append 两条都测；
#   事件片段必须非空；空片段提前返回不作证据。
LOCKID="lock-$(date +%s%N)"
(cd "$WS" && FORGE_FAKE=1 $FORGE run --run "$LOCKID" --flow flows/main.yaml) >/dev/null 2>&1 || true
LOCKDIR="$WS/.forge/runs/$LOCKID"
printf '%s\n' '{"type":"probe.note","stage":"design","payload":{"note":"lock probe"}}' > "$TMP/probe-ev.jsonl"
if [ -f "$LOCKDIR/events.jsonl" ]; then
  sha_b=$(sha256sum "$LOCKDIR/events.jsonl" | cut -d' ' -f1)
  mkdir -p "$LOCKDIR/.events.lock"
  (cd "$WS" && $FORGE append --run "$LOCKID" --event-file "$TMP/probe-ev.jsonl" --json) >"$TMP/o" 2>"$TMP/e"; arc=$?
  (cd "$WS" && FORGE_FAKE=1 $FORGE run --run "$LOCKID" --flow flows/main.yaml) >"$TMP/o2" 2>&1; rrc=$?
  sha_a=$(sha256sum "$LOCKDIR/events.jsonl" | cut -d' ' -f1)
  rmdir "$LOCKDIR/.events.lock" 2>/dev/null || true
  if [ "$arc" -eq 1 ] && grep -q E_EVENTS_LOCKED "$TMP/o" "$TMP/e" 2>/dev/null && [ "$sha_b" = "$sha_a" ]; then
    ok "A5.12 append 在被锁时拒绝（rc=1 + E_EVENTS_LOCKED + 文件未改）"
  else no "A5.12 append 在被锁时未拒绝 (rc=$arc)：$(head -c 160 "$TMP/o" "$TMP/e" 2>/dev/null | tr '\n' ' ')"; fi
  if [ "$rrc" -eq 1 ] && grep -q E_EVENTS_LOCKED "$TMP/o2" 2>/dev/null; then
    ok "A5.12 forge run 在被锁时拒绝（rc=1 + E_EVENTS_LOCKED）"
  else no "A5.12 forge run 在被锁时未拒绝 (rc=$rrc)"; fi
  (cd "$WS" && FORGE_FAKE=1 $FORGE run --run "lock-after-$(date +%s%N)" --flow flows/main.yaml) >/dev/null 2>&1 \
    && ok "A5.12 锁释放后可正常起新 run" || no "A5.12 锁释放后仍被拒"
  $FORGE verify-chain --from-events-file "$LOCKDIR/events.jsonl" >/dev/null 2>&1 && ok "A4.6b 被锁文件链完好" || no "A4.6b 被锁文件链损坏"
else skip "[接口待定] A5.12 (无法创建测试 run)"; fi

# A4.4c / A5.5 / A5.6 共用同一份解析结果（苦力三号 a980f6db）
pyj 'import sys,json
L=[json.loads(l) for l in open(sys.argv[1]) if l.strip()]
json.dump(L, open(sys.argv[2],"w"))' "$RUN" "$TMP/events_parsed.json"
# A4.6c（正常路径，与 A5.9 拆开）：FORGE_FAKE=1 正常跑完 → 退出码 0、链通过、无 warn、无 ref.drift
NRUN="$WS/.forge/runs/normal-$RUN_ID"
(cd "$WS" && FORGE_FAKE=1 $FORGE run --run "normal-$(date +%s)" --flow flows/main.yaml) >/dev/null 2>&1; nrc=$?
NRUN="$WS/.forge/runs/$(cd "$WS" && ls -1t .forge/runs | head -1)"
NEV="$NRUN/events.jsonl"
if [ $nrc -ne 0 ] || [ ! -f "$NEV" ]; then skip "[接口待定] A5.9 (正常 run 失败或 --out-dir 不支持，rc=$nrc)"
else
  pyj 'import sys,json
L=[json.loads(l) for l in open(sys.argv[1]) if l.strip()]
json.dump(L, open(sys.argv[2],"w"))
sys.exit(0 if not any(e.get("severity")=="warn" for e in L) and not any(e.get("type")=="ref.drift" for e in L) else 1)' "$NEV" "$TMP/normal_parsed.json" \
    && ok "A4.6c 正常 run：退出码 0、无 warn、无 ref.drift" || no "A4.6c 正常 run 出现 warn/ref.drift"
  $FORGE verify-chain --from-events-file "$NEV" >/dev/null 2>&1 && ok "A4.6c-链 正常 run 链完好" || no "A4.6c-链 正常 run 链损坏"
fi

# ---------- A5 事件流完整性 ----------
$FORGE verify-chain --run "$RUN_ID" >/dev/null 2>&1 && ok A5.4 || no A5.4
pyj 'import sys,json
has=json.load(open(sys.argv[1]))
sys.exit(1 if any(e.get("type")=="ref.drift" for e in has) else 0)' "$TMP/events_parsed.json" && ok "A5.6 无 --allow-drift 时不出现 ref.drift" || no "A5.6 出现意外的 ref.drift"
pyj 'import sys,json
L=json.load(open(sys.argv[1]))
fs=min([e["seq"] for e in L if str(e.get("type","")).endswith("stage.start")] or [10**9])
d=[e["seq"] for e in L if e.get("type")=="ref.drift"]
sys.exit(0 if len(d)<=1 and all(x<fs for x in d) else 1)' "$TMP/events_parsed.json" && ok A5.5 || no "A5.5 无漂移的 run 里 ref.drift 至多一条且早于 stage.start"
# A5.5b（新增判据，员工二号 7b08b0e3）：**真有漂移 + --allow-drift** → ref.drift 恰好 1 条，且 seq 小于首个 stage.start。
# 原来的 A5.5 只用「≤1」，一条都没有也算过，所以这条恒绿；这里单独造漂移再判。
DRW="$TMP/driftws"; mkdir -p "$DRW"
for d in bin src flows blocks fixtures agents checks; do [ -e "$WS/$d" ] && cp -a "$WS/$d" "$DRW/" 2>/dev/null; done
[ -f "$WS/package.json" ] && cp -a "$WS/package.json" "$DRW/"
if [ -d "$DRW/flows" ] && [ -f "$DRW/blocks/design/v1.yaml" ]; then
  (cd "$DRW" && FORGE_ROOT="$DRW" FORGE_FAKE=1 $FORGE run --run dr-base --flow "$DRW/flows/main.yaml") >/dev/null 2>&1; drb=$?
  printf '\n# a5.5b drift probe\n' >> "$DRW/blocks/design/v1.yaml"
  (cd "$DRW" && FORGE_ROOT="$DRW" FORGE_FAKE=1 $FORGE run --run dr-no --flow "$DRW/flows/main.yaml") >/dev/null 2>&1; drn=$?
  if [ "$drn" -eq 0 ]; then skip "[接口待定] A5.5b (无 --allow-drift 时漂移未被拒绝)"
  else
    (cd "$DRW" && FORGE_ROOT="$DRW" FORGE_FAKE=1 $FORGE run --run dr-allow --flow "$DRW/flows/main.yaml" --allow-drift) >/dev/null 2>&1; dra=$?
    if [ "$dra" -ne 0 ]; then no "A5.5b 有漂移 + --allow-drift 应接受（rc=$dra）"
    elif pyj 'import sys,json
L=[json.loads(l) for l in open(sys.argv[1]) if l.strip()]
fs=[e["seq"] for e in L if str(e.get("type","")).endswith("stage.start")]
d=[e["seq"] for e in L if e.get("type")=="ref.drift"]
sys.exit(0 if len(d)==1 and fs and d[0]<min(fs) else 1)' "$DRW/.forge/runs/dr-allow/events.jsonl" 2>/dev/null; then
      ok "A5.5b 有漂移 + --allow-drift：ref.drift 恰好 1 条且早于首个 stage.start"
    else
      no "A5.5b 有漂移 + --allow-drift：events 里 ref.drift 不是恰好 1 条/不在首个 stage.start 之前（员工二号 7b08b0e3）"
    fi
  fi
else skip "[接口待定] A5.5b (无法构造漂移工作区)"
fi
# A5.7 末尾半行 → verify-chain 通过（忽略，不报错）
cp "$RUN" "$TMP/crash.jsonl"; printf '{"seq":%s,"type":"stage.st' "$((LAST+1))" >> "$TMP/crash.jsonl"
$FORGE verify-chain --from-events-file "$TMP/crash.jsonl" >/dev/null 2>&1; rc=$?
[ $rc -eq 127 ] && skip "[接口待定] A5.11 (无 --from-events-file)" || { [ $rc -eq 0 ] && ok "A5.11 末尾半行被忽略、链校验通过" || no "A5.11 末尾半行导致校验失败 (rc=$rc)"; }
# A5.2 完整但被篡改的行 → 报错并指出 seq
cp "$RUN" "$TMP/t.jsonl"; pyj 'import sys,json
p=sys.argv[1]; L=[json.loads(l) for l in open(p) if l.strip()]; L[4]["payload"]={"tampered":True}
open(p,"w").write("".join(json.dumps(x,ensure_ascii=False,sort_keys=True)+"\n" for x in L))' "$TMP/t.jsonl"
$FORGE verify-chain --from-events-file "$TMP/t.jsonl" --json >"$TMP/vc.json" 2>/dev/null; vrc=$?
if [ "$vrc" -eq 127 ]; then skip "[接口待定] A5.2 (verify-chain --json 不可用)"
elif [ "$vrc" -eq 1 ]; then
  pyj 'import sys,json,re
d=json.load(open(sys.argv[1]))
errs=d.get("errors") if isinstance(d,dict) else d
blob=" ".join([str(e.get("path"))+" "+str(e.get("ids")) for e in errs])
sys.exit(0 if re.search(r"seq[:=]?\s*5\b", blob) else 1)' "$TMP/vc.json" && ok "A5.2 篡改第5条被检出（结构化 error 指向 seq 5）" || no "A5.2 退出码1但结构化 error 未指出 seq 5"
else no "A5.2 篡改后退出码应为 1，实际 $vrc"; fi
# A5.9 完整但 hash 错的行 → 报错退出(1) + 文件原样保留（不修）
cp "$RUN" "$TMP/hashbad.jsonl"
pyj 'import sys,json
p=sys.argv[1]; L=[json.loads(l) for l in open(p) if l.strip()]
L[2]["hash"]="0"*64
open(p,"w").write("".join(json.dumps(x,ensure_ascii=False,sort_keys=True)+"\n" for x in L))' "$TMP/hashbad.jsonl"
sha_h1=$(sha256sum "$TMP/hashbad.jsonl" | cut -d' ' -f1)
$FORGE verify-chain --from-events-file "$TMP/hashbad.jsonl" >/dev/null 2>&1; hrc=$?
sha_h2=$(sha256sum "$TMP/hashbad.jsonl" | cut -d' ' -f1)
[ "$hrc" -eq 127 ] && skip "[接口待定] A5.9 (无 --from-events-file)" || { { [ "$hrc" -eq 1 ] && [ "$sha_h1" = "$sha_h2" ]; } && ok "A5.9 hash 错 → 退出码1 且文件未被改动" || no "A5.9 hash 错时 rc=$hrc / 文件被改动"; }

# A5.7 三入口 assertStructuredError（六键齐全 + fix 键存在）；崩溃样例归 A5.8
assert_errs(){ $PY -c '
import sys,json
KEYS={"code","severity","locatable","path","ids","fix"}
d=json.load(sys.stdin); errs=d.get("errors") or ([d] if "code" in d else [])
assert errs, "no errors"
for e in errs: assert KEYS<=set(e), "missing %s in %s"%(KEYS-set(e), e.get("code"))'; }
a57=0; a57fail=0
# 注意：没有 set -e，`x | fn && a=a+1 || fail++` 容易计数错乱，这里统一用显式 rc 判断
$FORGE validate "$WS/fixtures/cycle.yaml" --json > "$TMP/a57v.json" 2>/dev/null
assert_errs < "$TMP/a57v.json"; [ $? -eq 0 ] && a57=$((a57+1)) || { a57fail=$((a57fail+1)); echo "  A5.7 validate 侧未达标"; }
# run 侧：新跑一次必然失败的 run，从它的事件流取 error 对象（员工二号 939810b8）；stdout 只作附加断言
# 新 run 的定位：优先 --out-dir（若实现支持），否则取 run 前后 .forge/runs 的最新目录（员工三号 eaa44d0f：别卡在参数上）
before_runs=$(ls -1 "$WS/.forge/runs" 2>/dev/null | sort)
before_runs=$(ls -1 "$WS/.forge/runs" 2>/dev/null | sort)
A57ID="a57-$(date +%s%N)"
(cd "$WS" && FORGE_FAKE=no-evidence $FORGE run --run "$A57ID" --flow flows/main.yaml) >/dev/null 2>&1; f57rc=$?
newrun=$(comm -13 <(echo "$before_runs") <(ls -1 "$WS/.forge/runs" 2>/dev/null | sort) | tail -1)
[ -f "$WS/.forge/runs/$A57ID/events.jsonl" ] && newrun="$A57ID"
F57="${newrun:+$WS/.forge/runs/$newrun}"
if [ -f "$F57/events.jsonl" ]; then
  pyj 'import sys,json
out=[]
for l in open(sys.argv[1]):
    if not l.strip(): continue
    e=json.loads(l)
    def walk(v):
        if isinstance(v,dict):
            if "code" in v and "severity" in v: out.append(v)
            else:
                for x in v.values(): walk(x)
        elif isinstance(v,list):
            for x in v: walk(x)
    walk(e.get("payload") or {})
json.dump({"errors":out}, open(sys.argv[2],"w"))' "$F57/events.jsonl" "$TMP/a57_run.json"
  assert_errs < "$TMP/a57_run.json"; [ $? -eq 0 ] && a57=$((a57+1)) || a57fail=$((a57fail+1))
  echo "  A5.7 run 侧取证 run_id=$F57 (rc=$f57rc)"
  grep -q '"code"' "$TMP/a57_run.json" || echo "  A5.7 run 侧: events 中未找到 payload.error/errors"
else
  a57fail=$((a57fail+1)); echo "  A5.7 run 侧：新 run 无 events.jsonl（--out-dir 不支持？rc=$f57rc）"
fi
out=$($FORGE verify-chain --from-events-file "$TMP/t.jsonl" --json 2>&1)
echo "$out" | assert_errs; [ $? -eq 0 ] && a57=$((a57+1)) || { a57fail=$((a57fail+1)); echo "  A5.7 verify-chain 侧未达标: $(echo "$out" | head -c 200)"; }
echo "  A5.7 计数: 达标=$a57 未达标=$a57fail"
[ $a57 -eq 3 ] && ok "A5.7 三入口结构化 error 六键齐全且含 fix" || { [ "$a57" -eq 0 ] && skip "[接口待定] A5.7 (三入口 --json 均不可用或输出非结构化)" || no "A5.7 仅 $a57/3 入口达标（stderr 见 tmp/err）"; }
C8ID="a5.8-crash-$(date +%s%N)"
(cd "$WS" && env FORGE_FAKE=crash $FORGE run --run "$C8ID" --flow flows/main.yaml) >"$TMP/c8.out" 2>"$TMP/c8.err"; c8rc=$?
if [ -f "$WS/.forge/runs/$C8ID/events.jsonl" ]; then
  pyj 'import sys,json
L=[]
for l in open(sys.argv[1]):
    if not l.strip(): continue
    try: L.append(json.loads(l))
    except json.JSONDecodeError: L.append({"type":"<half-line>"})
bad=[e for e in L if e.get("type")=="<half-line>" or "code" in (e.get("payload") or {}) or str(e.get("severity"))=="block"]
sys.exit(0 if not bad else 1)' "$WS/.forge/runs/$C8ID/events.jsonl" \
    && { [ "$c8rc" -eq 2 ] && [ -s "$TMP/c8.err" ] && ok "A5.8 崩溃路径：退出码 2 + stderr 非空 + 事件流无新增 error 事件" || no "A5.8 崩溃路径 rc=$c8rc（应 2）、stderr $( [ -s "$TMP/c8.err" ] && echo 非空 || echo 为空)"; } \
    || no "A5.8 崩溃被塞进了事件流（error 事件或半行）"
else no "A5.8 crash 未产生事件流 (rc=$c8rc)"; fi

# A5.3 未知事件类型原样保留
skip "[接口待定] A5.3 未知事件类型（需实现注入入口）"

# ---------- 重试边（bug 修复流样例，协议字段 P0 写入即校验）----------
# 若 ws 提供 fixtures/retry-*.yaml（重试边样例），这里跑结构校验并断言 loop 字段齐全
# RETRY 段为草案（苦力三号 c10ac552）：契约未定稿前默认不跑；由 v2.3 定 A8/A9 编号后重写。
# 依赖：shangxinha 决定循环放 P0 还是 P0.5；M1 或 v2.3 决定是否提供 fixtures/retry-*.yaml。
if [ "${FORGE_RETRY_CHECKS:-0}" = "1" ]; then
# 判据出口（员工二号 4a442517）：先看退出码 0=通过 / 1=有 block / 2=工具异常(接口待定)，只在 1 时解析 codes
if compgen -G "$WS/fixtures/retry-*.yaml" >/dev/null 2>&1; then
  for f in "$WS"/fixtures/retry-*.yaml; do
    $FORGE validate "$f" --json > "$TMP/rt.json" 2>"$TMP/rt.err"; rc=$?
    case $rc in
      0) ok "RETRY $(basename "$f") 校验通过（rc=0）";;
      2|127) skip "[接口待定] RETRY $(basename "$f") (rc=$rc) $(head -1 "$TMP/rt.err")";;
      1) no "RETRY $(basename "$f") 合法重试边被判 block: $(head -c 120 "$TMP/rt.json")";;
      *) no "RETRY $(basename "$f") 非预期退出码 $rc";;
    esac
  done
  for f in "$WS"/fixtures/retry-invalid-*.yaml; do
    [ -e "$f" ] || continue
    $FORGE validate "$f" --json > "$TMP/rt.json" 2>"$TMP/rt.err"; rc=$?
    case $rc in
      2|127) skip "[接口待定] RETRY-INVALID $(basename "$f") (rc=$rc)";;
      1) pyj 'import sys,json
d=json.load(open(sys.argv[1])); codes=[e.get("code","") for e in (d.get("errors") or [])]
sys.exit(0 if ("E_CYCLE" in codes or "E_LIMIT_UNBOUNDED" in codes) else 1)' "$TMP/rt.json" \
        && ok "RETRY-INVALID $(basename "$f") 被正确拒绝（E_CYCLE/E_LIMIT_UNBOUNDED）" || no "RETRY-INVALID $(basename "$f") 拒绝码不符（期望 E_CYCLE 或 E_LIMIT_UNBOUNDED）";;
      *) no "RETRY-INVALID $(basename "$f") 应被拒却退出码 $rc";;
    esac
  done
else skip "[P0范围外] RETRY 重试边样例（fixtures/retry-*.yaml 未提供；P0 只要求协议字段可写）"; fi
fi

# ---------- P0 不支持（v2.4 附录 I 注记；原 [P0范围外] 现升为 P0 必验）----------
# fixtures/p0-unsupported-<字段>.yaml（on / max_iterations / loop_id / group 各一条）
# 判据：validate --json 退出码 1；code = 码表为此专定的单一码（P0_UNSUPPORTED_CODE，待苦力三号定名）；
#       path 指向该字段；E_SCHEMA_INVALID 兜底不算通过；只判非 0 不算通过。
P0C="${P0_UNSUPPORTED_CODE:-E_P0_UNSUPPORTED}"
echo "config: P0_UNSUPPORTED_CODE=${P0C:-<unset>} EXPECT_MAP=${EXPECT_MAP:-<unset>}"
if compgen -G "$WS/fixtures/p0-unsupported-*.yaml" >/dev/null 2>&1; then
  if [ -z "$P0C" ]; then no "P0-UNSUPPORTED 未设置 P0_UNSUPPORTED_CODE（P0 必验项；码名由苦力三号在码表定名后由调用方传入）"; for f in "$WS"/fixtures/p0-unsupported-*.yaml; do echo "  pending: $(basename "$f")"; done
  else
    for f in "$WS"/fixtures/p0-unsupported-*.yaml; do
      field=$(basename "$f" .yaml | sed 's/^p0-unsupported-//')
      $FORGE validate "$f" --json > "$TMP/p0.json" 2>"$TMP/p0.err"; rc=$?
      case $rc in
        2|127) skip "[接口待定] P0-UNSUPPORTED $field (rc=$rc)";;
        0) no "P0-UNSUPPORTED $field 使用了 P0 不支持的字段却通过校验";;
        1) pyj 'import sys,json
codes=sys.argv[1].split(","); field=sys.argv[2]
d=json.load(open(sys.argv[3])); errs=d.get("errors") or []
bad=[e.get("code") for e in errs if e.get("code") not in codes]
hit=[e for e in errs if e.get("code") in codes and field in str(e.get("path"))]
sys.exit(0 if errs and not bad and hit else 1)' "$P0C" "$field" "$TMP/p0.json" \
             && ok "P0-UNSUPPORTED $field → 退出码1，errors 全为 $P0C，path 指向字段" \
             || no "P0-UNSUPPORTED $field 不符：errors 必须全为 $P0C 且 path 指向字段（出现 E_SCHEMA_INVALID 或其他码一律 FAIL）: $(head -c 200 "$TMP/p0.json")";;
        *) no "P0-UNSUPPORTED $field 非预期退出码 $rc";;
      esac
    done
  fi
else no "P0-UNSUPPORTED 缺 fixtures/p0-unsupported-*.yaml（P0 必验项）"; fi

# ---------- A8–A12（P0.5）：逐编号列出，未实现即 [P0.5]，不记 [接口待定] ----------
for id in A8.1 A8.2 A8.3 A8.4 A9.1 A9.2 A9.3 A9.4 A10.1 A10.2 A10.3 A11.1 A11.2 A12.1 A12.2 A12.3 A12.4; do
  case $id in
    A12.4) skip "[P0.5] $id（不限于带 on: 的边；fixture 不得带 max_iterations/on）";;
    *) skip "[P0.5] $id";;
  esac
done
# limit-unbounded 归 P0.5（v2.4 09429d44 / 附录 I 新注）：不得记成 P0 FAIL
skip "[P0.5] limit-unbounded fixture（码表该行 fixture 列记 —）"

# ---------- A6 / A7 ----------
skip "[P0范围外] A6.2 子流水线执行（P0.5）"
(cd "$WS" && run_forge $FORGE verify --check-refs --run "$RUN_ID"); rc=$?
if [ $rc -eq 0 ]; then ok "A7.2 无 block/flow 内容漂移"
elif [ $rc -eq 127 ] || [ $rc -eq 2 ]; then skip "[接口待定] A7.2 (verify --check-refs 未实现，rc=$rc)"; tail_or_err
else no "A7.2 检出漂移: $(head -c 200 "$TMP/out")"; fi
if run_forge $FORGE replay --run "$RUN_ID" --format jsonl; then ok "A7.1 重放可用（历史 run 不受 block 版本影响需 M1 fixture 后复核）"; else skip "[接口待定] A7.1"; fi

if [ "${UB_OK:-none}" = "none" ]; then
  UB_OK=0; UB_FAIL=0; UB_SKIP=0
  echo "  (A2/A2.4 未执行：脚本在中途退出)"
else
  PASS=$((PASS+UB_OK)); FAIL=$((FAIL+UB_FAIL)); SKIP=$((SKIP+UB_SKIP))
fi

echo "RESULT: PASS=$PASS FAIL=$FAIL UNVERIFIED=$SKIP"
[ $FAIL -eq 0 ]
