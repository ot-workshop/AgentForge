import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { verifyChain } from '../src/eventlog.js';
import { acquireRunLock } from '../src/lock.js';

const FORGE = new URL('../bin/forge.js', import.meta.url).pathname;
const OK = "process.stdout.write(JSON.stringify({v:1,status:'ok',artifacts:[],summary:'s',evidence:[{check:'c',cmd:'x',exit:0}]})+'\\n');";

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-append-'));
  fs.mkdirSync(path.join(root, 'fixtures'), { recursive: true });
  fs.writeFileSync(path.join(root, 'fixtures', 'fake-runner.js'), OK);
  const r = spawnSync(process.execPath, [FORGE, 'run', '--run', 'r1'], { cwd: root, env: { ...process.env, FORGE_ROOT: root, FORGE_FAKE: '1' }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return root;
}

test('A5.3 unknown event types survive append + replay unchanged', () => {
  const root = workspace();
  const frag = path.join(root, 'frag.jsonl');
  fs.writeFileSync(frag, JSON.stringify({ stage: 'build', iteration: 1, actor: { kind: 'agent', name: 'probe' }, type: 'custom.probe', ext: { note: 'x' }, payload: { hello: 1 } }) + '\n');
  const r = spawnSync(process.execPath, [FORGE, 'append', '--run', 'r1', '--event-file', frag], { cwd: root, env: { ...process.env, FORGE_ROOT: root }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const chain = verifyChain(path.join(root, '.forge', 'runs', 'r1', 'events.jsonl'));
  assert.equal(chain.ok, true);
  const ev = chain.events.find((e) => e.type === 'custom.probe');
  assert.deepEqual(ev.ext, { note: 'x' });
  const rep = spawnSync(process.execPath, [FORGE, 'replay', '--run', 'r1'], { cwd: root, env: { ...process.env, FORGE_ROOT: root }, encoding: 'utf8' });
  assert.ok(rep.stdout.split('\n').some((l) => l && JSON.parse(l).type === 'custom.probe'));
});

test('A4.6a append is refused with E_EVENTS_LOCKED while the run lock is held', () => {
  const root = workspace();
  const runDir = path.join(root, '.forge', 'runs', 'r1');
  const frag = path.join(root, 'frag.jsonl');
  fs.writeFileSync(frag, JSON.stringify({ stage: 'build', actor: { kind: 'agent', name: 'p' }, type: 'log', payload: {} }) + '\n');
  const before = fs.readFileSync(path.join(runDir, 'events.jsonl'));
  const lock = acquireRunLock(runDir);
  try {
    const r = spawnSync(process.execPath, [FORGE, 'append', '--run', 'r1', '--event-file', frag, '--json'], { cwd: root, env: { ...process.env, FORGE_ROOT: root }, encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /E_EVENTS_LOCKED/);
    assert.deepEqual(fs.readFileSync(path.join(runDir, 'events.jsonl')), before);
  } finally {
    lock.release();
  }
});

test('append refuses an empty fragment with E_INVALID_ARGS (never rc=0 appended:[])', () => {
  const root = workspace();
  const frag = path.join(root, 'empty.jsonl');
  fs.writeFileSync(frag, '\n\n');
  const r = spawnSync(process.execPath, [FORGE, 'append', '--run', 'r1', '--event-file', frag, '--json'], { cwd: root, env: { ...process.env, FORGE_ROOT: root }, encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /E_INVALID_ARGS/);
});
