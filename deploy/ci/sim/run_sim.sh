#!/usr/bin/env bash
# Simulate: deploy v1 -> deploy v2 -> broken v3 rolls back -> unmerged sha refused. No remote repo needed.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/../.." && pwd)"   # deploy/
W="$(mktemp -d)"; export FORGE_ROOT="$W/srv"; export FORGE_PORT="${FORGE_PORT:-18787}"
trap 'kill "$(cat "$FORGE_ROOT/current/.forge-serve.pid" 2>/dev/null)" 2>/dev/null || true; rm -rf "$W"' EXIT
mkdir -p "$FORGE_ROOT"
mk(){ # mk <tag> → 独立 git 仓库 + clone 到 FORGE_ROOT/build-<sha>；stdout 打 sha
  local w sha; w="$(mktemp -d)"; mkdir -p "$w/bin" "$w/deploy/ci"
  cp "$HERE/start.sh" "$HERE/deploy.sh" "$HERE/smoke.sh" "$w/deploy/"
  cat > "$w/bin/forge.js" <<JS
const http=require('http');
http.createServer((q,r)=>{
  const u=new URL(q.url,"http://x");
  if(u.pathname==='/healthz'){r.end(JSON.stringify({ok:true}));return;}
  if(u.pathname==='/snapshot'){r.setHeader('content-type','application/json');r.end(JSON.stringify({runs:[{run_id:"sim"}]}));return;}
  if(u.pathname==='/events'){r.setHeader('content-type','text/event-stream');r.end('data: {"run_id":"sim","seq":1}\n\n');return;}
  r.statusCode=404;r.end();}).listen(Number(process.env.FORGE_PORT)||8787,()=>console.log('serve up'));
JS
  echo '{"name":"sim","version":"0.0.0"}' > "$w/package.json"
  echo "$1" > "$w/VERSION"
  git -C "$w" init -q -b main; git -C "$w" add -A
  git -C "$w" update-ref refs/remotes/origin/main HEAD 2>/dev/null || true
  git -C "$w" -c user.email=s@x -c user.name=s commit -q -m "$1"
  sha="$(git -C "$w" rev-parse HEAD)"
  git -C "$w" config uploadpack.allowTipSHA1InWant true
  git clone -q --no-local "$w" "$FORGE_ROOT/build-$sha" 2>/dev/null
  git -C "$FORGE_ROOT/build-$sha" fetch -q origin "+refs/remotes/origin/*:refs/remotes/origin/*" 2>/dev/null || true
  echo "$sha" > "$w/.sha"; printf '%s' "$sha"
}
echo "== sim: deploy v1"; S1="$(mk v1)"; bash "$HERE/deploy.sh" "$S1" || { echo "UNEXPECTED: first deploy failed"; exit 1; }
curl -fsS "http://127.0.0.1:$FORGE_PORT/healthz"; echo
echo "== sim: deploy v2"; S2="$(mk v2)"; bash "$HERE/deploy.sh" "$S2" || { echo "UNEXPECTED: second deploy failed"; exit 1; }
touch "$FORGE_ROOT/build-$S2/.merged-flag"
curl -fsS "http://127.0.0.1:$FORGE_PORT/healthz"; echo
echo "== sim: broken v3 on main must roll back (syntax error)"
S3="$(mk v3)"; d="$FORGE_ROOT/build-$S3"
printf "function (\n" > "$d/bin/forge.js"   # 语法错误：进程起不来，必须回滚
git -C "$d" -c user.email=s@x -c user.name=s commit -qam break; S3="$(git -C "$d" rev-parse HEAD)"
cp -a "$d" "$FORGE_ROOT/build-$S3"
git -C "$FORGE_ROOT/build-$S3" fetch -q origin "+refs/remotes/origin/*:refs/remotes/origin/*"; git -C "$FORGE_ROOT/build-$S3" checkout -q main   # 让它看起来"已合并"
if bash "$HERE/deploy.sh" "$S3"; then echo "UNEXPECTED: broken deploy succeeded"; else echo "ok: rolled back"; fi
curl -fsS "http://127.0.0.1:$FORGE_PORT/healthz"; echo
echo "== sim: unmerged sha must be refused"
SU="$(mk v-side)"; du="$FORGE_ROOT/build-$SU"
git -C "$du" checkout -q -b feat/x; git -C "$du" -c user.email=s@x -c user.name=s commit -q --allow-empty -m side
SU2="$(git -C "$du" rev-parse HEAD)"; cp -a "$du" "$FORGE_ROOT/build-$SU2"; git -C "$FORGE_ROOT/build-$SU2" fetch -q origin "+refs/remotes/origin/*:refs/remotes/origin/*"; git -C "$FORGE_ROOT/build-$SU2" checkout -q main
if FORGE_REF=origin/main bash "$HERE/deploy.sh" "$SU2"; then echo "UNEXPECTED: unmerged sha deployed"; else echo "ok: refused unmerged sha"; fi
curl -fsS "http://127.0.0.1:$FORGE_PORT/healthz"; echo " (must still be v2)"
echo "== sim: deploy reports"
ls "$FORGE_ROOT"/deploy-report-*.md
