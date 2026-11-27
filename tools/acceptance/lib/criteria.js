// The five final-stage standards (员工一号 b03da5fa) as machine-checkable rows.
//
// Each criterion returns one row:
//   { id, standard, status: 'pass'|'fail'|'unverified', commands: [...], raw: '...' }
// and may attach `red` rows: the counter-example probe that must go red when
// the implementation regresses. `red` is reported, never averaged into status.
//
// READ-ONLY: every probe works on a scratch copy under os.tmpdir(); the repo
// under test is never written to.
import fs from 'node:fs';
import path from 'node:path';
import { node, run as runCmd, rawLine, tempDir, copyDir, removeDir } from './exec.js';

const V = 'V1'; // standard id prefix: V1..V5 follow 员工一号 b03da5fa numbering

function row(id, standard, status, commands, raw, extra = {}) {
  return { id, standard, status, commands, raw, ...extra };
}

// One `forge` invocation in a scratch root; returns the parsed stdout JSON and rc.
function forgeJson(repo, args, env = {}) {
  const r = node(path.join(repo, 'bin', 'forge.js'), args, { env: { FORGE_ROOT: repo, ...env } });
  let json = null;
  try {
    json = JSON.parse(r.stdout.trim());
  } catch {
    json = null;
  }
  return { ...r, json };
}

// Is `child` inside `parent` (both absolute)?
function inside(parent, child) {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function readJsonl(file) {
  if (!fs.existsSync(file)) throw new Error(`missing ${file}`);
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l));
}

// ---------------------------------------------------------------- V1 可视化
// 人画的和 agent 写的必须过同一个校验器；报错能指回具体节点。
// The canvas is not in main yet (#8). What can be judged NOW is the half that
// does not depend on the canvas: the CLI and the library entry point must give
// the SAME verdict, and a bad flow must point at the node. When #8 lands, the
// canvas exporter becomes one more caller of this same probe.
export function v1_sameValidator(repo) {
  const id = `${V}.1 人机同门`;
  const standard = '画布导出物与 agent 写出的流程必须经过同一个校验器，且报错指回节点';
  const bad = path.join(repo, 'fixtures', 'cycle.yaml');
  const cli = node(path.join(repo, 'bin', 'forge.js'), ['validate', bad, '--json'], { cwd: repo });
  let cliErrors = null;
  try {
    cliErrors = JSON.parse(cli.stdout).errors;
  } catch {
    cliErrors = null;
  }
  const lib = node(path.join(repo, 'tools', 'acceptance', 'probes', 'lib-validate.mjs'), [repo, bad], { cwd: repo });
  let libErrors = null;
  try {
    libErrors = JSON.parse(lib.stdout.trim()).errors;
  } catch {
    libErrors = null;
  }
  const same = JSON.stringify(cliErrors) === JSON.stringify(libErrors);
  const pointsAtNode =
    Array.isArray(cliErrors) && cliErrors.length > 0 && cliErrors.every((e) => e.ids && e.ids.length > 0);
  // A red probe is one that must go red on a broken implementation; its own
  // status says whether it would (pass = it sees the defect).
  const red = [];
  const badRefused = Array.isArray(cliErrors) && cliErrors.some((e) => e.code === 'E_CYCLE');
  const good = path.join(repo, 'flows', 'main.yaml');
  const goodRun = node(path.join(repo, 'bin', 'forge.js'), ['validate', good, '--json'], { cwd: repo });
  let goodErrors = null;
  try {
    goodErrors = JSON.parse(goodRun.stdout).errors;
  } catch {
    goodErrors = null;
  }
  red.push(
    row(`${id}.red`, '反例：合法流程必须 0 错误', Array.isArray(goodErrors) && goodErrors.length === 0 ? 'pass' : 'fail', [
      `node bin/forge.js validate flows/main.yaml --json → ${goodRun.code}`,
    ], rawLine(goodRun.stdout || goodRun.stderr)),
  );
  red.push(
    row(`${id}.red2`, '反例：画了环的流程必须被校验器以 E_CYCLE 拒绝', badRefused ? 'pass' : 'fail', [
      `node bin/forge.js validate fixtures/cycle.yaml --json → ${cli.code}`,
    ], rawLine(cli.stdout || cli.stderr)),
  );
  return row(
    id,
    standard,
    same && pointsAtNode && badRefused && cli.code === 1 ? 'pass' : 'fail',
    [
      `node bin/forge.js validate fixtures/cycle.yaml --json → ${cli.code}`,
      `lib validateFlow(fixtures/cycle.yaml) → ${lib.code}`,
    ],
    `cli=${rawLine(cli.stdout, 120)} | lib=${rawLine(lib.stdout, 120)}`,
    { reds: red, notes: '画布一侧（#8）未落地：本条只证明「CLI 与库是同一个校验器、错误带节点 id」；画布导出物接入时复用同一探针' },
  );
}

