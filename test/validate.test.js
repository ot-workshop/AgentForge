import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

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

test('A3.3 every fixture reports exactly its expected code set from expected-codes.tsv', () => {
  // fixture<TAB>code, one row per (fixture, code): a fixture may expect more
  // than one code (missing-exit is E_MISSING_EXIT + E_CYCLE in a finite P0
  // graph). The comparison is the full multiset: no missing code, no extra one.
  const rows = fs
    .readFileSync(path.join(ROOT, 'fixtures/expected-codes.tsv'), 'utf8')
    .split('\n')
    .filter((l) => l.trim() && !l.startsWith('#'))
    .map((l) => l.split('\t'));
  assert.ok(rows.length >= 5);
  const expected = new Map();
  for (const [name, code] of rows) {
    if (!expected.has(name)) expected.set(name, []);
    expected.get(name).push(code);
  }
  for (const [name, codes] of expected) {
    const r = validate('fixtures/' + name);
    const errs = JSON.parse(r.stdout).errors;
    assert.equal(r.status, 1, name);
    assert.deepEqual([...errs.map((e) => e.code)].sort(), [...codes].sort(), `${name}: expected ${codes.sort()}, got ${errs.map((e) => e.code)}`);
  }
  // Every fixture that reports an error must be registered: a file that fails
  // and is not in the tsv would otherwise hide behind the loop above.
  const dir = fs.readdirSync(path.join(ROOT, 'fixtures')).filter((f) => f.endsWith('.yaml')).sort();
  for (const f of dir) {
    if (expected.has(f)) continue;
    const r = validate('fixtures/' + f);
    assert.equal(r.status, 0, `${f} reports errors but has no tsv row: ${r.stdout}`);
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
    ['p0-unsupported-on.yaml', 'on'],
    ['p0-unsupported-max_iterations.yaml', 'max_iterations'],
    ['p0-unsupported-group.yaml', 'group'],
  ]) {
    const r = validate('fixtures/' + file);
    assert.equal(r.status, 1);
    const errs = JSON.parse(r.stdout).errors;
    assert.equal(errs.length, 1, `${file} -> ${JSON.stringify(errs)}`);
    assert.equal(errs[0].code, 'E_P0_UNSUPPORTED');
    assert.ok(errs[0].path.includes(field), errs[0].path);
  }
});
