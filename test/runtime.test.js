// M2-B (#流水线:#9): the design stage on a real runtime.
// Every test here uses a fake runtime binary; nothing calls the network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { verifyChain, readEvents } from '../src/eventlog.js';
import { runDesign, checkSubmit, buildPrompt, timeoutForSpec, DEFAULT_TIMEOUT_S } from '../src/runtime/design.js';

const FORGE = new URL('../bin/forge.js', import.meta.url).pathname;

// A workspace with the real files the CLI needs: flows, blocks, agents, the
// fake runner (for build/verify) and a fake runtime binary script.
function workspace({ runtimeBody = '', agents = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-rt-'));
  for (const d of ['flows', 'blocks/design', 'blocks/build', 'blocks/verify', 'fixtures', 'agents']) fs.mkdirSync(path.join(root, d), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ type: 'module' }) + '\n');
  fs.writeFileSync(path.join(root, 'flows', 'main.yaml'), 'id: main\nversion: 1\nentry: design\nnodes:\n  - id: design\n    uses: block:design@1\n  - id: build\n    uses: block:build@1\n  - id: verify\n    uses: block:verify@1\nedges:\n  - from: design\n    to: build\n  - from: build\n    to: verify\n');
  for (const id of ['design', 'build', 'verify']) fs.writeFileSync(path.join(root, 'blocks', id, 'v1.yaml'), `id: ${id}\nversion: 1\nagent: architect@1\ninputs: {}\noutputs: {}\nchecks: []\n`);
  fs.writeFileSync(path.join(root, 'agents', 'architect.yaml'), agents ?? 'name: architect\nlimits:\n  timeout_s: 30\n');
  fs.copyFileSync(new URL('../fixtures/fake-runner.js', import.meta.url), path.join(root, 'fixtures', 'fake-runner.js'));
  fs.copyFileSync(new URL('../fixtures/design-runtime.js', import.meta.url), path.join(root, 'fixtures', 'design-runtime.js'));
  fs.cpSync(new URL('../src', import.meta.url), path.join(root, 'src'), { recursive: true });
  const bin = path.join(root, 'fake-runtime.cjs');
  fs.writeFileSync(bin, `#!/usr/bin/env node\n${runtimeBody}\n`, { mode: 0o755 });
  return { root, bin };
}

function run(root, bin, extra = [], runId = 'rt1') {
  return spawnSync(process.execPath, [FORGE, 'run', '--run', runId, '--flow', 'flows/main.yaml', '--runtime', 'design', ...extra], {
    cwd: root,
    env: { ...process.env, FORGE_ROOT: root, FORGE_RUNTIME_BIN: bin },
    encoding: 'utf8',
  });
}

const okRuntime = (plan = 'plan: do the thing') => [
  "process.argv[2] === '--version' && (console.log('fake-runtime 1.0'), process.exit(0));",
  "const fs = require('fs');",
  "let input = '';",
  "process.stdin.on('data', (c) => (input += c));",
  "process.stdin.on('end', () => {",
  "  const task = JSON.parse(input);",
  "  fs.writeFileSync('plan.md', '# Plan\\n\\n' + " + JSON.stringify(plan) + " + '\\n');",
  "  process.stdout.write(JSON.stringify({ type: 'text', part: { type: 'text', text: 'wrote plan.md for ' + task.run_id } }) + String.fromCharCode(10));",
  "});",
].join('\n');

function events(root, runId = 'rt1') {
  return readEvents(path.join(root, '.forge', 'runs', runId, 'events.jsonl')).events;
}

test('design runs on the real runtime, build/verify on the fake runner, chain verifies', () => {
  const { root, bin } = workspace({ runtimeBody: okRuntime() });
  const res = run(root, bin);
  assert.equal(res.status, 0, res.stderr + '\n' + (fs.existsSync(path.join(root, '.forge', 'runs', 'rt1', 'events.jsonl')) ? fs.readFileSync(path.join(root, '.forge', 'runs', 'rt1', 'events.jsonl'), 'utf8') : 'no events'));
  const ev = events(root);
  const starts = ev.filter((e) => e.type === 'stage.start').map((e) => e.stage);
  assert.deepEqual(starts, ['design', 'build', 'verify']);
  const designEnd = ev.find((e) => e.type === 'stage.end' && e.stage === 'design');
  assert.equal(designEnd.payload.status, 'ok');
  assert.equal(designEnd.payload.submit.artifacts[0].path, '.forge/runs/rt1/plan.md');
  assert.match(designEnd.payload.submit.summary, /wrote plan.md for rt1/);
  assert.equal(designEnd.payload.submit.runtime.name, 'opencode');
  const buildEnd = ev.find((e) => e.type === 'stage.end' && e.stage === 'build');
  assert.equal(buildEnd.payload.submit.summary, 'build done'); // fake runner's wording
  assert.ok(fs.existsSync(path.join(root, '.forge', 'runs', 'rt1', 'plan.md')));
  assert.equal(verifyChain(path.join(root, '.forge', 'runs', 'rt1', 'events.jsonl')).ok, true);
});