// ---------------------------------------------------------------- V2 可执行
// 同一份流程被确定性编排器跑完，事件可回放；中途失败能定位到阶段与原因。
export function v2_replayEquivalence(repo) {
  const id = `${V}.2a replay==incremental==从头`;
  const standard = '同一份流程可被编排器跑完，全程事件可回放（重放 == 增量 == 从头重放）';
  const dir = path.join(repo, 'tools', 'acceptance', 'frozen', 'linear-golden');
  const scratch = tempDir('af-v2-');
  try {
    if (!fs.existsSync(path.join(dir, '.forge', 'runs', 'linear-golden', 'events.jsonl'))) {
      return row(id, standard, 'unverified', ['frozen sample missing'], '', {
        reds: [],
        notes: '冻结样例未入库：等 H1/H2 转绿（员工一号 8bd827be / a34c49e8）后生成，不用 d9c8d35 上的绝对路径版本凑数',
      });
    }
    copyDir(dir, scratch);
    const runDir = path.join(scratch, '.forge', 'runs', 'linear-golden');
    const events = readJsonl(path.join(runDir, 'events.jsonl'));
    const replay = node(path.join(repo, 'bin', 'forge.js'), ['replay', '--run', 'linear-golden'], { env: { FORGE_ROOT: scratch } });
    const inc = node(path.join(repo, 'bin', 'forge.js'), ['incremental', '--run', 'linear-golden', '--since', '2'], { env: { FORGE_ROOT: scratch } });
    const incAll = node(path.join(repo, 'bin', 'forge.js'), ['incremental', '--run', 'linear-golden', '--since', '0'], { env: { FORGE_ROOT: scratch } });
    const chain = node(path.join(repo, 'bin', 'forge.js'), ['verify-chain', '--run', 'linear-golden', '--json'], { env: { FORGE_ROOT: scratch } });
    const expectedFull = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
    const expectedTail = events.filter((e) => e.seq > 2).map((e) => JSON.stringify(e)).join('\n') + (events.some((e) => e.seq > 2) ? '\n' : '');
    const full = replay.stdout === expectedFull && incAll.stdout === expectedFull;
    const tail = inc.stdout === expectedTail;
    const chained = chain.code === 0 && replay.code === 0 && inc.code === 0;
    // 反例：改一个字节的仓外副本必须被 verify-chain 拒绝
    const tampered = tempDir('af-v2-red-');
    let redOk = false;
    let redRaw = '';
    try {
      const f = path.join(tampered, '.forge', 'runs', 'linear-golden', 'events.jsonl');
      fs.mkdirSync(path.dirname(f), { recursive: true });
      const lines = fs.readFileSync(path.join(runDir, 'events.jsonl'), 'utf8').split('\n');
      const idx = lines.findIndex((l) => l.includes('"seq":3'));
      lines[idx] = lines[idx].replace('"status":"ok"', '"status":"failed"');
      fs.writeFileSync(f, lines.join('\n'));
      const r = node(path.join(repo, 'bin', 'forge.js'), ['verify-chain', '--run', 'linear-golden', '--json'], { env: { FORGE_ROOT: tampered } });
      redOk = r.code !== 0;
      redRaw = rawLine(r.stdout || r.stderr);
    } finally {
      removeDir(tampered);
    }
    const reds = [row(`${id}.red`, '反例：篡改一个事件后 verify-chain 必须非 0', redOk ? 'pass' : 'fail', ['verify-chain on tampered copy'], redRaw)];
    if (!fs.existsSync(path.join(runDir, 'events.jsonl'))) {
      return row(id, standard, 'unverified', ['frozen sample missing'], '', { reds, notes: '冻结样例未入库（等员工三号 #10 前置的 --flow 改动合入后生成）' });
    }
    return row(id, standard, full && tail && chained ? 'pass' : 'fail', [
      `replay → ${replay.code}`,
      `incremental --since 2 → ${inc.code}`,
      `verify-chain → ${chain.code}`,
    ], `lines=${events.length} replay==frozen:${replay.stdout === expectedFull} inc==frozen:${incAll.stdout === expectedFull} since2:${tail}`, { reds });
  } finally {
    removeDir(scratch);
  }
}

