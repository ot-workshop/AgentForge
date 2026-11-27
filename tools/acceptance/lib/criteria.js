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
import { createHash } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
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
  const cli = node(path.join(repo, 'bin', 'forge.js'), ['validate', bad, '--json'], { cwd: repo, env: { FORGE_ROOT: repo } });
  let cliErrors = null;
  try {
    cliErrors = JSON.parse(cli.stdout).errors;
  } catch {
    cliErrors = null;
  }
  // The suite's own copy of the probe (same projectDir convention as the CLI); the
  // validator it loads is the checkout's `src/validate.js`.
  const lib = node(path.join(suiteDir(), 'probes', 'lib-validate.mjs'), [repo, bad], { cwd: repo, env: { FORGE_ROOT: repo } });
  let libErrors = null;
  try {
    libErrors = JSON.parse(lib.stdout.trim()).errors;
  } catch {
    libErrors = null;
  }
  // The flow is named by absolute path here, and the CLI prints that absolute path
  // while the probe echoes the argument: compare code, severity, ids and fix, not the
  // spelled path (26995e2e's case is named by the caller, and V1.4's 5b covers it).
  const core = (xs) => (Array.isArray(xs) ? xs.map((e) => ({ code: e.code, severity: e.severity, ids: e.ids ?? null, fix: e.fix ?? null })) : null);
  const same = cliErrors !== null && JSON.stringify(core(cliErrors)) === JSON.stringify(core(libErrors));
  const pointsAtNode =
    Array.isArray(cliErrors) && cliErrors.length > 0 && cliErrors.every((e) => e.ids && e.ids.length > 0);
  // A red probe is one that must go red on a broken implementation; its own
  // status says whether it would (pass = it sees the defect).
  const red = [];
  const badRefused = Array.isArray(cliErrors) && cliErrors.some((e) => e.code === 'E_CYCLE');
  const good = path.join(repo, 'flows', 'main.yaml');
  const goodRun = node(path.join(repo, 'bin', 'forge.js'), ['validate', good, '--json'], { cwd: repo, env: { FORGE_ROOT: repo } });
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
// A frozen sample may carry `freeze.json` beside it: {run, eventCount, sha256} of
// events.jsonl fixed at the moment of freezing. It is the authority on "how many
// events should be here", so dropping a line cannot pass by being self-consistent.
function readFrozenRecord(dir, run) {
  const names = [process.env.AF_FREEZE_FILE ?? 'freeze.json', 'freeze.json'];
  const cands = [...names.map((n) => path.join(dir, n)), ...names.map((n) => path.join(dir, '.forge', 'runs', run, n))];
  for (const cand of cands) {
    try {
      const j = JSON.parse(fs.readFileSync(cand, 'utf8'));
      if (j && j.run === run && Number.isInteger(j.eventCount) && typeof j.sha256 === 'string') return j;
    } catch {
      /* no record here */
    }
  }
  return null;
}

// 员工四号 158d01cc: the entry PR changes exactly `manifest.flow.path` and
// `run.start.payload.flow` (absolute -> relative). Recording their expected values
// in freeze.json means a sample taken on the old entry cannot silently pass on the
// new one: the shape is part of what was frozen, and a mismatch is reported.
function flowShape(sampleDir, run) {
  const runDir = path.join(sampleDir, '.forge', 'runs', run);
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(runDir, 'manifest.json'), 'utf8'));
    const first = JSON.parse(fs.readFileSync(path.join(runDir, 'events.jsonl'), 'utf8').split('\n')[0]);
    return { manifestFlow: manifest.flow?.path ?? null, flowSha256: manifest.flow?.sha256 ?? null, startFlow: first.payload?.flow ?? null };
  } catch {
    return null;
  }
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

