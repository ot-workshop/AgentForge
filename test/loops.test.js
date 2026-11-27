// #流水线:#10: the orchestrator walks a flow's edges — branches on `on`, a
// bounded back edge as `flow.goto`, one counter per `loopId`, and one place a
// run ends (`run.end`, 69c94449). The fake runner drives the loop through the
// orchestrator's own iteration count (`FORGE_FAKE=retry-<stage>:<n>`).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { readEvents, verifyChain } from '../src/eventlog.js';

const FORGE = new URL('../bin/forge.js', import.meta.url).pathname;
const SRC = new URL('../src/', import.meta.url).pathname;

// A minimal project: the real `blocks/` and `agents/` of this repository, the
// real fake runner, and one flow written for the test.
function workspace(flowYaml) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-loop-'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ type: 'module' }) + '\n');
  fs.cpSync(new URL('../src/', import.meta.url), path.join(root, 'src'), { recursive: true });
  fs.cpSync(new URL('../blocks/', import.meta.url), path.join(root, 'blocks'), { recursive: true });
  fs.cpSync(new URL('../agents/', import.meta.url), path.join(root, 'agents'), { recursive: true });
  fs.mkdirSync(path.join(root, 'fixtures'), { recursive: true });
  fs.copyFileSync(new URL('../fixtures/fake-runner.js', import.meta.url), path.join(root, 'fixtures', 'fake-runner.js'));
  fs.mkdirSync(path.join(root, 'flows'), { recursive: true });
  fs.writeFileSync(path.join(root, 'flows', 'loop.yaml'), flowYaml);
  return root;
}

function run(root, fake, runId = 'l1') {
  const res = spawnSync(process.execPath, [FORGE, 'run', '--run', runId, '--flow', 'flows/loop.yaml'], {
    cwd: root,
    env: { ...process.env, FORGE_ROOT: root, FORGE_FAKE: fake },
    encoding: 'utf8',
  });
  const file = path.join(root, '.forge', 'runs', runId, 'events.jsonl');
  const events = fs.existsSync(file) ? readEvents(file).events : [];
  return { res, events };
}

const BUGFIX = `id: bugfix
version: 1
entry: design
nodes:
  - id: design
    uses: block:design@1
    with:
      request: "{{input.request}}"
  - id: build
    uses: block:build@1
  - id: verify
    uses: block:verify@1
  - id: ops
    uses: block:ops@1
edges:
  - from: design
    to: build
  - from: build
    to: verify
  - id: verify-to-build
    from: verify
    to: build
    on:
      from: check.result
      status: fail
    max_iterations: 2
    on_exhausted: human_gate:ops-lead
  - id: verify-to-ops
    from: verify
    to: ops
    on:
      from: check.result
      status: pass
`;

// Two loops sharing one bounded back edge (`t->s`): the validator lets it
// through (第 15 条) and the runtime stops it by that one counter.
const SHARED = `id: shared
version: 1
entry: s
nodes:
  - id: s
    uses: block:design@1
    with:
      request: "{{input.request}}"
  - id: a
    uses: block:build@1
  - id: b
    uses: block:build@1
  - id: t
    uses: block:verify@1
  - id: e
    uses: block:ops@1
edges:
  - from: s
    to: a
  - from: s
    to: b
  - from: a
    to: t
  - from: b
    to: t
  - id: t-to-s
    from: t
    to: s
    on:
      from: check.result
      status: fail
    max_iterations: 2
  - id: t-to-e
    from: t
    to: e
    on:
      from: check.result
      status: pass
`;

const kinds = (events) => events.map((e) => (e.stage ? `${e.type}:${e.stage}@${e.iteration}` : e.type));

test('#10: bugfix runs verify, build, verify, build, verify, build, verify — one goto per use of the bounded edge — then ops', () => {
  const root = workspace(BUGFIX);
  const { res, events } = run(root, 'retry-verify:2');
  assert.equal(res.status, 0, res.stderr);
  assert.equal(verifyChain(path.join(root, '.forge', 'runs', 'l1', 'events.jsonl')).ok, true);
  const gotos = events.filter((e) => e.type === 'flow.goto');
  assert.deepEqual(gotos.map((g) => g.payload.iteration), [1, 2]);
  for (const g of gotos) {
    assert.equal(g.payload.from, 'verify');
    assert.equal(g.payload.to, 'build');
    assert.equal(g.payload.loopId, 'verify-to-build');
    assert.equal(g.payload.edge.max_iterations, 2);
    assert.equal(g.payload.edge.id, 'verify-to-build');
    assert.ok(typeof g.payload.checkResultId === 'string' && g.payload.checkResultId.length > 0);
  }
  // stage.start.iteration is "which entry into this stage this is" (f902a034):
  // verify runs three times (the last turn after the second goto), and the run
  // ends after it instead of opening a fourth entry.
  const starts = events.filter((e) => e.type === 'stage.start').map((e) => `${e.stage}@${e.iteration}`);
  assert.deepEqual(starts, ['design@1', 'build@1', 'verify@1', 'build@2', 'verify@2', 'build@3', 'verify@3', 'ops@1']);
  assert.deepEqual(events.slice(-2).map((e) => e.type), ['stage.end', 'run.end']);
  assert.ok(events.every((e) => e.payload?.submit?.status !== 'failed' || e.stage === 'verify'));
  // verify passes on its second entry: the walk goes verify@1 fail → build@1 →
  // verify@2 pass — and the goto's iteration is the build stage.start's iteration.
  assert.ok(events.some((e) => e.stage === 'verify' && e.iteration === 2 && e.type === 'stage.start'));
  const end = events[events.length - 1];
  assert.equal(end.type, 'run.end');
  assert.deepEqual(end.payload, { status: 'ok' });
});