export function v2_failureLocated(repo) {
  const id = `${V}.2b 失败定位到阶段`;
  const standard = '中途失败能定位到阶段和原因';
  const scratch = tempDir('af-v2b-');
  try {
    copyDir(repo, scratch);
    fs.rmSync(path.join(scratch, '.forge'), { recursive: true, force: true });
    const r = node(path.join(scratch, 'bin', 'forge.js'), ['run', '--run', 'fail-1'], {
      env: { FORGE_ROOT: scratch, FORGE_FAKE: 'fail-build' },
    });
    const failFile = path.join(scratch, '.forge', 'runs', 'fail-1', 'events.jsonl');
    const events = fs.existsSync(failFile) ? readJsonl(failFile) : [];
    const end = events.filter((e) => e.type === 'stage.end' && e.payload?.status === 'failed');
    const located = r.code !== 0 && end.length === 1 && end[0].stage === 'build';
    const snap = forgeJson(scratch, ['snapshot', '--run', 'fail-1']);
    const cell = snap.json?.runs?.[0]?.stages?.find((s) => s.stage === 'build');
    const reds = [];
    const ok = node(path.join(scratch, 'bin', 'forge.js'), ['run', '--run', 'ok-1'], { env: { FORGE_ROOT: scratch, FORGE_FAKE: '1' } });
    reds.push(row(`${id}.red`, '反例：不失败的运行必须 rc=0（否则「失败被定位」是假的）', ok.code === 0 ? 'pass' : 'fail', [`FORGE_FAKE=1 run → ${ok.code}`], ''));
    return row(id, standard, located && cell?.status === 'failed' ? 'pass' : 'fail', [
      `FORGE_FAKE=fail-build run --run fail-1 → ${r.code}`,
      `snapshot build@1.status = ${cell?.status}`,
    ], rawLine(JSON.stringify(end[0]?.payload ?? null)), { reds });
  } finally {
    removeDir(scratch);
  }
}

