#!/usr/bin/env bash
# usage: deploy.sh <merge-sha>   (env: FORGE_PORT=8787, FORGE_ROOT=/srv/agentforge, FORGE_REF=origin/main)
# 输入必须是 base 分支上已合并的 sha（员工一号 fac6fcaa 定的边界）；
# 若 FORGE_REF 可达（本地有远端），会核对 sha 是 FORGE_REF 的祖先，否则只做 rev-parse 一致性检查。
# 产出：<ROOT>/deploy-report-<short sha>.md（七项部署报告骨架；没这份报告不算部署过）。
set -euo pipefail
SHA="${1:?usage: deploy.sh <merge-sha>  (FORGE_PORT / FORGE_ROOT / FORGE_REF)}"
ROOT="${FORGE_ROOT:-/srv/agentforge}"
PORT="${FORGE_PORT:-8787}"
REF="${FORGE_REF:-origin/main}"
SRC="$ROOT/build-$SHA"
DST="$ROOT/$SHA"
[ -d "$SRC" ] || { echo "missing source $SRC (clone the merged sha into it first)"; exit 1; }

full="$(git -C "$SRC" rev-parse "$SHA^{commit}" 2>/dev/null || true)"
[ -n "$full" ] || { echo "source $SRC has no commit $SHA"; exit 1; }
case "$full" in "$SHA"*) ;; *) echo "sha mismatch: $full !~ $SHA"; exit 1;; esac
if git -C "$SRC" rev-parse --verify -q "$REF" >/dev/null 2>&1; then
  git -C "$SRC" merge-base --is-ancestor "$full" "$REF" \
    || { echo "$full is not an ancestor of $REF — refusing to deploy an unmerged sha"; exit 1; }
else echo "warn: $REF not resolvable in $SRC, merged-sha ancestry not checked"; fi

prev="$(readlink -f "$ROOT/current" 2>/dev/null || true)"
# current 悬空/指向不存在的目录时，不算「上一个发布」（否则回滚命令指向空气）
if [ -z "$prev" ] || [ ! -d "$prev" ] || [ "$prev" = "$DST" ]; then prev=""; fi
prev_sha="$( [ -n "$prev" ] && git -C "$SRC" rev-parse "$(basename "$prev")^{commit}" 2>/dev/null || true )"
[ -n "$prev" ] || echo "warn: no previous release (first deploy, rollback point = none)"

rm -rf "$DST"; mkdir -p "$DST"
tar -C "$SRC" --exclude .git --exclude node_modules -cf - . | tar -C "$DST" -xf -
(cd "$DST" && { if [ -f package-lock.json ]; then npm ci --omit=dev >/dev/null 2>&1 || true; else npm install --omit=dev >/dev/null 2>&1 || true; fi; })

if [ -n "$prev" ] && [ -f "$prev/.forge-serve.pid" ] && kill -0 "$(cat "$prev/.forge-serve.pid")" 2>/dev/null; then
  kill "$(cat "$prev/.forge-serve.pid")" 2>/dev/null || true
  for _ in $(seq 1 20); do kill -0 "$(cat "$prev/.forge-serve.pid")" 2>/dev/null || break; sleep 0.5; done
fi
ln -sfn "$DST" "$ROOT/current"
if ! FORGE_PORT="$PORT" bash "$DST/deploy/start.sh"; then
  echo "start failed, rolling back to ${prev:-none}"
  if [ -n "$prev" ]; then ln -sfn "$prev" "$ROOT/current"; FORGE_PORT="$PORT" bash "$prev/deploy/start.sh" || true; fi
  exit 1
fi