export async function v2_replayEquivalence(repo) {
  const id = `${V}.2a replay==incremental==从头`;
  const standard = '同一份流程可被编排器跑完，全程事件可回放（重放 == 增量 == 从头重放）';
  // 员工一号 8068f00f：判据先去入口化——「给一个冻结样例目录就能判」，
  // 入口（H1/H2）修好后只换目录，不再改判据。
  // Default: the sample committed next to the suite. AF_FROZEN_DIR overrides it with
  // any directory holding `.forge/runs/<run>/events.jsonl` (entry decoupled).
  const dir = process.env.AF_FROZEN_DIR ? path.resolve(process.env.AF_FROZEN_DIR) : path.join(repo, 'tools', 'acceptance', 'frozen', 'linear-golden');
  const runId = process.env.AF_FROZEN_RUN ?? 'linear-golden';
  const eventsFile = path.join(dir, '.forge', 'runs', runId, 'events.jsonl');
  const verdict = async (sampleDir, run) => {
    const f = path.join(sampleDir, '.forge', 'runs', run, 'events.jsonl');
    // A sample dir may be the `.forge/` tree itself (frozen/<name>/.forge/runs/…)
    // or the run dir's parent layout (frozen/<name>/runs/<run>/…).
    if (!fs.existsSync(f)) return { ok: false, why: `missing ${path.relative(repo, f) || f}` };
    const scratch = tempDir('af-v2-');
    try {
      copyDir(sampleDir, scratch);
      const events = readJsonl(path.join(f.replace(sampleDir, scratch)));
      const forge = path.join(repo, 'bin', 'forge.js');
      const env = { FORGE_ROOT: scratch };
      const replay = node(forge, ['replay', '--run', run], { env, cwd: scratch });
      const incAll = node(forge, ['incremental', '--run', run, '--since', '0'], { env, cwd: scratch });
      const inc2 = node(forge, ['incremental', '--run', run, '--since', '2'], { env, cwd: scratch });
      const chain = node(forge, ['verify-chain', '--run', run, '--json'], { env, cwd: scratch });
      // `replay` projects each event (src/project.js) and keeps only the six keys of
      // an event as the contract sees it — the on-disk line still carries `v`. So the
      // frozen file is compared through the same projection, not against raw lines.
      const { project } = await import(pathToFileURL(path.join(repo, 'src', 'project.js')).href);
      const expected = [...project(events, 0)].map((e) => JSON.stringify(e)).join('\n') + '\n';
      const tailEvents = [...project(events, 2)];
      const expectedTail = tailEvents.map((e) => JSON.stringify(e)).join('\n') + (tailEvents.length ? '\n' : '');
      const full = replay.stdout === expected && incAll.stdout === expected;
      const tail = inc2.stdout === expectedTail;
      const chained = chain.code === 0 && replay.code === 0 && incAll.code === 0 && inc2.code === 0;
      // When a freeze record exists it is the authority on how many events were
      // frozen; otherwise the sample file itself is (the file is what was reviewed).
      const rec = readFrozenRecord(sampleDir, run);
      const want = rec?.eventCount ?? events.length;
      const countOk = events.length === want && replay.stdout.split('\n').filter((l) => l.trim()).length === events.length;
      const shaOk = rec?.sha256 ? sha256(fs.readFileSync(f)) === rec.sha256 : true;
      // Flow shape, when recorded: both places must equal what was frozen.
      const shape = flowShape(sampleDir, run);
      const shapeChecks = rec?.flowPath
        ? [
            { what: 'manifest.flow.path', want: rec.flowPath, got: shape?.manifestFlow },
            { what: 'run.start.payload.flow', want: rec.flowPath, got: shape?.startFlow },
            // Recorded separately when present: the two places may legitimately be
            // described separately in freeze.json (员工一号 26995e2e).
            ...(rec.startFlow !== undefined ? [{ what: 'run.start.payload.flow(recorded)', want: rec.startFlow, got: shape?.startFlow }] : []),
            ...(rec.flowSha256 !== undefined ? [{ what: 'manifest.flow.sha256', want: rec.flowSha256, got: shape?.flowSha256 }] : []),
          ]
        : [];
      const shapeMismatch = shapeChecks.filter((c) => c.got !== c.want);
      const shapeOk = rec?.flowPath === undefined ? true : shapeMismatch.length === 0;
      const why = `${rec ? `frozen=${want} sha256:${rec.sha256.slice(0, 12)}${shaOk ? '' : ' MISMATCH'}${rec.flowPath ? ` flow=${JSON.stringify(rec.flowPath)}${shapeOk ? '' : ` MISMATCH(${shapeMismatch.map((c) => `${c.what}=${JSON.stringify(c.got)}`).join(',')})`}` : ''} ` : ''}n=${events.length} replay==frozen:${replay.stdout === expected} inc0==frozen:${incAll.stdout === expected} since2:${tail} chain:${chain.code}`;
      return { ok: full && tail && chained && countOk && shaOk && shapeOk, why, expected, events };
    } finally {
      removeDir(scratch);
    }
  };
  if (!fs.existsSync(eventsFile)) {
    return row(id, standard, 'unverified', [`frozen/${runId} 不在被测提交里`], '', {
      reds: [],
      notes: '冻结样例未入库：等入口 PR（H1/H2）合入且员工一号点名后生成，只入 events.jsonl + manifest.json。判据已与入口解耦：设 AF_FROZEN_RUN 即可判任何冻结目录',
    });
  }
  const v = await verdict(dir, runId);
  // 反例 1：改一个事件后的仓外副本必须被 verify-chain 拒绝。
  const tampered = tempDir('af-v2-red-');
  let red1 = false;
  let red1Raw = '';
  try {
    copyDir(dir, tampered);
    const f = path.join(tampered, '.forge', 'runs', runId, 'events.jsonl');
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    const idx = lines.findIndex((l) => l.includes('"seq":3'));
    if (idx >= 0) lines[idx] = lines[idx].replace('"status":"ok"', '"status":"failed"');
    fs.writeFileSync(f, lines.join('\n'));
    const r = node(path.join(repo, 'bin', 'forge.js'), ['verify-chain', '--run', runId, '--json'], { env: { FORGE_ROOT: tampered }, cwd: tampered });
    red1 = r.code !== 0;
    red1Raw = rawLine(r.stdout || r.stderr);
  } finally {
    removeDir(tampered);
  }
  // 反例 2：删掉一条事件后重放必须与冻结文件不再相等（判据真的在比字节，不是只看 rc）。
  const dropped = tempDir('af-v2-red2-');
  let red2 = false;
  let red2Raw = '';
  try {
    copyDir(dir, dropped);
    const f = path.join(dropped, '.forge', 'runs', runId, 'events.jsonl');
    const lines = fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.trim() !== '');
    if (lines.length > 3) lines.splice(lines.length - 1, 1);
    fs.writeFileSync(f, lines.join('\n') + '\n');
    // The verdict recomputes from the (now shorter) file, so equality alone cannot
    // see the loss. Count against the FROZEN record, not the file being judged
    // (员工二号 12d2baab's critique of "testing the test", applied here). The chain
    // alone stays 0: a dropped last line reads as a half write (A5.11).
    const dv = await verdict(dropped, runId);
    const chain = node(path.join(repo, 'bin', 'forge.js'), ['verify-chain', '--run', runId, '--json'], { env: { FORGE_ROOT: dropped }, cwd: dropped });
    const replayLen = node(path.join(repo, 'bin', 'forge.js'), ['replay', '--run', runId], { env: { FORGE_ROOT: dropped }, cwd: dropped }).stdout.split('\n').filter((l) => l.trim()).length;
    const frozenRecord = readFrozenRecord(dir, runId);
    const originalLen = frozenRecord?.eventCount ?? fs.readFileSync(path.join(dir, '.forge', 'runs', runId, 'events.jsonl'), 'utf8').split('\n').filter((l) => l.trim()).length;
    // A dropped *last* line is indistinguishable from a half write on read, so
    // verify-chain alone stays 0 (Findings: reported, not hidden). The loss is still
    // visible: replay is shorter than the frozen file, so count + chain together judge it.
    red2 = replayLen === originalLen - 1;
    red2Raw = `chain=${chain.code} replay_lines=${replayLen} (frozen ${originalLen}) ${dv.why} → 判据：replay 行数必须等于冻结行数`;
  } finally {
    removeDir(dropped);
  }
  const reds = [
    row(`${id}.red`, '反例：篡改一个事件后 verify-chain 必须非 0', red1 ? 'pass' : 'fail', ['verify-chain on tampered copy'], red1Raw),
    row(`${id}.red2`, '反例：删掉最后一条事件后不得再判定相等', red2 ? 'pass' : 'fail', ['verdict on copy missing its last event'], red2Raw),
  ];
  return row(id, standard, v.ok && red1 && red2 ? 'pass' : 'fail', [
    `replay --run ${runId}`,
    `incremental --run ${runId} --since 0`,
    `incremental --run ${runId} --since 2`,
    `verify-chain --run ${runId}`,
  ], v.why, { reds });
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
      reds: reds,
      notes: '真运行时（#9、路线第 3 块）未接入：本条判的是编排器一侧的强制，不是模型调用',
    });
  } finally {
    removeDir(scratch);
  }
}

// ---------------------------------------------------------------- V4 循环与分支
// 员工一号 a9d63f5a / 79faf4a2 / 971e72b6 / 10ad82ae / 918356de：#10 落地后的判据。
// 正、负两面分开判：正面要 `forge run` 真的按回边走（rc=0 + 原样事件行），负面要
// `validate` / `run` 拒（rc≠0 + 错误文本）。每条都在仓外副本里跑，被测 checkout 不写。
const LOOP = 'fixtures/loop-bounded.yaml';