// ---------------------------------------------------------------- V3 能接真 agent
// 阶段执行真正调用 agent 运行时；权限边界由编排器强制，越权写入会被拦住。
// 现在跑的是固定假执行器：可以判的是「编排器确实拦得住越权动作」这一半。
export function v3_permissionEnforced(repo) {
  const id = `${V}.3 越权被拦`;
  const standard = 'agent 越权写入会被编排器拦住（权限边界由编排器强制）';
  const scratch = tempDir('af-v3-');
  try {
    copyDir(repo, scratch);
    fs.rmSync(path.join(scratch, '.forge'), { recursive: true, force: true });
    const r = node(path.join(scratch, 'bin', 'forge.js'), ['run', '--run', 'perm-1'], {
      env: { FORGE_ROOT: scratch, FORGE_FAKE: 'touch-checks' },
    });
    const file = path.join(scratch, '.forge', 'runs', 'perm-1', 'events.jsonl');
    const events = fs.existsSync(file) ? readJsonl(file) : [];
    const gap = events.filter((e) => e.type === 'stage.end' && e.payload?.error?.code === 'E_PERMISSION_GAP');
    const blocked = gap.length > 0 && r.code !== 0;
    // 反例：正常执行器不得出现任何错误
    const ok = node(path.join(scratch, 'bin', 'forge.js'), ['run', '--run', 'perm-ok'], { env: { FORGE_ROOT: scratch, FORGE_FAKE: '1' } });
    const okFile = path.join(scratch, '.forge', 'runs', 'perm-ok', 'events.jsonl');
    const okEvents = fs.existsSync(okFile) ? readJsonl(okFile) : [];
    const clean = ok.code === 0 && !okEvents.some((e) => e.type === 'stage.end' && e.payload?.error);
    const reds = [row(`${id}.red`, '反例：合法执行器不得被记成越权', clean ? 'pass' : 'fail', [`FORGE_FAKE=1 run → ${ok.code}`], '')];
    return row(id, standard, blocked ? 'pass' : 'fail', [`FORGE_FAKE=touch-checks run --run perm-1 → ${r.code}`], rawLine(JSON.stringify(gap[0]?.payload?.error ?? null)), {
      reds,
      notes: '真运行时（#9、路线第 3 块）未接入：本条判的是编排器一侧的强制，不是模型调用',
    });
  } finally {
    removeDir(scratch);
  }
}

// ---------------------------------------------------------------- V4 循环与分支
export function v4_loops(ref = process.env.AF_REF ?? 'HEAD') {
  const id = `${V}.4 分支与有限循环`;
  return row(id, '流程可带条件分支与有限循环，每轮单独成格，上限是硬限制', 'unverified', [
    'node bin/forge.js validate fixtures/limit-suspect.yaml',
    'node bin/forge.js validate fixtures/limit-unbounded.yaml',
  ], '', { notes: `#10 未合入（被测 ${ref}）；落地后改写本条判据并先红后绿` });
}

// ---------------------------------------------------------------- V5 人只在两端
export function v5_humanEnds(repo) {
  const id = `${V}.5 人只在两端`;
  const standard = 'agent 不能自己宣布通过：通过只能来自确定性的检查';
  return row(id, standard, 'unverified', ['（待定：需要「人工验收」这一端在仓库里的表示）'], '', {
    notes: '当前 runner 的 Submit 里 status=ok 不会让编排器改判，gate 需要审批人（fixtures/gate-no-approver.yaml）；「人只在两端」目前只在流程约定里，仓库里没有可判的载体',
  });
}

// ---------------------------------------------------------------- H1/H2 交接前置
// 员工一号 a34c49e8 定：`forge run <位置参数>` 必须 rc≠0 且 E_INVALID_ARGS；
// `--flow` 写出的两处路径必须相同且相对。两条在 d9c8d35 上都是红的（位置参数静默
// 跑默认三段；--flow 写绝对路径），所以先红后绿正好从这里开始。
export function h1_positionalRefused(repo) {
  const id = 'H1 run-positional-arg';
  const r = node(path.join(repo, 'tools', 'acceptance', 'probes', 'cli-run-positional.mjs'), [repo], { cwd: repo });
  let j = null;
  try {
    j = JSON.parse(r.stdout.trim());
  } catch {
    j = null;
  }
  return row(id, '`forge run <file>`（位置参数）必须非 0 退出并报 E_INVALID_ARGS，不得静默跑默认三段', j?.ok ? 'pass' : 'fail', [
    'node bin/forge.js run flows/main.yaml   (FORGE_ROOT=临时空目录)',
  ], j ? `rc=${j.rc} code=${j.sawCode} madeRun=${j.madeRun} | ${j.line}` : rawLine(r.stdout || r.stderr), {
    notes: '先红后绿：d9c8d35 上实测 rc=0、manifest.flow=null；员工三号在 #10 前置修',
  });
}

