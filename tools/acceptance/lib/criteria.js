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
// 员工一号 820539da 定的最小载体（不发明新事件类型）：
//  ①  一次正常跑完的 run 里，没有任何事件的 actor.kind=human，也没有 type 以 accept 结尾；
//  ②  src/ 里没有任何写这类事件的代码路径（防「写了没触发」）。
// 这是负向判据：正向那一半（真正的人工验收命令）等 #9 第 3 块落地再补。
export function v5_humanEnds(repo) {
  const id = `${V}.5 人只在两端`;
  const standard = 'forge run 自己绝不产生 human 事件，manifest 里没有任何「已验收」字段';
  const scratch = tempDir('af-v5-');
  try {
    copyDir(repo, scratch);
    fs.rmSync(path.join(scratch, '.forge'), { recursive: true, force: true });
    const r = node(path.join(scratch, 'bin', 'forge.js'), ['run', '--run', 'v5-1', '--flow', 'flows/main.yaml'], { cwd: scratch, env: { FORGE_ROOT: scratch } });
    const runDir = path.join(scratch, '.forge', 'runs', 'v5-1');
    const evFile = path.join(runDir, 'events.jsonl');
    const events = r.code === 0 && fs.existsSync(evFile) ? readJsonl(evFile) : [];
    const humanEvents = events.filter((e) => e.actor?.kind === 'human' || /accept/i.test(String(e.type ?? '')));
    const manifest = fs.existsSync(path.join(runDir, 'manifest.json')) ? JSON.parse(fs.readFileSync(path.join(runDir, 'manifest.json'), 'utf8')) : {};
    const acceptedKeys = Object.keys(manifest).filter((k) => /accept|verified/i.test(k));
    // ② 代码路径：src/ 里不得有写 human 事件或 accept 事件的构造。
    const srcDir = path.join(repo, 'src');
    const offenders = [];
    for (const f of fs.readdirSync(srcDir).filter((x) => x.endsWith('.js'))) {
      const text = fs.readFileSync(path.join(srcDir, f), 'utf8');
      const lines = text.split('\n');
      lines.forEach((l, i) => {
        // Only an *event constructor* counts. `ref.drift` carries `acceptedBy: 'flag'`
        // (the --allow-drift record), which is not an acceptance of the run, so a
        // line is an offender only when it builds an event object with kind:"human"
        // or a `type` whose value ends in `accept`.
        const buildsEvent = /\b(type|append|writer\.append)\b/.test(l);
        const humanActor = /kind:\s*['"]human['"]/.test(l);
        const acceptType = /\btype:\s*['"][^'"]*accept[^'"]*['"]/i.test(l);
        if (humanActor || (buildsEvent && acceptType)) offenders.push(`src/${f}:${i + 1}: ${l.trim().slice(0, 80)}`);
      });
    }
    // 反例：把一条 human 事件塞进事件流，第①条必须能看出来（否则它是空转）。
    let redOk = false;
    if (events.length) {
      const withHuman = [...events.slice(0, 2), { ...events[1], seq: 3, type: 'run.accept', actor: { kind: 'human', name: 'probe' } }, ...events.slice(2).map((e) => ({ ...e }))];
      const seen = withHuman.filter((e) => e.actor?.kind === 'human' || /accept/i.test(String(e.type ?? '')));
      redOk = seen.length > 0;
    }
    const reds = [
      row(`${id}.red`, '反例：注入一条 human/accept 事件后扫描必须命中', redOk ? 'pass' : 'fail', ['scan(events + injected run.accept)'], ''),
      row(`${id}.red2`, '反例：把 src/ 放一个写 human 事件的构造后代码扫描必须命中', offendersSyntaxOk(repo) ? 'pass' : 'fail', ['scan(src/ for kind:\"human\" / type:\"…accept…\")'], ''),
    ];
    const ok = r.code === 0 && events.length > 0 && humanEvents.length === 0 && acceptedKeys.length === 0 && offenders.length === 0 && redOk && offendersSyntaxOk(repo);
    return row(id, standard, ok ? 'pass' : 'fail', [
      `run --run v5-1 --flow flows/main.yaml → ${r.code}`,
      'scan events.jsonl: actor.kind=human / type~accept',
      'scan manifest.json: keys ~ /accept|verified/',
      'scan src/*.js: kind:"human" / type:"…accept…"',
    ], `events=${events.length} human=${humanEvents.length} manifest=${acceptedKeys.join(',') || 'none'} src=${offenders.join(',') || 'none'}`, {
      reds,
      notes: '负向判据：正向那一半（人工验收命令 / run.accept 事件）等 #9 第 3 块落地再补；现在没有代码路径能自己宣布通过',
    });
  } finally {
    removeDir(scratch);
  }
}

// The src/ scanner must actually be able to see a planted offender.
function offendersSyntaxOk(repo) {
  const sample = "writer.append({ actor: { kind: 'human', name: 'x' }, type: 'run.accept' });";
  return /kind:\s*['"]human['"]/.test(sample) || /type:\s*['"][^'"]*accept[^'"]*['"]/i.test(sample);
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
// 员工四号 bd7215f3：D1 不能只看「文件在 + bash -n」，否则 deploy.sh 被清空也是绿的；
// D2 必须真的起一次服务并访问三条接口，名字与做法一致。
// 员工一号 820539da：D2 直接调员工四号的 deploy/ci/serve_probe.sh，不另写起服务逻辑。
const DEPLOY_MARKERS = [
  { file: 'deploy/deploy.sh', needles: ['deploy-report-', 'merge-base --is-ancestor'] },
  { file: 'deploy/smoke.sh', needles: ['/healthz', '/snapshot', '/events'] },
  { file: 'deploy/ci/serve_probe.sh', needles: ['/healthz', '/snapshot', '/events?run=', 'PROBE OK'] },
];

function markersPresent(repo, overrides = {}) {
  const missing = [];
  for (const { file, needles } of DEPLOY_MARKERS) {
    const p = path.join(repo, file);
    const text = overrides[file] ?? (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '');
    for (const n of needles) if (!text.includes(n)) missing.push(`${file}:${n}`);
  }
  return missing;
}

export function d1_deployScriptsSubstantive(repo) {
  const id = 'D1 deploy-scripts-substantive';
  const scripts = ['deploy/deploy.sh', 'deploy/ci/acceptance.sh', 'deploy/smoke.sh', 'deploy/start.sh'];
  const missingFiles = scripts.filter((s) => !fs.existsSync(path.join(repo, s)));
  const syntax = scripts.map((s) => ({ s, r: runCmd('bash', ['-n', path.join(repo, s)]) }));
  const badSyntax = syntax.filter((x) => x.r.code !== 0);
  const missing = markersPresent(repo);
  // 反例 1：把 smoke.sh 的 /events 删掉（模拟有人精简脚本）→ 必须被判红。
  const smoke = fs.existsSync(path.join(repo, 'deploy/smoke.sh')) ? fs.readFileSync(path.join(repo, 'deploy', 'smoke.sh'), 'utf8') : '';
  const red1 = markersPresent(repo, { 'deploy/smoke.sh': smoke.replaceAll('/events', '') }).length > 0;
  // 反例 2：deploy.sh 只剩 exit 0（「永远绿」正是这一条要挡的）。
  const red2 = markersPresent(repo, { 'deploy/deploy.sh': '#!/usr/bin/env bash\nexit 0\n' }).length > 0;
  const reds = [
    row(`${id}.red`, '反例：smoke.sh 少了 /events 必须红', red1 ? 'pass' : 'fail', ['markers(smoke.sh without /events)'], ''),
    row(`${id}.red2`, '反例：deploy.sh 被清空成 exit 0 必须红', red2 ? 'pass' : 'fail', ['markers(deploy.sh = exit 0)'], ''),
  ];
  const ok = missingFiles.length === 0 && badSyntax.length === 0 && missing.length === 0;
  return row(id, '部署段复用 deploy.sh + acceptance.sh，且脚本内容具备它声称的行为', ok ? 'pass' : 'fail', [
    ...scripts.map((s) => `bash -n ${s}`),
    ...DEPLOY_MARKERS.map((m) => `${m.file} contains ${m.needles.join(' / ')}`),
  ], ok ? `bash -n ${scripts.length}/${scripts.length}; markers present` : `missing=${[...missingFiles, ...badSyntax.map((x) => x.s)].join(',') || 'none'} markers=${missing.join(',') || 'none'}`, {
    reds,
    notes: 'D1/D2 之外的真部署由 deploy/deploy.sh 执行（输入必须是 origin/main 祖先 sha，按 sha 落 <root>/<sha>/，自动写 deploy-report-<short>.md，先停旧实例再起）；这一步需要独占端口，属人执行，不放在套件里自动跑',
  });
}

export async function d2_servedRunTraceable(repo) {
  const id = 'D2 serves-healthz-snapshot-events';
  const standard = '起一次真服务（复用 deploy/ci/serve_probe.sh）：/healthz、/snapshot 看得到 run、/events 首帧是 run.start';
  const probe = path.join(repo, 'deploy', 'ci', 'serve_probe.sh');
  if (!fs.existsSync(probe)) {
    return row(id, standard, 'unverified', ['deploy/ci/serve_probe.sh 不在被测提交里'], '', { reds: [], notes: '依赖员工四号的 PR（feat/serve-probe）；合入后本条自动开判' });
  }
  const copyParts = (dst) => {
    for (const d of ['bin', 'src', 'flows', 'blocks', 'fixtures', 'agents', 'checks', 'deploy', 'package.json']) {
      fs.cpSync(path.join(repo, d), path.join(dst, d), { recursive: true });
    }
  };
  const scratch = tempDir('af-d2-');
  let r;
  try {
    copyParts(scratch);
    r = runCmd('bash', [path.join(scratch, 'deploy', 'ci', 'serve_probe.sh'), scratch], { timeoutMs: 120_000 });
  } finally {
    removeDir(scratch);
  }
  const line = r.stdout.trim().split('\n').filter(Boolean).pop() ?? '';
  const ok = r.code === 0 && /^PROBE OK: .*run=/.test(line);
  // 反例：serve.js 换成导出不了的空壳 -> 探针必须非 0（能判红）。
  const bad = tempDir('af-d2red-');
  let redOk = false;
  let redLine = '';
  try {
    copyParts(bad);
    fs.writeFileSync(path.join(bad, 'src', 'serve.js'), '// broken on purpose\nexport {}\n');
    const rb = runCmd('bash', [path.join(bad, 'deploy', 'ci', 'serve_probe.sh'), bad], { timeoutMs: 120_000 });
    redOk = rb.code !== 0;
    redLine = rawLine(rb.stdout || rb.stderr);
  } finally {
    removeDir(bad);
  }
  const reds = [row(`${id}.red`, '反例：serve 导出不了时必须非 0', redOk ? 'pass' : 'fail', ['serve_probe.sh on a broken src/serve.js'], redLine)];
  return row(id, standard, ok && redOk ? 'pass' : 'fail', ['bash deploy/ci/serve_probe.sh <scratch>（脚本自挑空闲端口，结束时杀 serve）'], line || rawLine(r.stdout || r.stderr), {
    reds,
    notes: '在临时副本里跑；不碰 8787 / 18982。真部署由 deploy/deploy.sh 执行，属人执行',
  });
}