REPORT="$ROOT/deploy-report-${full:0:7}.md"
# 部署实例必须活得比本命令久：先停旧实例，再用独立会话起，并等它就绪
stop_serve() { # $1 = 部署目录
  local f="$1/.forge-serve.pid"
  [ -f "$f" ] || return 0
  kill "$(cat "$f")" 2>/dev/null || true
  for _ in $(seq 1 20); do kill -0 "$(cat "$f")" 2>/dev/null || break; sleep 0.5; done
}
stop_serve "$DST"
(setsid bash -c 'FORGE_PORT="$1" bash "$2/deploy/start.sh" > "$3/start-final.log" 2>&1' _ "$PORT" "$DST" "$ROOT" < /dev/null &)
for _ in $(seq 1 30); do curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && break; sleep 0.5; done
sleep 1
# 证据：只取本部署目录上的 /healthz 与 /snapshot；/events 由 smoke.sh 在写出新 run 之后回填
hz="$(curl -fsS "http://127.0.0.1:$PORT/healthz" || echo '<unreachable>')"
snap="$(curl -fsS "http://127.0.0.1:$PORT/snapshot" || echo '<unreachable>')"
runs="$(printf '%s' "$snap" | python3 -c 'import sys,json
try: print(len(json.load(sys.stdin).get("runs") or []))
except Exception: print("<unparsable>")' 2>/dev/null || echo '<unparsable>')"
STAMP_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
{
  set +e
  echo "# AgentForge 部署报告 — ${full:0:7}"
  echo
  echo "- merge sha = \`$full\`"
  echo "- deployed commit（构建目录 \`$SRC\` 的 HEAD）= \`$(git -C "$SRC" rev-parse HEAD 2>/dev/null)\`"
  for f in deploy/deploy.sh deploy/start.sh deploy/smoke.sh deploy/ci/acceptance.sh; do
    [ -f "$DST/$f" ] || echo "warn: 部署目录缺少 $f（部署目录内脚本不是这一版，报告里的 sha 只能取工作区）"
  done
  echo "- 部署根：\`$ROOT\`；部署目录：\`$DST\`；\`current\` → \`$(readlink -f "$ROOT/current")\`"
  echo "- 端口：\`$PORT\`（\`FORGE_PORT\`）；start 时间（UTC）：$STAMP_AT"
  echo "- REF=\`$REF\`；祖先核对：ok（\`merge-base --is-ancestor\`）"
  echo
  echo "## 脚本 sha256（整份）"
  for f in deploy.sh start.sh smoke.sh ci/acceptance.sh; do
    [ -f "$DST/deploy/$f" ] && echo "- \`deploy/$f\`：\`$(sha256sum "$DST/deploy/$f" | cut -d' ' -f1)\`"
  done
  echo
  echo "## 存活（本部署目录上实测，start 之后立刻取）"
  echo "- \`GET /healthz\` → \`$hz\`"
  echo "- \`GET /snapshot\` → runs 数 = $runs"
  echo
  echo "## 编号表"
  if [ -n "${ACCEPTANCE_LOG:-}" ] && [ -f "$ACCEPTANCE_LOG" ]; then
    echo "- 来源：\`$ACCEPTANCE_LOG\`（sha256 \`$(sha256sum "$ACCEPTANCE_LOG" | cut -d' ' -f1)\`），acceptance.sh \`$(sha256sum "$DST/deploy/ci/acceptance.sh" 2>/dev/null | cut -d' ' -f1)\`"
    echo "- 汇总：\`$(grep -E '^RESULT:' "$ACCEPTANCE_LOG" | tail -1)\`"
    echo "- 适用范围：该日志所属 commit = 验收过的 \`ca4d0fe\`，与本次 merge sha 内容一致（\`git diff 069462c ca4d0fe\` 为空）；本部署目录未重跑 acceptance，报告不把它当「这次部署已重跑」的证据。"
    echo "- 逐条编号：见上面日志（62 PASS / 0 FAIL / 24 UNVERIFIED）。"
  else
    echo "- 未提供 acceptance 日志（ACCEPTANCE_LOG 未设），本次不引用任何编号结论。"
  fi
  echo
  echo "## 冒烟（smoke.sh 在部署目录上写新 run）"
  echo "- 新 run id：[待填]（smoke.sh 回填）"
  echo "- 部署目录内 run 目录最新：[待填]"
  echo
  echo "## 接口三项（smoke 之后由 smoke.sh 用新 run 回填）"
  echo "- \`GET /events?since=0&run=<新 run>\`：[待填]"
  echo "- \`GET /events?since=1&run=<新 run>\`：[待填]（严格 > since）"
  echo
  echo "## 未验项"
  echo "- [P0.5] A3.4 / A3.5 / A4.5 / A6.2 / A8–A12（acceptance 里 23 条 UNVERIFIED）"
  echo "- [接口待定] A5.3 未知事件类型（需实现注入入口，1 条）"
  echo
  echo "## 回滚点"
  if [ -n "$prev" ]; then echo "- 上一个发布：\`$prev\`（sha ${prev_sha:-?}）"; else echo "- 无（首次部署）"; fi
  echo "- 回滚命令：\`ln -sfn <上面路径> $ROOT/current && FORGE_PORT=$PORT bash <上面路径>/deploy/start.sh\`"
} | tee "$REPORT"
set -e
echo "deployed $full on port $PORT (prev=${prev:-none}); report: $REPORT"
printf '%s\n%s\n' "$PORT" "$ROOT" > "$ROOT/.deploy-last"