test('#10: bugfix with on_exhausted writes one loop-exhausted log, then run.end ok — no goto, no stage.start after the counter is spent', () => {
  const root = workspace(BUGFIX);
  const { res, events } = run(root, 'retry-verify:9');
  assert.equal(res.status, 0, res.stderr);
  assert.equal(events.filter((e) => e.type === 'flow.goto').length, 2);
  const exhausted = events.filter((e) => e.type === 'log' && e.payload?.kind === 'loop-exhausted');
  assert.equal(exhausted.length, 1);
  assert.equal(exhausted[0].payload.loopId, 'verify-to-build');
  assert.equal(exhausted[0].payload.iterations, 2);
  assert.equal(exhausted[0].payload.onExhausted, 'human_gate:ops-lead');
  const end = events[events.length - 1];
  assert.equal(end.type, 'run.end');
  assert.equal(end.payload.status, 'ok');
  // Nothing runs after verify@3: the events end at that stage.end, then log, then run.end.
  const after = kinds(events).slice(kinds(events).indexOf('stage.end:verify@3'));
  assert.deepEqual(after, ['stage.end:verify@3', 'log', 'run.end']);
  assert.ok(!events.some((e) => e.stage === 'build' && e.iteration === 4));
  assert.ok(!events.some((e) => e.stage === 'verify' && e.iteration === 4));
});

test('#10: shared back edge ends in run.end failed E_LIMIT_UNBOUNDED (rc=1) once its single counter is spent', () => {
  const root = workspace(SHARED);
  // retry-t:3: the third entry into `t` still fails, so `t->s` is picked a
  // third time and the spent counter is the thing that ends the run. With
  // retry-t:2 the third `t` passes and the walk leaves through `t->e`.
  const { res, events } = run(root, 'retry-t:3');
  assert.equal(res.status, 1, res.stderr);
  const gotos = events.filter((e) => e.type === 'flow.goto');
  assert.deepEqual(gotos.map((g) => g.payload.iteration), [1, 2]);
  assert.ok(gotos.every((g) => g.payload.loopId === 't-to-s'));
  const end = events[events.length - 1];
  assert.equal(end.type, 'run.end');
  assert.equal(end.stage, null);
  assert.equal(end.payload.status, 'failed');
  assert.equal(end.payload.code, 'E_LIMIT_UNBOUNDED');
  assert.equal(end.payload.loopId, 't-to-s');
  assert.deepEqual([end.payload.from, end.payload.to, end.payload.iterations], ['t', 's', 2]);
  assert.equal(end.payload.fix.action, 'raise-limit-or-fix-loop');
  // No entry after the third t, and no stage.end written for a stage that
  // never started: s@1 a@1 t@1 → s@2 a@2 t@2 → s@3 a@3 t@3, then run.end.
  assert.ok(!events.some((e) => e.stage === 's' && e.iteration === 4));
  assert.ok(!events.some((e) => e.stage === 't' && e.iteration === 4));
  const starts = events.filter((e) => e.type === 'stage.start').map((e) => `${e.stage}@${e.iteration}`);
  assert.deepEqual(starts, ['s@1', 'a@1', 't@1', 's@2', 'a@2', 't@2', 's@3', 'a@3', 't@3']);
});

test('#10: shared back edge with a passing third turn leaves through t->e (no third goto)', () => {
  const root = workspace(SHARED);
  const { res, events } = run(root, 'retry-t:2', 'shared-ok');
  assert.equal(res.status, 0, res.stderr);
  assert.equal(events.filter((e) => e.type === 'flow.goto').length, 2);
  const starts = events.filter((e) => e.type === 'stage.start').map((e) => `${e.stage}@${e.iteration}`);
  assert.deepEqual(starts, ['s@1', 'a@1', 't@1', 's@2', 'a@2', 't@2', 's@3', 'a@3', 't@3', 'e@1']);
  assert.deepEqual(events[events.length - 1].payload, { status: 'ok' });
});

test('#10: a flow the validator refuses never starts a run (E_CYCLE, no run dir)', () => {
  const root = workspace(`id: cyc
version: 1
entry: a
nodes:
  - id: a
    uses: block:ops@1
  - id: b
    uses: block:ops@1
  - id: e
    uses: block:ops@1
edges:
  - from: a
    to: b
  - from: b
    to: a
  - from: b
    to: e
`);
  const { res, events } = run(root, '1', 'cyc');
  assert.equal(res.status, 1, res.stderr);
  assert.match(res.stderr, /E_CYCLE/);
  assert.equal(events.length, 0);
  assert.ok(!fs.existsSync(path.join(root, '.forge', 'runs', 'cyc')));
});