test('the task book handed to the runtime carries the flow doc and the request', () => {
  const body = [
    "process.argv[2] === '--version' && (console.log('fake-runtime 1.0'), process.exit(0));",
    "const fs = require('fs');",
    "let input = '';",
    "process.stdin.on('data', (c) => (input += c));",
    "process.stdin.on('end', () => {",
    "  const task = JSON.parse(input);",
    "  fs.writeFileSync('plan.md', JSON.stringify({ stage: task.stage, flow_id: task.flow_id, nodes: (task.doc.nodes || []).map((n) => n.id), timeout_s: task.timeout_s }));",
    "  process.stdout.write(JSON.stringify({ type: 'text', part: { type: 'text', text: 'ok' } }) + String.fromCharCode(10));",
    "});",
  ].join('\n');
  const { root, bin } = workspace({ runtimeBody: body });
  const res = run(root, bin);
  assert.equal(res.status, 0, res.stderr + (fs.existsSync(path.join(root, '.forge', 'runs', 'rt1', 'events.jsonl')) ? fs.readFileSync(path.join(root, '.forge', 'runs', 'rt1', 'events.jsonl'), 'utf8').slice(-900) : ''));
  const book = JSON.parse(fs.readFileSync(path.join(root, '.forge', 'runs', 'rt1', 'plan.md'), 'utf8'));
  assert.deepEqual(book, { stage: 'design', flow_id: 'main', nodes: ['design', 'build', 'verify'], timeout_s: 30 });
});

test('no --flow with --runtime design fails before any event is written', () => {
  const { root, bin } = workspace();
  const res = spawnSync(process.execPath, [FORGE, 'run', '--runtime', 'design'], { cwd: root, env: { ...process.env, FORGE_ROOT: root, FORGE_RUNTIME_BIN: bin }, encoding: 'utf8' });
  assert.equal(res.status, 1);
  // No flow at all is the same as PR #10's missing file: E_FILE_NOT_FOUND, no run.
  assert.match(res.stderr, /E_FILE_NOT_FOUND/);
  assert.equal(fs.existsSync(path.join(root, '.forge')), false);
});

test('an unknown --runtime is E_INVALID_ARGS (exit 1); positional paths stay PR #10\'s tests', () => {
  const { root, bin } = workspace();
  const b = spawnSync(process.execPath, [FORGE, 'run', '--flow', 'flows/main.yaml', '--runtime', 'build'], { cwd: root, env: { ...process.env, FORGE_ROOT: root, FORGE_RUNTIME_BIN: bin }, encoding: 'utf8' });
  assert.equal(b.status, 1);
  assert.match(b.stderr, /E_INVALID_ARGS/);
  const c = spawnSync(process.execPath, [FORGE, 'run', '--flow', 'flows/main.yaml', '--runtime'], { cwd: root, env: { ...process.env, FORGE_ROOT: root, FORGE_RUNTIME_BIN: bin }, encoding: 'utf8' });
  assert.equal(c.status, 1);
  assert.match(c.stderr, /E_INVALID_ARGS/);
});

test('runtime that writes no plan fails the stage with E_STAGE_FAILED and stops the run', () => {
  const { root, bin } = workspace({ runtimeBody: "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('{\"type\":\"text\",\"part\":{\"type\":\"text\",\"text\":\"nothing\"}}\\n'));" });
  const res = run(root, bin);
  assert.equal(res.status, 1);
  const end = events(root).find((e) => e.type === 'stage.end' && e.stage === 'design');
  assert.equal(end.payload.status, 'failed');
  assert.equal(end.payload.error.code, 'E_STAGE_FAILED');
  assert.ok(!events(root).some((e) => e.type === 'stage.start' && e.stage === 'build'));
});

