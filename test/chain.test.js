import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventWriter, verifyChain } from '../src/eventlog.js';

function makeRun(n = 6) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-'));
  const w = new EventWriter(dir, []).open();
  for (let i = 1; i <= n; i++) w.append({ run_id: 'r1', stage: 'build', iteration: 1, actor: { kind: 'orchestrator', name: 't' }, type: i === 1 ? 'stage.start' : 'stage.end', payload: { i } });
  w.close();
  return { dir, file: path.join(dir, 'events.jsonl') };
}

test('A5.4 seq starts at 1 and is contiguous', () => {
  const { file } = makeRun();
  const res = verifyChain(file);
  assert.equal(res.ok, true);
  assert.equal(res.lastSeq, 6);
});

test('A5.2 tampering a payload is detected at that seq', () => {
  const { file } = makeRun();
  const L = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  L[4].payload = { tampered: true };
  fs.writeFileSync(file, L.map((x) => JSON.stringify(x)).join('\n') + '\n');
  const res = verifyChain(file);
  assert.equal(res.ok, false);
  assert.match(JSON.stringify(res.errors[0].ids), /seq:5/);
});

test('A5.11 trailing half line is ignored, chain still verifies', () => {
  const { file } = makeRun();
  fs.appendFileSync(file, '{"seq":7,"type":"stage.st');
  const res = verifyChain(file);
  assert.equal(res.ok, true);
  assert.equal(res.trailingPartial, true);
});

test('A5.9 complete line with wrong hash is reported, not truncated', () => {
  const { file } = makeRun();
  const L = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  L[2].hash = 'sha256:' + '0'.repeat(64);
  fs.writeFileSync(file, L.map((x) => JSON.stringify(x)).join('\n') + '\n');
  const before = fs.readFileSync(file);
  const res = verifyChain(file);
  assert.equal(res.ok, false);
  assert.deepEqual(fs.readFileSync(file), before);
});

test('A5.5 ref.drift after the first stage.start is rejected', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-'));
  const w = new EventWriter(dir, []).open();
  w.append({ run_id: 'r1', stage: null, actor: { kind: 'orchestrator', name: 't' }, type: 'run.start', payload: {} });
  w.append({ run_id: 'r1', stage: 'build', iteration: 1, actor: { kind: 'orchestrator', name: 't' }, type: 'stage.start', payload: {} });
  w.append({ run_id: 'r1', stage: null, actor: { kind: 'orchestrator', name: 't' }, type: 'ref.drift', payload: {} });
  w.close();
  const res = verifyChain(path.join(dir, 'events.jsonl'));
  assert.equal(res.ok, false);
  assert.equal(res.errors[0].code, 'E_REF_DRIFT_ORDER');
});
