import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { backEdgesOfScc } from '../src/validate.js';
import { parseYaml } from '../src/yamlish.js';

const FORGE = new URL('../bin/forge.js', import.meta.url).pathname;
const ROOT = new URL('..', import.meta.url).pathname;

function validate(file) {
  return spawnSync(process.execPath, [FORGE, 'validate', path.join(ROOT, file), '--json'], { encoding: 'utf8' });
}

test('A3.1 the linear sample validates with no errors', () => {
  const r = validate('flows/main.yaml');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).errors, []);
});

test('A3.3 every fixture reports its expected code from expected-codes.tsv', () => {
  const tsv = fs
    .readFileSync(path.join(ROOT, 'fixtures/expected-codes.tsv'), 'utf8')
    .split('\n')
    .filter((l) => l.trim() && !l.startsWith('#'))
    .map((l) => l.split('\t'));
  assert.ok(tsv.length >= 5);
  for (const [name, code] of tsv) {
    const r = validate('fixtures/' + name);
    assert.equal(r.status, 1, name);
    const errs = JSON.parse(r.stdout).errors;
    assert.ok(errs.some((e) => e.code === code), `${name} expected ${code}, got ${errs.map((e) => e.code)}`);
  }
});

test('A3.2 errors are structured and locatable ids exist in the graph', () => {
  const r = validate('fixtures/cycle.yaml');
  const errs = JSON.parse(r.stdout).errors;
  for (const e of errs) {
    for (const k of ['code', 'severity', 'locatable', 'path', 'ids', 'fix']) assert.ok(k in e, k);
  }
  const cyc = errs.find((e) => e.code === 'E_CYCLE');
  assert.deepEqual(new Set(cyc.ids), new Set(['a', 'b']));
});

test('P0: each p0-unsupported fixture yields exactly one E_P0_UNSUPPORTED naming the field', () => {
  for (const [file, field] of [
    // Edge-level `on` is P0 since #流水线:#10 (p0-unsupported-on.yaml now validates
    // to E_UNBOUND_INPUT); node-level `loop_id` and `group` stay P0.5.
    ['p0-unsupported-max_iterations.yaml', 'max_iterations'],
    ['p0-unsupported-group.yaml', 'group'],
    ['p0-unsupported-loop_id.yaml', 'loop_id'],
  ]) {
    const r = validate('fixtures/' + file);
    assert.equal(r.status, 1);
    const errs = JSON.parse(r.stdout).errors;
    assert.equal(errs.length, 1, `${file} -> ${JSON.stringify(errs)}`);
    assert.equal(errs[0].code, 'E_P0_UNSUPPORTED');
    assert.ok(errs[0].path.includes(field), errs[0].path);
  }
});


test('#10: the back edge of a bounded loop is the edge that carries max_iterations (bugfix)', () => {
  const file = path.join(ROOT, 'flows/bugfix.yaml');
  const doc = parseYaml(fs.readFileSync(file, 'utf8'), file);
  const nodes = doc.nodes.map((n) => n.id);
  const edges = doc.edges.map((e, index) => ({ index, from: e.from, to: e.to, raw: e }));
  const members = new Set(nodes);
  const loopEdges = edges.filter((e) => members.has(e.from) && members.has(e.to));
  const { back } = backEdgesOfScc(nodes, loopEdges);
  assert.deepEqual(back.map((b) => [b.from, b.to, b.raw.max_iterations]), [['verify', 'build', 2]]);
});