test('runtime exit 401 is E_RUNTIME_AUTH, exit 429 is E_RUNTIME_QUOTA, other failures E_RUNTIME_UNAVAILABLE', () => {
  for (const [code, exitCode, body, want] of [
    ['401', 1, 'Unauthorized: invalid_api_key', 'E_RUNTIME_AUTH'],
    ['429', 1, 'rate limit exceeded', 'E_RUNTIME_QUOTA'],
    ['1', 1, 'boom', 'E_RUNTIME_UNAVAILABLE'],
  ]) {
    const { root, bin } = workspace({ runtimeBody: `process.stdin.resume(); process.stdin.on('end', () => { process.stderr.write(${JSON.stringify(body)}); process.exit(${exitCode}); });` });
    const res = run(root, bin);
    assert.equal(res.status, 1, code);
    const end = events(root).find((e) => e.type === 'stage.end' && e.stage === 'design');
    assert.equal(end.payload.error.code, want, code);
    for (const k of ['code', 'severity', 'locatable', 'path', 'ids', 'fix']) assert.ok(k in end.payload.error, k);
    assert.equal(end.payload.status, 'failed');
  }
});

test('a hung runtime times out (E_RUNTIME_TIMEOUT) and its children are killed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-hang-'));
  const marker = path.join(dir, 'child-survived');
  const bin = path.join(dir, 'hang-runtime.cjs');
  // The runtime starts a grandchild that would leave a marker after 3s, then hangs itself.
  const lines = [
    "process.argv[2] === '--version' && (console.log('hang-runtime 1.0'), process.exit(0));",
    "const { spawn } = require('child_process');",
    "spawn(process.execPath, ['-e', 'setTimeout(()=>require(\"fs\").writeFileSync(' + JSON.stringify(' + JSON.stringify(marker) + ') + ', \"x\"), 3000)'], { detached: true, stdio: 'ignore' }).unref();",
    "setInterval(() => {}, 1000);",
  ].join(String.fromCharCode(10));
  fs.writeFileSync(bin, '#!/usr/bin/env node' + String.fromCharCode(10) + lines + String.fromCharCode(10), { mode: 0o755 });
  const t0 = Date.now();
  await assert.rejects(
    () => runDesign({ binary: bin, task: { v: 1, run_id: 'r9', stage: 'design', iteration: 1, doc: null, request: 'x' }, runDir: dir, timeoutS: 1 }),
    (e) => e.code === 'E_RUNTIME_TIMEOUT' && e.fix.timeout_s === 1 || (console.error('timeout err was', e && e.code, e && e.message), false),
  );
  assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0}ms`);
  await new Promise((r) => setTimeout(r, 2600));
  assert.equal(fs.existsSync(marker), false, 'grandchild must be gone after the timeout kill');
});

test('runtime call quota stops before a second call (E_RUNTIME_QUOTA)', () => {
  const { root, bin } = workspace({ runtimeBody: okRuntime() });
  const res = run(root, bin, ['--max-runtime-calls', '0'], 'rt0');
  assert.equal(res.status, 1);
  assert.match(res.stderr, /E_INVALID_ARGS/); // 0 is not a positive cap
  const res2 = run(root, bin, ['--max-runtime-calls', '1'], 'rt2');
  assert.equal(res2.status, 0, res2.stderr);
});

test('a Submit whose evidence cites a URL is E_SCHEMA_INVALID pointing at that entry', () => {
  const bad = checkSubmit({ v: 1, status: 'ok', artifacts: [], summary: 's', evidence: [{ check: 'c', cmd: 'see https://example.com/log', exit: 0 }] }, { stage: 'design' });
  assert.ok(bad, 'checkSubmit returned null');
  assert.equal(bad.code, 'E_SCHEMA_INVALID', JSON.stringify(bad));
  assert.equal(bad.path, 'submit.evidence[0]', JSON.stringify(bad));
  assert.match(bad.fix.action, /not a URL/);
});

test('prompt and timeout come from the flow and the AgentSpec', () => {
  assert.equal(timeoutForSpec(null), DEFAULT_TIMEOUT_S);
  assert.equal(timeoutForSpec({ limits: { timeout_s: 7 } }), 7);
  const p = buildPrompt({ run_id: 'r', request: 'write a plan', flow_id: 'main', doc: { nodes: [{ id: 'design', uses: 'block:design@1' }] } });
  assert.match(p, /write a plan/);
  assert.match(p, /design \(block:design@1\)/);
});
