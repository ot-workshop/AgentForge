import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { validateFlow, validateP0, loadYamlFile } from '../src/validate.js';

const FORGE = new URL('../bin/forge.js', import.meta.url).pathname;
const ROOT = new URL('..', import.meta.url).pathname;

function validate(file) {
  return spawnSync(process.execPath, [FORGE, 'validate', path.join(ROOT, file), '--json'], { encoding: 'utf8' });
}

// Same project as the acceptance runner, supplied explicitly: the library must
// not fall back to the caller's cwd (员工一号: a library call that forgot the
// project would judge a different one and report fewer errors).
function validateLib(file) {
  let doc;
  try {
    doc = loadYamlFile(path.join(ROOT, file));
  } catch (e) {
    return { errors: e.errors }; // a file that will not parse is the loader's error, same as the CLI
  }
  // The CLI's order (and the only order that gives one answer): P0 baseline
  // first; the structural rules only run on a P0-clean document.
  const p0 = validateP0(doc, { file });
  return { errors: p0.length ? p0 : validateFlow(doc, { file, p0: false, projectDir: ROOT }) };
}

test('A3.1 the linear sample validates with no errors', () => {
  const r = validate('flows/main.yaml');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).errors, []);
});

test('A3.3 every fixture reports exactly its expected code set from expected-codes.tsv', () => {
  // fixture<TAB>code, one row per (fixture, code): a fixture may expect more
  // than one code (missing-exit is E_MISSING_EXIT + E_CYCLE in a finite P0
  // graph; 员工一号 5928fe89). The comparison is the full multiset: no missing
  // code and no extra one -- "exactly one" would treat two real defects as one.
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
  // The other direction: a fixture that reports errors but has no tsv row would
  // otherwise hide behind the loop above.
  const dir = fs.readdirSync(path.join(ROOT, 'fixtures')).filter((f) => f.endsWith('.yaml')).sort();
  for (const f of dir) {
    if (expected.has(f)) continue;
    const r = validate('fixtures/' + f);
    assert.equal(r.status, 0, `${f} reports errors but has no tsv row: ${r.stdout}`);
  }
});

test('library and CLI agree for every fixture when projectDir is supplied explicitly', () => {
  // Two entry points, one judgement. The library call runs from a DIFFERENT cwd
  // on purpose: before projectDir existed, file-reading rules resolved the
  // project from the flow path while the CLI resolved it from `root()`, so the
  // same flow could produce different code sets (员工一号, #流水线:#7).
  const before = process.cwd();
  const dirs = fs.readdirSync(path.join(ROOT, 'fixtures')).filter((f) => f.endsWith('.yaml')).sort();
  try {
    process.chdir(path.join(ROOT, 'test'));
    for (const f of dirs) {
      const cli = JSON.parse(validate('fixtures/' + f).stdout).errors.map((e) => e.code).sort();
      const lib = validateLib('fixtures/' + f).errors.map((e) => e.code).sort();
      assert.deepEqual(lib, cli, `${f}: library ${lib} vs CLI ${cli}`);
    }
    const cliMain = JSON.parse(validate('flows/main.yaml').stdout).errors.map((e) => e.code);
    const libMain = validateLib('flows/main.yaml').errors.map((e) => e.code);
    assert.deepEqual(libMain, cliMain, `flows/main.yaml: library ${libMain} vs CLI ${cliMain}`);
  } finally {
    process.chdir(before);
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