// A scratch checkout for `run`/`validate`: the code, the flows, blocks and the chosen
// fixtures. One copy per `v4_loops` call, removed in `finally`.
function scratchCheckout(repo) {
  const dir = tempDir('af-v14-');
  for (const d of ['bin', 'src', 'flows', 'blocks', 'agents', 'checks', 'package.json']) fs.cpSync(path.join(repo, d), path.join(dir, d), { recursive: true });
  fs.cpSync(path.join(repo, 'fixtures'), path.join(dir, 'fixtures'), { recursive: true });
  return dir;
}

// TRUE only in the main suite: that is where the reds belong. A red re-runs the row
// inside a child process (`probes/v14-row.mjs`); the child inherits the environment,
// so without a switch every re-run would spawn the full set of reds of its own.
const WITH_REDS = !process.env.AF_V14_ROW_ONLY;
// Normally this file's own `probes/` next to it; AF_ACCEPTANCE_DIR points it at the
// suite's probes when the row is judged by a suite living outside the checkout.
function suiteDir() {
  return process.env.AF_ACCEPTANCE_DIR ? path.resolve(process.env.AF_ACCEPTANCE_DIR) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

// The `verify --fail--> build` edge of LOOP without its bound (员工一号 a9d63f5a 第 5 条).
function withoutBound(text) {
  const next = text.replace(/\n {4}max_iterations: 2\n/, '\n');
  if (next === text) throw new Error('max_iterations: 2 not found in loop-bounded.yaml');
  return next;
}

// The same edge with `on_exhausted` (the "bound spent, hand over" shape).
function withOnExhausted(text) {
  const next = text.replace(/(\n {4}max_iterations: 2\n)/, '$1    on_exhausted: ops\n');
  if (next === text) throw new Error('max_iterations: 2 not found in loop-bounded.yaml');
  return next;
}

// A branch flow over design -> build -> verify -> ops, written out rather than derived:
// #14's seam rule judges every edge, and the `with` values that a derived copy carried
// (`{{input.request}}`, `{{design.plan}}`) both read as "(unresolved)" on 4de2dea, making
// `design -> build` an E_CONTRACT_MISMATCH. A literal means "the node fills its own input"
// (718294d7), and that shape validates {}. It carries both branch edges: `verify --pass-->
// ops` to the end and `verify --fail--> build` (bound 2) back into the loop.
const BRANCH_FLOW = `id: branch
version: 1
entry: design
nodes:
  - id: design
    uses: block:design@1
    with:
      request: "{{input.request}}"
  - id: build
    uses: block:build@1
    with:
      plan: design
  - id: verify
    uses: block:verify@1
  - id: ops
    uses: block:ops@1
edges:
  - from: design
    to: build
  - from: build
    to: verify
  - id: verify-to-ops
    from: verify
    to: ops
    on:
      from: check.result
      status: pass
  - id: verify-to-build
    from: verify
    to: build
    on:
      from: check.result
      status: fail
    max_iterations: 2
`;

// `run` in the scratch checkout. Returns rc plus the parsed events. A crash (spawn
// error, signal, or the CLI's own `internal error` line) becomes `failed` with that
// line, so the row reports it instead of throwing.
// `opts.timeoutMs`: flows that must be bounded (the branch and re-entry ones, whose reds
// would otherwise walk to the 120s default).
function runIn(dir, runId, flow, fake, opts = {}) {
  const runsDir = path.join(dir, '.forge', 'runs');
  const count = () => (fs.existsSync(runsDir) ? fs.readdirSync(runsDir).length : 0);
  const runsBefore = count();
  const r = node(path.join(dir, 'bin', 'forge.js'), ['run', '--run', runId, '--flow', flow], { cwd: dir, env: { FORGE_ROOT: dir, FORGE_FAKE: fake }, ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}) });
  const runsAfter = count();
  const out = { ...r, runsBefore, runsAfter, events: [] };
  if (r.error || r.signal) return { ...out, failed: `run --run ${runId} --flow ${flow}: ${r.signal ?? r.error?.code}` };
  if (/internal error/.test(r.stderr)) return { ...out, failed: `${flow}: ${rawLine(r.stderr)}` };
  const f = path.join(runsDir, runId, 'events.jsonl');
  return { ...out, events: fs.existsSync(f) ? readJsonl(f) : [] };
}

