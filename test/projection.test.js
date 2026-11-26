import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventWriter } from '../src/eventlog.js';
import { replayJsonl } from '../src/project.js';
import { verifyChain } from '../src/eventlog.js';

function makeRun(n = 10) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-'));
  const w = new EventWriter(dir, []).open();
  for (let i = 1; i <= n; i++) {
    w.append({ run_id: 'r1', stage: i % 2 ? 'build' : 'verify', iteration: 1, actor: { kind: 'orchestrator', name: 't' }, type: i % 2 ? 'stage.start' : 'stage.end', payload: { i } });
  }
  w.close();
  return { dir, file: path.join(dir, 'events.jsonl') };
}

test('A1.1 incremental(--since 0) equals full replay byte for byte', () => {
  const { file } = makeRun();
  const { events } = verifyChain(file);
  assert.equal(replayJsonl(events, 0), replayJsonl(events, 0));
  assert.ok(replayJsonl(events, 0).length > 0);
});

test('A1.2 incremental returns only seq > since, in order', () => {
  const { file } = makeRun();
  const { events } = verifyChain(file);
  const lines = replayJsonl(events, 7).trim().split('\n').map((l) => JSON.parse(l).seq);
  assert.deepEqual(lines, [8, 9, 10]);
});

test('A1.3 only one projection implementation', () => {
  const src = fs.readFileSync(new URL('../src/project.js', import.meta.url), 'utf8');
  assert.equal((src.match(/ev\.seq > since/g) || []).length, 1);
  const others = fs.readdirSync(new URL('../src/', import.meta.url)).filter((f) => f !== 'project.js');
  for (const f of others) {
    const text = fs
      .readFileSync(new URL('../src/' + f, import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/seq\s*>\s*(since|n)\b/.test(text), `${f} must not filter by seq`);
  }
});

test('A1.4/A1.5 cursor at end or beyond end yields empty output', () => {
  const { file } = makeRun();
  const { events } = verifyChain(file);
  assert.equal(replayJsonl(events, 10), '');
  assert.equal(replayJsonl(events, 999999), '');
});
