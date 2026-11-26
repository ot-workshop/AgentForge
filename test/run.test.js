import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { verifyChain, readEvents } from '../src/eventlog.js';
import { acquireRunLock } from '../src/lock.js';

const FORGE = new URL('../bin/forge.js', import.meta.url).pathname;
const REAL_RUNNER = fs.readFileSync(new URL('../fixtures/fake-runner.js', import.meta.url), 'utf8');

function workspace(runnerBody) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-run-'));
  fs.mkdirSync(path.join(root, 'fixtures'), { recursive: true });
  fs.writeFileSync(path.join(root, 'fixtures', 'fake-runner.js'), runnerBody);
  return root;
}

const OK_RUNNER = `
const stage = process.argv[2];
process.stdout.write(JSON.stringify({ v: 1, status: 'ok', artifacts: [], summary: stage, evidence: [{ check: 'stub', cmd: 'noop', exit: 0 }] }) + '\\n');
`;

function run(root, fake, runId = 'r1') {
  return spawnSync(process.execPath, [FORGE, 'run', '--run', runId], {
    cwd: root,
    env: { ...process.env, FORGE_FAKE: fake, FORGE_ROOT: root },
    encoding: 'utf8',
  });
}

test('linear flow runs design→build→verify and the chain verifies', () => {
  const root = workspace(OK_RUNNER);
  const res = run(root, '1');
  assert.equal(res.status, 0, res.stderr);
  const chain = verifyChain(path.join(root, '.forge', 'runs', 'r1', 'events.jsonl'));
  assert.equal(chain.ok, true);
  const stages = chain.events.filter((e) => e.type === 'stage.start').map((e) => e.stage);
  assert.deepEqual(stages, ['design', 'build', 'verify']);
  assert.ok(fs.existsSync(path.join(root, '.forge', 'runs', 'r1', 'context', 'build@1.json')));
  assert.ok(chain.events.every((e) => !e.type.includes('ref.drift')));
});

test('A4.3 bad submit (no status) fails the stage with a structured error', () => {
  const root = workspace("process.stdout.write('{\"v\":1,\"status\":\"done\"}\\n');");
  // bad-submit in the fixture enum: a Submit that does not satisfy the schema.
  const res = run(root, 'bad-submit');
  assert.equal(res.status, 1);
  const chain = verifyChain(path.join(root, '.forge', 'runs', 'r1', 'events.jsonl'));
  const end = chain.events.find((e) => e.type === 'stage.end');
  assert.ok(end);
  const err = end.payload.error;
  for (const k of ['code', 'severity', 'locatable', 'path', 'ids', 'fix']) assert.ok(k in err, k);
});

test('A4.1 runner emitting an EVENT line is rejected as E_ILLEGAL_STAGE_WRITE', () => {
  const root = workspace("process.stdout.write('EVENT {\"v\":1,\"type\":\"stage.end\"}\\n');");
  const res = run(root, 'forge-stage-end');
  assert.equal(res.status, 1);
  const { events } = readEvents(path.join(root, '.forge', 'runs', 'r1', 'events.jsonl'));
  const err = events.find((e) => e.payload?.error)?.payload.error;
  assert.equal(err.code, 'E_ILLEGAL_STAGE_WRITE');
  assert.equal(err.locatable, false);
});

test('A5.12 run refuses to start when another writer holds the lock', () => {
  const root = workspace(OK_RUNNER);
  const runDir = path.join(root, '.forge', 'runs', 'r1');
  fs.mkdirSync(runDir, { recursive: true });
  const lock = acquireRunLock(runDir);
  try {
    const res = run(root, '1');
    assert.equal(res.status, 1, res.stderr);
    assert.match(res.stderr, /E_EVENTS_LOCKED/);
    assert.ok(!fs.existsSync(path.join(runDir, 'events.jsonl')), 'no event file may be created');
  } finally {
    lock.release();
  }
});

test('A5.8 runner process crash → exit 2, no new error event', () => {
  const root = workspace("process.stderr.write('fake-runner: simulated crash\\n'); process.exit(2);");
  const res = run(root, 'crash');
  assert.equal(res.status, 2);
  assert.match(res.stderr, /simulated crash/);
  const { events } = readEvents(path.join(root, '.forge', 'runs', 'r1', 'events.jsonl'));
  assert.ok(!events.some((e) => e.payload?.error));
});