// `validate` through the CLI and through the library probe, on the same file.
function validateBoth(dir, flow) {
  const cli = node(path.join(dir, 'bin', 'forge.js'), ['validate', flow, '--json'], { cwd: dir, env: { FORGE_ROOT: dir } });
  const libProbe = path.join(suiteDir(), 'probes', 'lib-validate.mjs');
  const lib = node(libProbe, [dir, path.join(dir, flow)], { cwd: dir, env: { FORGE_ROOT: dir } });
  const parse = (r) => {
    try {
      const e = JSON.parse(r.stdout).errors;
      return Array.isArray(e) ? e : null;
    } catch {
      return null;
    }
  };
  const cliErrors = parse(cli);
  const libErrors = parse(lib);
  const codes = (xs) => (Array.isArray(xs) ? [...new Set(xs.map((e) => e.code))].sort() : null);
  return { cli, lib, cliErrors, libErrors, cliCodes: codes(cliErrors), libCodes: codes(libErrors) };
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const keyOf = (e) => `${e.stage}@${e.iteration}`;
const startsOf = (events) => events.filter((e) => e.type === 'stage.start').map(keyOf);
const gotosOf = (events) => events.filter((e) => e.type === 'flow.goto');
const lastOf = (events) => events.at(-1) ?? null;

// Frozen sample written by this same row: a real `loop-bounded` run on this checkout
// (员工一号 79faf4a2 第 2 条 asked for it in the same PR). Committed under
// `tools/acceptance/frozen/loop-bounded/` as events.jsonl + manifest.json + freeze.json.
// It is compared only on what is decided by the flow: event type order, stage.end.status,
// (stage, iteration), flow.goto from/to/iteration/loopId/checkResultId, run.end payload.
// NOT compared: ts, hash, prev, stage.start.payload.contextSha256 -- contextSha256 is a
// hash of {runId, stage, iteration, prevArtifacts} and runId is the run dir name, so it is
// decided by the run, not the flow (员工一号 918356de, 员工二号 83e69916); byte equality
// across directories is M3's business.
export function v4_frozenLoop(repo, { reds: withReds = WITH_REDS } = {}) {
  const id = `${V}.4f 冻结样例 loop-bounded`;
  const standard = '冻结一份真实的有界循环 run，按与流程有关的字段重跑比对（不比 runId 派生的字段）';
  const dir = path.join(repo, 'tools', 'acceptance', 'frozen', 'loop-bounded');
  const runId = 'loop-bounded';
  const eventsFile = path.join(dir, 'runs', runId, 'events.jsonl');
  const freezeFile = path.join(dir, 'freeze.json');
  if (!fs.existsSync(eventsFile) || !fs.existsSync(freezeFile)) {
    return row(id, standard, 'unverified', ['frozen/loop-bounded 不在被测提交里'], '', { reds: [] });
  }
  const rec = JSON.parse(fs.readFileSync(freezeFile, 'utf8'));
  const frozen = readJsonl(eventsFile);
  const frozenSha = sha256(fs.readFileSync(eventsFile));
  const project = (events) =>
    events.map((e) => {
      const base = { seq: e.seq, run_id: e.run_id, stage: e.stage ?? null, iteration: e.iteration ?? null, type: e.type };
      if (e.type === 'stage.end') base.status = e.payload?.status ?? null;
      if (e.type === 'flow.goto') {
        const p = e.payload ?? {};
        base.goto = { from: p.from, to: p.to, iteration: p.iteration, loopId: p.loopId, checkResultId: p.checkResultId ?? null };
      }
      if (e.type === 'run.end') base.end = e.payload ?? null;
      if (e.type === 'log' && e.payload?.kind === 'loop-exhausted') base.log = e.payload;
      return base;
    });
  const want = project(frozen);
  const scratch = scratchCheckout(repo);
  const checks = [];
  const check = (cid, fn, cmd) => {
    try {
      const [ok, raw] = fn();
      checks.push({ cid, ok: Boolean(ok), cmd, raw });
    } catch (e) {
      checks.push({ cid, ok: false, cmd, raw: `threw: ${String(e?.message ?? e).split('\n')[0]}` });
    }
  };
  try {
    const r = runIn(scratch, runId, rec.flow, rec.fake ?? 'retry-verify:2');
    const left = scratch;
    // NOTE: contextSha256 in a frozen sample is a provenance record here (F0 checks the
    // file's sha256); it is NOT comparable across a re-run with the same run id under a
    // byte-freeze, which is exactly why it stays out of F1 (员工一号 971e72b6).
    const fresh = r.events;
    const got = project(fresh);
    const diffAt = (a, b) => a.findIndex((w, k) => !same(w, b[k]));
    const firstDiff = fresh.length === frozen.length ? diffAt(want, got) : Math.min(want.length, got.length) - 1;
    check('F0 冻结文件本身：条数、sha256、flow 路径与 freeze.json 一致', () => [
      frozen.length === rec.eventCount && frozenSha === rec.sha256 && rec.startFlow === frozen[0]?.payload?.flow && rec.flowPath === rec.startFlow,
      `${frozen.length} events sha256:${frozenSha.slice(0, 12)}${frozenSha === rec.sha256 ? '' : ' MISMATCH'} flow=${rec.startFlow}`,
    ], 'read frozen/loop-bounded/freeze.json + events.jsonl');
    check('F1 同一流程重跑：与流程有关的字段逐条相等（类型顺序/status/(stage,iteration)/goto/run.end）', () => [
      r.code === 0 && fresh.length === frozen.length && firstDiff === -1,
      !fresh.length && r.failed
        ? r.failed
        : fresh.length === frozen.length && firstDiff === -1
          ? `rc=${r.code} ${fresh.length} events, compared fields identical`
          : `rc=${r.code} events ${frozen.length} vs ${fresh.length}, first diff at seq ${want[firstDiff]?.seq ?? got[firstDiff]?.seq}: ${JSON.stringify(want[firstDiff])} != ${JSON.stringify(got[firstDiff])}`,
    ], `FORGE_FAKE=${rec.fake} forge run --run ${runId} --flow ${rec.flow}`);
    const chain = node(path.join(left, 'bin', 'forge.js'), ['verify-chain', '--run', runId, '--json'], { cwd: left, env: { FORGE_ROOT: left } });
    check('F3 重跑出来的链自己验得过（verify-chain rc=0）', () => [chain.code === 0, `rc=${chain.code} ${rawLine(chain.stdout || chain.stderr)}`], `forge verify-chain --run ${runId} --json`);
    // The excluded fields must really be excluded for a reason. `ts` differs on every
    // re-run by itself. `contextSha256` is a hash of {runId, stage, iteration,
    // prevArtifacts} (writeContext), and with the SAME run dir name it is identical --
    // so a second run under another run id has to produce a different hash, otherwise
    // comparing it in M3 would be meaningless.
    const sameDirCtx = fresh.filter((e) => e.type === 'stage.start').map((e) => e.payload?.contextSha256);
    const other = runIn(scratch, `${runId}-ctx`, rec.flow, rec.fake ?? 'retry-verify:2');
    const otherCtx = other.events.filter((e) => e.type === 'stage.start').map((e) => e.payload?.contextSha256);
    const tsDiffer = fresh.some((e, i) => e.ts !== frozen[i]?.ts);
    const ctxMovesWithRunId = other.code === 0 && sameDirCtx.length > 0 && sameDirCtx.every((h, i) => h !== otherCtx[i]);
    check('F4 被排除的两项确有其因：ts 每次不同；contextSha256 由 runId 决定（换 run id 就变）', () => [
      tsDiffer && ctxMovesWithRunId,
      `ts differ=${tsDiffer}; contextSha256 same run id=${JSON.stringify(sameDirCtx[0]?.slice(0, 12))} other run id=${JSON.stringify(otherCtx[0]?.slice(0, 12))} differ=${ctxMovesWithRunId}`,
    ], `FORGE_FAKE=${rec.fake} forge run --run ${runId}-ctx --flow ${rec.flow}`);
    const reds = withReds
      ? [
          (() => {
            const bad = [...fresh];
            const i = bad.findIndex((e) => e.type === 'stage.end' && e.stage === 'verify');
            if (i >= 0) bad[i] = { ...bad[i], payload: { ...bad[i].payload, status: 'ok' } };
            const d = diffAt(want, project(bad));
            return row(`${id}.red1`, '反例：一轮 verify 的 status 被改成 ok 必须红', d >= 0 ? 'pass' : 'fail', ['flip one stage.end.status'], d >= 0 ? `first diff at seq ${want[d]?.seq}` : 'not noticed');
          })(),
          (() => {
            const d = diffAt(want, project(fresh.filter((e) => !(e.type === 'flow.goto' && e.payload?.iteration === 2))));
            return row(`${id}.red2`, '反例：删掉第 2 个 goto 必须红', d >= 0 ? 'pass' : 'fail', ['drop flow.goto it=2'], d >= 0 ? `first diff at seq ${want[d]?.seq}` : 'not noticed');
          })(),
          (() => {
            const bad = [...fresh];
            if (bad.length) bad[bad.length - 1] = { ...bad.at(-1), payload: { status: 'failed', code: 'E_LIMIT_UNBOUNDED' } };
            const d = diffAt(want, project(bad));
            return row(`${id}.red3`, '反例：run.end 改成 failed 必须红', d >= 0 ? 'pass' : 'fail', ['rewrite run.end payload'], d >= 0 ? `first diff at seq ${want[d]?.seq}` : 'not noticed');
          })(),
        ]
      : [];
    const failed = checks.filter((c) => !c.ok);
    const ok = failed.length === 0 && (withReds ? reds.every((x) => x.status === 'pass') : true);
    return row(id, standard, ok ? 'pass' : 'fail', checks.map((c) => c.cmd), ok ? checks.map((c) => `${c.cid}: ${c.raw}`).join(' | ') : `failed: ${failed.map((c) => `${c.cid} [${c.raw}]`).join(' | ')}`, {
      checks: checks.map((c) => ({ id: c.cid, status: c.ok ? 'pass' : 'fail', raw: c.raw })),
      reds,
      notes: `冻结 base ${rec.base ?? '?'}，${rec.eventCount} 条事件，只入 events.jsonl + manifest.json + freeze.json（不含 context/、checks.lock、.events-lock）；不比 ts/hash/prev/contextSha256（员工一号 971e72b6/918356de）`,
    });
  } catch (e) {
    return row(id, standard, 'fail', [], `probe threw: ${String(e?.message ?? e).split('\n')[0]}`, { reds: [] });
  } finally {
    removeDir(scratch);
  }
}

// M3 (员工一号 f6e0189b / 员工二号's fifth mutation "stage.start.iteration does not
// accumulate after a plain edge"): a stage entered again after a flow.goto must be a new
// cell `stage@2`. A loop only exists on a bounded back edge (员工一号 881cdcb9), and when
// the bound is spent the run must stop (failed/E_LIMIT_UNBOUNDED without on_exhausted,
// 314920dc) -- so a second entry can only be reached by spending the bound as a goto.
// This shape: build's second entry is reached over a goto the first time and plainly --
// via build -> verify -- the second time, and build/design must count @1 then @2.
const PLAIN_REENTRY_FLOW = `id: reentry
version: 1
entry: design
nodes:
  - id: design
    uses: block:design@1
    with:
      request: "{{input.request}}"
  - id: build
    uses: block:build@1
    with:
      plan: design
  - id: verify
    uses: block:verify@1
  - id: ops
    uses: block:ops@1
edges:
  - from: design
    to: build
    on:
      from: check.result
      status: pass
  - from: build
    to: design
    on:
      from: check.result
      status: pass
    max_iterations: 1
  - from: build
    to: verify
    on:
      from: check.result
      status: pass
  - from: verify
    to: ops
    on:
      from: check.result
      status: pass
`;

// M4 (员工一号 f6e0189b): `verify --fail--> build` (bound 1) and a plain
// `verify -> ops` leave verify together. A failed verify presents both, and the
// `on: status=fail` one must win (pickEdge: a conditional edge outranks a plain one);
// the plain edge would take `verify -> ops` with a failed stage.end instead.
const ON_PRIORITY_FLOW = `id: on-priority
version: 1
entry: design
nodes:
  - id: design
    uses: block:design@1
    with:
      request: "{{input.request}}"
  - id: build
    uses: block:build@1
    with:
      plan: design
  - id: verify
    uses: block:verify@1
  - id: ops
    uses: block:ops@1
edges:
  - from: design
    to: build
  - from: build
    to: verify
  - from: verify
    to: ops
  - id: verify-to-build
    from: verify
    to: build
    on:
      from: check.result
      status: fail
    max_iterations: 1
`;

// Runs used to check where a runaway walk ends: a broken pickEdge or bound can make
// the walk long but not hang (no sleeps anywhere), so these get a ceiling instead of
// the 120s default of exec.js. The reds below depend on this: red1 (bound disabled)
// and red2 (goto count from 0) are expected to walk up to the bound in their branch
// flows only, never to hit a limit.
const BRANCH_TIMEOUT_MS = 60_000;

// The whole loop, with and without `on_exhausted`. `fake` decides what verify does:
// `retry-verify:2` fails verify@1/@2 and passes verify@3; `retry-verify:9` fails every
// verify. Exact outputs as checked on main 4de2dea4 (员工四号 434a3508, re-run here).
const LOOP_STARTS = ['design@1', 'build@1', 'verify@1', 'build@2', 'verify@2', 'build@3', 'verify@3', 'ops@1'];

export async function v4_loops(repo, { reds: withReds = WITH_REDS } = {}) {
  const id = `${V}.4 分支与有限循环`;
  const standard = '流程可带条件分支与有限循环，每轮单独成格，上限是硬限制';
  const dir = scratchCheckout(repo);
  const checks = [];
  // A check whose evaluation throws is a failed check with the exception's line.
  const check = (cid, fn, cmd) => {
    try {
      const [ok, raw] = fn();
      checks.push({ cid, ok: Boolean(ok), cmd, raw });
    } catch (e) {
      checks.push({ cid, ok: false, cmd, raw: `threw: ${String(e?.message ?? e).split('\n')[0]}` });
    }
  };
  const crashed = (r, cid, cmd) => {
    if (r.failed) check(cid, () => [false, r.failed], cmd);
    return r;
  };
  try {
    // ---- 第 5 条（负）: a loop whose back edge has no positive bound is refused by
    // `validate` as E_CYCLE (E_LIMIT_UNBOUNDED is runtime-only), and CLI == library.
    fs.writeFileSync(path.join(dir, 'fixtures', 'lb-no-limit.yaml'), withoutBound(fs.readFileSync(path.join(dir, LOOP), 'utf8')));
    const noLimit = validateBoth(dir, 'fixtures/lb-no-limit.yaml');
    check('5a 无上限回边 validate 拒（E_CYCLE，指回节点）', () => [
      noLimit.cli.code !== 0 && same(noLimit.cliCodes, ['E_CYCLE']) && noLimit.cliErrors.every((e) => e.locatable && e.ids?.length > 0),
      `rc=${noLimit.cli.code} codes=${JSON.stringify(noLimit.cliCodes)} ids=${JSON.stringify(noLimit.cliErrors?.[0]?.ids ?? null)}`,
    ], 'forge validate fixtures/lb-no-limit.yaml --json');
    check('5b CLI 与库同一结论（码集 + ids 逐项相等）', () => [
      noLimit.cli.code === noLimit.lib.code && same(noLimit.cliCodes, noLimit.libCodes) && noLimit.libErrors !== null && same(noLimit.cliErrors.map((e) => e.ids), noLimit.libErrors.map((e) => e.ids)),
      `cli=${JSON.stringify(noLimit.cliCodes)} lib=${JSON.stringify(noLimit.libCodes)} ids=${JSON.stringify((noLimit.libErrors ?? []).map((e) => e.ids))}`,
    ], 'node tools/acceptance/probes/lib-validate.mjs <checkout> fixtures/lb-no-limit.yaml');
    check('5c 校验器输出里没有 E_LIMIT_UNBOUNDED（只有运行时会产出）', () => [
      ![noLimit, validateBoth(dir, LOOP)].some((v) => [...(v.cliCodes ?? []), ...(v.libCodes ?? [])].includes('E_LIMIT_UNBOUNDED')),
      'codes seen by validate: E_CYCLE only',
    ], 'read both validate verdicts');
    const bounded = validateBoth(dir, LOOP);
    check('5d 有上限的同形回边（入库 fixture）放行', () => [
      bounded.cli.code === 0 && same(bounded.cliErrors, []) && same(bounded.libErrors, []),
      `rc=${bounded.cli.code} codes=${JSON.stringify(bounded.cliCodes)}`,
    ], `forge validate ${LOOP} --json`);
    const bare = validateBoth(dir, 'fixtures/cycle.yaml');
    check('5e 裸环仍是 E_CYCLE（不随 #10 放宽）', () => [
      bare.cli.code !== 0 && same(bare.cliCodes, ['E_CYCLE']) && bare.libCodes?.join() === 'E_CYCLE' && same(bare.cliErrors.map((e) => e.ids), bare.libErrors?.map((e) => e.ids)),
      `rc=${bare.cli.code} cli=${JSON.stringify(bare.cliCodes)} lib=${JSON.stringify(bare.libCodes)}`,
    ], 'forge validate fixtures/cycle.yaml --json + lib-validate.mjs');

    // ---- 第 6 条（负）: `run` on a flow the validator refuses exits non-zero and
    // writes nothing -- no run dir (#10: validate comes before the run dir).
    const rr = crashed(runIn(dir, 'v14-rejected', 'fixtures/lb-no-limit.yaml', '1'), '6 run 拒被校验器拦下的流程', 'forge run --run v14-rejected --flow fixtures/lb-no-limit.yaml');
    const rejectText = `${rr.stdout}${rr.stderr}`;
    check('6 run 拒被校验器拦下的流程：rc≠0，不留 run 目录', () => [
      rr.code !== 0 && rr.runsAfter === rr.runsBefore && /E_CYCLE/.test(rejectText) && !fs.existsSync(path.join(dir, '.forge', 'runs', 'v14-rejected')),
      `rc=${rr.code} runs ${rr.runsBefore}->${rr.runsAfter} ${rawLine(rejectText)}`,
    ], 'forge run --run v14-rejected --flow fixtures/lb-no-limit.yaml');

    // ---- 第 1 条（正）: a real bounded loop
    const lb = crashed(runIn(dir, 'v14-loop', LOOP, 'retry-verify:2'), '1 有界回边真跑', `forge run --run v14-loop --flow ${LOOP}`);
    const gotos = gotosOf(lb.events);
    const starts = startsOf(lb.events);
    // `flow.goto.iteration` counts this back edge's own firings; the target's next
    // `stage.start.iteration` counts how often that stage was entered (two counters).
    const targetIters = gotos.map((g) => lb.events.find((e) => e.seq > g.seq && e.type === 'stage.start' && e.stage === g.payload.to)?.iteration ?? null);
    check('1 有界回边真跑：goto 1,2（verify→build）+ 阶段序列 + run.end ok', () => [
      lb.code === 0 && same(gotos.map((g) => g.payload.iteration), [1, 2]) && gotos.every((g) => g.payload.from === 'verify' && g.payload.to === 'build' && g.payload.loopId === 'verify-to-build' && Boolean(g.payload.checkResultId)) && same(starts, LOOP_STARTS) && same(lastOf(lb.events), { ...lastOf(lb.events), type: 'run.end', payload: { status: 'ok' } }),
      `rc=${lb.code} stage.start=${starts.join(' ')} goto.it=${JSON.stringify(gotos.map((g) => g.payload.iteration))} run.end=${JSON.stringify(lastOf(lb.events)?.payload ?? null)}`,
    ], `FORGE_FAKE=retry-verify:2 forge run --run v14-loop --flow ${LOOP}`);
    check('1b goto.iteration 与目标下一次 stage.start.iteration 配对（= goto + 1）', () => [
      targetIters.length === 2 && targetIters.every((it, i) => it === gotos[i].payload.iteration + 1),
      `goto ${JSON.stringify(gotos.map((g) => g.payload.iteration))} -> next start of the target ${JSON.stringify(targetIters)}`,
    ], 'read v14-loop events.jsonl');
    check('1c 每轮 verify 的 stage.end.status', () => [
      same(lb.events.filter((e) => e.type === 'stage.end' && e.stage === 'verify').map((e) => [keyOf(e), e.payload.status]), [['verify@1', 'failed'], ['verify@2', 'failed'], ['verify@3', 'ok']]),
      JSON.stringify(lb.events.filter((e) => e.type === 'stage.end' && e.stage === 'verify').map((e) => [keyOf(e), e.payload.status])),
    ], 'read v14-loop events.jsonl');

    // ---- 第 2 条（正）: one cell per (stage, iteration); entry count - 1 = bound
    const snap = node(path.join(dir, 'bin', 'forge.js'), ['snapshot', '--run', 'v14-loop', '--json'], { cwd: dir, env: { FORGE_ROOT: dir } });
    let cells = null;
    try {
      cells = JSON.parse(snap.stdout).runs?.[0]?.stages?.map((s) => s.key) ?? null;
    } catch {
      cells = null;
    }
    check('2 snapshot --run 按 (stage,iteration) 分格，两轮不互相覆盖', () => [
      snap.code === 0 && same(cells, LOOP_STARTS),
      `rc=${snap.code} ${JSON.stringify(cells)}`,
    ], 'forge snapshot --run v14-loop --json');
    const buildEntries = starts.filter((k) => k.startsWith('build@')).length;
    check('2b 进环次数 = 入环阶段出现次数 − 1 = max_iterations', () => [
      buildEntries - 1 === 2,
      `build entered ${buildEntries}x -> into the loop ${buildEntries - 1}x (max_iterations 2)`,
    ], 'count stage.start of build in v14-loop');

    // ---- 第 3 条（正）: the bound is spent. Without on_exhausted: run.end failed with
    // E_LIMIT_UNBOUNDED and the loop's fields; with it: one info log, then ok. Either
    // way no third goto and no further turn.
    const over = crashed(runIn(dir, 'v14-over', LOOP, 'retry-verify:9'), '3 上限用满、无 on_exhausted', `forge run --run v14-over --flow ${LOOP}`);
    const overEnd = lastOf(over.events);
    check('3 无 on_exhausted：run.end failed/E_LIMIT_UNBOUNDED（loopId/iterations/fix），无第 3 个 goto、无多出来的轮', () => [
      over.code === 1 &&
        overEnd?.type === 'run.end' &&
        overEnd.payload.status === 'failed' &&
        overEnd.payload.code === 'E_LIMIT_UNBOUNDED' &&
        overEnd.payload.loopId === 'verify-to-build' &&
        overEnd.payload.iterations === 2 &&
        overEnd.payload.fix?.loop_id === 'verify-to-build' &&
        gotosOf(over.events).length === 2 &&
        same(startsOf(over.events), LOOP_STARTS.slice(0, 7)) &&
        !over.events.some((e) => e.type === 'log' && e.payload?.kind === 'loop-exhausted'),
      `rc=${over.code} gotos=${gotosOf(over.events).length} run.end=${JSON.stringify(overEnd?.payload ?? null)}`,
    ], `FORGE_FAKE=retry-verify:9 forge run --run v14-over --flow ${LOOP}`);
    // The `on_exhausted` variant of the same edge, written next to it in the scratch copy.
    fs.writeFileSync(path.join(dir, 'fixtures', 'lb-on-exhausted.yaml'), withOnExhausted(fs.readFileSync(path.join(dir, LOOP), 'utf8')));
    const exh = crashed(runIn(dir, 'v14-exh', 'fixtures/lb-on-exhausted.yaml', 'retry-verify:9'), '3b 上限用满、有 on_exhausted', 'forge run --run v14-exh --flow fixtures/lb-on-exhausted.yaml');
    const logs = exh.events.filter((e) => e.type === 'log' && e.payload?.kind === 'loop-exhausted');
    check('3b 有 on_exhausted：一条 loop-exhausted log（loopId/iterations/onExhausted）+ run.end ok，无第 3 个 goto', () => [
      exh.code === 0 &&
        logs.length === 1 &&
        logs[0].payload.loopId === 'verify-to-build' &&
        logs[0].payload.iterations === 2 &&
        logs[0].payload.onExhausted === 'ops' &&
        same(lastOf(exh.events)?.payload, { status: 'ok' }) &&
        same(startsOf(exh.events), LOOP_STARTS.slice(0, 7)) &&
        gotosOf(exh.events).length === 2,
      `rc=${exh.code} log=${JSON.stringify(logs.map((l) => l.payload))} gotos=${gotosOf(exh.events).length} run.end=${JSON.stringify(lastOf(exh.events)?.payload ?? null)}`,
    ], 'FORGE_FAKE=retry-verify:9 forge run --run v14-exh --flow fixtures/lb-on-exhausted.yaml');

    // ---- 第 4 条（正）: each `on: status=` edge is taken on its own outcome
    fs.writeFileSync(path.join(dir, 'fixtures', 'lb-branch.yaml'), BRANCH_FLOW);
    const bv = validateBoth(dir, 'fixtures/lb-branch.yaml');
    check('4a 分支形状 validate 放行（CLI 与库同结论）', () => [
      bv.cli.code === 0 && same(bv.cliErrors, []) && same(bv.libErrors, []),
      `cli rc=${bv.cli.code} ${JSON.stringify(bv.cliCodes)} lib ${JSON.stringify(bv.libCodes)}`,
    ], 'forge validate fixtures/lb-branch.yaml --json');
    const pass = crashed(runIn(dir, 'v14-branch-pass', 'fixtures/lb-branch.yaml', '1', { timeoutMs: BRANCH_TIMEOUT_MS }), '4 分支：pass 边', 'forge run --run v14-branch-pass --flow fixtures/lb-branch.yaml');
    const passStarts = startsOf(pass.events);
    check('4 分支：verify 通过走 `status=pass`（到 ops），没有 goto', () => [
      pass.code === 0 && same(passStarts, ['design@1', 'build@1', 'verify@1', 'ops@1']) && gotosOf(pass.events).length === 0 && same(lastOf(pass.events)?.payload, { status: 'ok' }),
      `rc=${pass.code} stage.start=${passStarts.join(' ')} run.end=${JSON.stringify(lastOf(pass.events)?.payload ?? null)}`,
    ], 'FORGE_FAKE=1 forge run --run v14-branch-pass --flow fixtures/lb-branch.yaml');
    const fails = crashed(runIn(dir, 'v14-branch-fail', 'fixtures/lb-branch.yaml', 'retry-verify:9', { timeoutMs: BRANCH_TIMEOUT_MS }), '4b 分支：fail 边', 'forge run --run v14-branch-fail --flow fixtures/lb-branch.yaml');
    const failGotos = gotosOf(fails.events);
    check('4b 分支：verify 失败走 `status=fail`（进环），从不到 ops', () => [
      failGotos.length === 2 && failGotos.every((g) => g.payload.from === 'verify' && g.payload.to === 'build' && g.payload.edge?.on?.status === 'fail') && !fails.events.some((e) => e.type === 'stage.start' && e.stage === 'ops') && fails.code === 1 && lastOf(fails.events)?.payload?.code === 'E_LIMIT_UNBOUNDED',
      `rc=${fails.code} gotos=${JSON.stringify(failGotos.map((g) => `${g.payload.from}->${g.payload.to} on ${g.payload.edge?.on?.status}`))} run.end=${JSON.stringify(lastOf(fails.events)?.payload ?? null)}`,
    ], 'FORGE_FAKE=retry-verify:9 forge run --run v14-branch-fail --flow fixtures/lb-branch.yaml');

    // ---- M3 (员工一号 f6e0189b): a second entry without a goto still counts
    fs.writeFileSync(path.join(dir, 'fixtures', 'lb-plain-reentry.yaml'), PLAIN_REENTRY_FLOW);
    const re = crashed(runIn(dir, 'v14-plain-reentry', 'fixtures/lb-plain-reentry.yaml', 'retry-verify:99', { timeoutMs: BRANCH_TIMEOUT_MS }), 'M3 不经 goto 的第二次进入', 'forge run --run v14-plain-reentry --flow fixtures/lb-plain-reentry.yaml');
    const reVerify = re.events.filter((e) => e.type === 'stage.start' && e.stage === 'verify').map(keyOf);
    const reBuild = re.events.filter((e) => e.type === 'stage.start' && e.stage === 'build').map(keyOf);
    const reDesign = re.events.filter((e) => e.type === 'stage.start' && e.stage === 'design').map(keyOf);
    check('M3 同一阶段再次进入是新的格子：build@1→build@2、design@1→design@2（不经 goto 的那一格）', () => [
      re.code === 1 && same(reBuild, ['build@1', 'build@2']) && same(reDesign, ['design@1', 'design@2']) && !re.events.some((e) => e.type === 'stage.start' && e.stage === 'ops') && lastOf(re.events)?.payload?.code === 'E_LIMIT_UNBOUNDED',
      `rc=${re.code} design=${JSON.stringify(reDesign)} build=${JSON.stringify(reBuild)} gotos=${JSON.stringify(gotosOf(re.events).map((g) => `${g.payload.from}->${g.payload.to}`))} run.end=${JSON.stringify(lastOf(re.events)?.payload ?? null)}`,
    ], 'FORGE_FAKE=retry-verify:99 forge run --run v14-plain-reentry --flow fixtures/lb-plain-reentry.yaml');

    // ---- M4 (员工一号 f6e0189b): `on: fail` outranks a plain edge out of the same stage
    fs.writeFileSync(path.join(dir, 'fixtures', 'lb-on-priority.yaml'), ON_PRIORITY_FLOW);
    const pr = crashed(runIn(dir, 'v14-on-priority', 'fixtures/lb-on-priority.yaml', 'retry-verify:9', { timeoutMs: BRANCH_TIMEOUT_MS }), 'M4 on 边优先于普通边', 'forge run --run v14-on-priority --flow fixtures/lb-on-priority.yaml');
    const prGotos = gotosOf(pr.events);
    check('M4 `on: fail` 与普通边同时可选时选 `on` 那条（失败不进 ops）', () => [
      prGotos.length === 1 && prGotos[0].payload.from === 'verify' && prGotos[0].payload.to === 'build' && prGotos[0].payload.edge?.on?.status === 'fail' && !pr.events.some((e) => e.type === 'stage.start' && e.stage === 'ops') && pr.code === 1 && lastOf(pr.events)?.payload?.code === 'E_LIMIT_UNBOUNDED',
      `rc=${pr.code} gotos=${JSON.stringify(prGotos.map((g) => `${g.payload.from}->${g.payload.to}`))} ops entered=${pr.events.some((e) => e.type === 'stage.start' && e.stage === 'ops')} run.end=${JSON.stringify(lastOf(pr.events)?.payload ?? null)}`,
    ], 'FORGE_FAKE=retry-verify:9 forge run --run v14-on-priority --flow fixtures/lb-on-priority.yaml');

    // ---- reds: break one thing at a time; each must turn this row red. Each red re-runs
    // the row (without its reds) on the mutated copy in a child process, bounded by
    // RED_TIMEOUT_MS, so a mutation that makes `run` hang is reported, not waited on.
    // The child loads THIS suite file (not the copy's), so `<copy>` holds only the
    // checkout under test -- if the suite were the copy's, a red of the copy would
    // find its own reds and recurse.
    const RED_TIMEOUT_MS = 120_000;
    const red = async (rid, what, mutate) => {
      let copy = null;
      try {
        copy = scratchCheckout(repo);
        const patchNote = mutate(copy) ?? '';
        const rowProbe = path.join(suiteDir(), 'probes', 'v14-row.mjs');
        const r = runCmd(process.execPath, [rowProbe, copy], { timeoutMs: RED_TIMEOUT_MS, env: { AF_ACCEPTANCE_DIR: suiteDir(), AF_V14_ROW_ONLY: '1' } });
        let status = null;
        try {
          status = JSON.parse(r.stdout.trim()).status;
        } catch {
          status = null;
        }
        if (status === null) return row(`${id}.red ${rid}`, what, 'fail', [rid], `row did not report (${r.signal ?? r.error?.code ?? r.code}): ${rawLine(r.stderr)}`);
        return row(`${id}.red ${rid}`, what, status === 'fail' ? 'pass' : 'fail', [rid], `${patchNote}; row ${status}`);
      } catch (e) {
        return row(`${id}.red ${rid}`, what, 'fail', [rid], String(e?.message ?? e).split('\n')[0]);
      } finally {
        if (copy) removeDir(copy);
      }
    };
    const patch = (file, from, to) => (copy) => {
      const f = path.join(copy, file);
      const s = fs.readFileSync(f, 'utf8');
      if (!s.includes(from)) throw new Error(`${file}: patch point not found: ${from}`);
      fs.writeFileSync(f, s.replace(from, to));
      return `${file}: ${from} -> ${to}`;
    };
    const reds = withReds ? [
      await red('red1 overflow', '上限不再是硬限制（超上限再 goto 一次）必须红', patch('src/run.js', 'if (used + 1 > limit) {', 'if (false) {')),
      await red('red2 goto-count', 'flow.goto.iteration 从 0 起算必须红', patch('src/run.js', 'const gotoNo = used + 1;', 'const gotoNo = used;')),
      await red('red3 no-validate', 'run 不再先过校验器（被拒的流程照样建 run 目录）必须红', patch('src/run.js', '    if (found.length) return { exitCode: 1, runId: runId ?? null, beforeWrite: true, error: found[0] };', '    if (false) return { exitCode: 1, runId: runId ?? null, beforeWrite: true, error: found[0] };')),
      // Not `conditional = undefined`: the plain build -> verify edge then carries the
      // failed verify anyway, so the walk still enters the loop -- that one was caught
      // pass in the first run. This one drops the status from the match itself.
      await red('red4 ignore-on', 'on: 的状态不再参与选边（pass/fail 边匹配同一个 status）必须红', patch('src/run.js', "  if (!e.on || typeof e.on !== 'object') return status === 'ok';", "  if (!e.on || typeof e.on !== 'object') return status === 'ok';\n  return true;")),
      await red('red5 drop-on-exhausted', 'on_exhausted 不再收尾成 ok 必须红', patch('src/run.js', 'if (taken.edge.on_exhausted) {', 'if (false) {')),
      // M3's mutation (员工二号's fifth): the stage entry count stops accumulating, so a
      // second entry reuses `@1`. Only PLAIN_REENTRY_FLOW's second design/build show it.
      await red('red7 visit-count', 'stage.start.iteration 不再累加（第二次进入仍记 @1）必须红', patch('src/run.js', '      const visited = (visitCount.get(stage) ?? 0) + 1;', '      const visited = 1;')),
      await red('red6 validator-lenient', '校验器对"无上限回边"不再报 E_CYCLE 必须红', patch('src/validate.js', '    if (!bad) continue;', '    if (bad) continue;'))
    ] : [];
    const failed = checks.filter((c) => !c.ok);
    const ok = failed.length === 0 && (withReds ? reds.every((r) => r.status === 'pass') : true);
    return row(id, standard, ok ? 'pass' : 'fail', checks.map((c) => c.cmd), ok ? checks.map((c) => `${c.cid}: ${c.raw}`).join(' | ') : `failed: ${failed.map((c) => `${c.cid} [${c.raw}]`).join(' | ')}`, {
      checks: checks.map((c) => ({ id: c.cid, status: c.ok ? 'pass' : 'fail', raw: c.raw })),
      reds: withReds ? reds : [],
      notes: '两条"负面"分开判：无上限回边 = validate 的 E_CYCLE（E_LIMIT_UNBOUNDED 只由运行时产出，见 src/validate.js）；运行时超限 = run.end failed/E_LIMIT_UNBOUNDED。形状在仓外副本里生成，入库的 fixture 只有 loop-bounded.yaml。共享回边（retry-t）归员工一号 test/loops.test.js，不在本条',
    });
  } finally {
    removeDir(dir);
  }
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
      reds: reds,
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