export function h2_flowPathRelative(repo) {
  const id = 'H2 flow-path-relative';
  const r = node(path.join(repo, 'tools', 'acceptance', 'probes', 'flow-path-relative.mjs'), [repo], { cwd: repo });
  let j = null;
  try {
    j = JSON.parse(r.stdout.trim());
  } catch {
    j = null;
  }
  return row(id, '带 --flow 时 manifest.flow.path == run.start.payload.flow，且是相对仓库根的路径', j?.ok ? 'pass' : 'fail', [
    'node bin/forge.js run --run rel-1 --flow flows/main.yaml   (FORGE_ROOT=临时空目录)',
  ], j ? `manifest=${j.manifest} event=${j.event}` : rawLine(r.stdout || r.stderr), {
    notes: '先红后绿：d9c8d35 上两处都写绝对路径；员工三号改 run 入口为相对路径',
  });
}

// 交接门禁：两条先红后绿的 H 条通过之前，冻结样例不得生成（员工一号 8bd827be 的口径：
// 「不要用现在 d9c8d35 上的绝对路径版本凑一份」）。
export function gate_freezeAllowed(repo) {
  const h1 = h1_positionalRefused(repo);
  const h2 = h2_flowPathRelative(repo);
  const ok = h1.status === 'pass' && h2.status === 'pass';
  return row('G0 freeze-allowed', '冻结样例只能在 H1、H2 转绿后生成', ok ? 'pass' : 'fail', ['H1', 'H2'], `H1=${h1.status} H2=${h2.status}`, {
    reds: [h1, h2],
    notes: '本条 fail 是「不能冻结」这个判定本身，不是实现缺陷；它把依赖写进报告，避免拿旧入口产物凑数',
  });
}

// ---------------------------------------------------------------- 部署段（复用员工四号脚本）
export function d1_deployScriptsSmoke(repo) {
  const id = 'D1 deploy-scripts-present';
  const scripts = ['deploy/deploy.sh', 'deploy/ci/acceptance.sh', 'deploy/smoke.sh', 'deploy/start.sh'];
  const missing = scripts.filter((s) => !fs.existsSync(path.join(repo, s)));
  const syntax = scripts.map((s) => ({ s, r: runCmd('bash', ['-n', path.join(repo, s)]) }));

  const bad = syntax.filter((x) => x.r.code !== 0);
  return row(
    id,
    '部署段复用仓库 deploy.sh + acceptance.sh（不另写起服务逻辑）',
    missing.length === 0 && bad.length === 0 ? 'pass' : 'fail',
    scripts.map((s) => `bash -n ${s}`),
    missing.length ? `missing: ${missing.join(',')}` : `bash -n ok: ${scripts.length}/${scripts.length}`,
    {
      notes: '真正的「按 sha 部署 → 冒烟 → 出报告」由 deploy.sh 执行（先停已部署实例再换端口，需另定）；套件只判脚本在位且语法正确',
    },
  );
}

export function d2_servedRunTraceable(repo) {
  const id = 'D2 served-run-traceable';
  const standard = '/snapshot 能看到刚跑完的 run，且它的阶段进度与事件链一致';
  const scratch = tempDir('af-d2-');
  try {
    copyDir(repo, scratch);
    fs.rmSync(path.join(scratch, '.forge'), { recursive: true, force: true });
    const run = node(path.join(scratch, 'bin', 'forge.js'), ['run', '--run', 'served-1', '--flow', path.join(scratch, 'flows', 'main.yaml')], {
      env: { FORGE_ROOT: scratch, FORGE_FAKE: '1' },
    });
    const snap = forgeJson(scratch, ['snapshot', '--run', 'served-1']);
    const r = snap.json?.runs?.find((x) => x.run_id === 'served-1');
    const stages = r?.stages?.map((s) => `${s.stage}@${s.iteration}:${s.status}`) ?? [];
    const complete = stages.length === 3 && stages.every((s) => s.endsWith(':ok'));
    return row(id, standard, run.code === 0 && complete ? 'pass' : 'fail', [`run --run served-1 → ${run.code}`, 'snapshot --run served-1'], stages.join(',') || rawLine(snap.stdout || snap.stderr));
  } finally {
    removeDir(scratch);
  }
}