test('A5.8 crash mid-write: run exits 2, no error event, half line repaired with a warn', () => {
  const root = workspace(OK_RUNNER);
  fs.writeFileSync(path.join(root, 'fixtures', 'fake-runner.js'), REAL_RUNNER);
  assert.equal(run(root, '1').status, 0);
  const res = run(root, 'crash-midwrite');
  assert.equal(res.status, 2, res.stderr + res.stdout);
  const file = path.join(root, '.forge', 'runs', 'r1', 'events.jsonl');
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(raw.endsWith('\n'), 'a shipped run never ends with a half line');
  const chain = verifyChain(file);
  assert.equal(chain.ok, true);
  assert.equal(chain.trailingPartial, false);
  assert.ok(!chain.events.some((e) => e.payload?.error));
  assert.ok(chain.events.some((e) => e.payload?.severity === 'warn' && /truncated/.test(e.payload.message)));
});



test('A5.9 a run started on an existing run truncates its half line before appending and records a warn', () => {
  const root = workspace(OK_RUNNER);
  fs.writeFileSync(path.join(root, 'fixtures', 'fake-runner.js'), REAL_RUNNER);
  const file = path.join(root, '.forge', 'runs', 'r2', 'events.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{"seq":1,"type":"stage.st');
  const res = run(root, '1', 'r2');
  assert.equal(res.status, 0, res.stderr);
  const { events, trailingPartial } = readEvents(file);
  assert.equal(trailingPartial, false);
  assert.ok(events.some((e) => e.payload?.severity === 'warn' && /truncated/.test(e.payload.message)));
  assert.equal(verifyChain(file).ok, true);
});

test('A4.4 touch-checks: a runner that modifies the checker file fails the stage', () => {
  const root = workspace(OK_RUNNER);
  fs.writeFileSync(path.join(root, 'fixtures', 'fake-runner.js'), REAL_RUNNER);
  const res = run(root, 'touch-checks');
  assert.notEqual(res.status, 0);
  const chain = verifyChain(path.join(root, '.forge', 'runs', 'r1', 'events.jsonl'));
  const err = chain.events.find((e) => e.payload?.error)?.payload.error;
  assert.equal(err.code, 'E_PERMISSION_GAP');
  assert.match(err.path, /checks\.lock/);
});

test('A7.2 a new run id also refuses when a block changed since the last manifest', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-drift-'));
  fs.cpSync(new URL('../flows', import.meta.url), path.join(root, 'flows'), { recursive: true });
  fs.cpSync(new URL('../blocks', import.meta.url), path.join(root, 'blocks'), { recursive: true });
  fs.cpSync(new URL('../checks', import.meta.url), path.join(root, 'checks'), { recursive: true });
  fs.mkdirSync(path.join(root, 'fixtures'), { recursive: true });
  fs.writeFileSync(path.join(root, 'fixtures', 'fake-runner.js'), REAL_RUNNER);
  const flow = path.join(root, 'flows', 'main.yaml');
  const runNew = () =>
    spawnSync(process.execPath, [FORGE, 'run', '--flow', flow], { cwd: root, env: { ...process.env, FORGE_ROOT: root, FORGE_FAKE: '1' }, encoding: 'utf8' });
  const first = runNew();
  assert.equal(first.status, 0, first.stderr);
  const runId = spawnSync('ls', [path.join(root, '.forge', 'runs')], { encoding: 'utf8' }).stdout.trim().split('\n')[0];
  const mf = path.join(root, '.forge', 'runs', runId, 'manifest.json');
  assert.ok(fs.existsSync(mf), 'manifest must be written');
  assert.ok(JSON.parse(fs.readFileSync(mf, 'utf8')).blocks.build, 'manifest must record the build block');
  fs.appendFileSync(path.join(root, 'blocks', 'build', 'v1.yaml'), '# edited\n');
  const refused = runNew();
  assert.equal(refused.status, 1, refused.stderr);
  assert.match(refused.stderr, /E_BLOCK_CONTENT_DRIFT/);
});
