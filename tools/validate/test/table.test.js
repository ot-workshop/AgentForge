// Layer 1: docs/error-codes.md parsing. No rules here -- only the table.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTable, indexByCode, indexByFixture, TableError, HEADER, CLASSES } from '../lib/table.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { repo, has, ROOT } from './paths.js';

const H = '| code | severity | locatable | fix | class | fixture |';

const row = (code, klass, fixture, extra = '') => `| \`${code}\` | block | false | \`{action}\` | ${klass} | ${fixture} |`;

test('every md row is read by header name, not by position', () => {
  const text = ['| fixture | class | fix | locatable | severity | code |', '|---|---|---|---|---|---|',
    '| `fixtures/a.yaml` | rule | x | true | block | `E_A` |'].join('\n');
  const [r] = parseTable(text);
  assert.equal(r.code, 'E_A');
  assert.equal(r.klass, 'rule');
  assert.equal(r.locatable, true);
  assert.equal(r.fixture, 'a.yaml');
});

test('header must carry exactly the six PM-fixed column names', () => {
  assert.deepEqual(HEADER, ['code', 'severity', 'locatable', 'fix', 'class', 'fixture']);
  assert.throws(() => parseTable(['| code | severity | locatable | fix | class |', '| `E_A` | block | false | x | rule |'].join('\n')), TableError);
});

test('fixture cell: a path binds it, a lone em dash binds nothing, prose is refused', () => {
  const [a] = parseTable([H, row('E_A', 'rule', '`fixtures/a.yaml`')].join('\n'));
  assert.equal(a.fixture, 'a.yaml');
  const [b] = parseTable([H, row('E_B', 'rule', '\u2014')].join('\n'));
  assert.equal(b.fixture, '');
  // the 13:36 inline shape is exactly what is refused (员工一号 e6c81847)
  assert.throws(() => parseTable([H, row('E_C', 'rule', '\u2014 **[P0.5]** see note')].join('\n')), /ERRCODE_TABLE_FIXTURE/);
  assert.throws(() => parseTable([H, row('E_D', 'rule', 'see note')].join('\n')), /ERRCODE_TABLE_FIXTURE/);
});

test('class is rule|sequence|runtime; a missing class is a rule code, a typo refuses the table', () => {
  assert.deepEqual([...CLASSES], ['rule', 'sequence', 'runtime']);
  assert.throws(() => parseTable([H, row('E_A', 'rul', '\u2014')].join('\n')), /ERRCODE_TABLE_CLASS/);
  assert.throws(() => parseTable([H, row('E_A', '', '\u2014')].join('\n')), /ERRCODE_TABLE_CLASS/);
});

test('the same code on several rows binds one fixture per row (E_P0_UNSUPPORTED)', () => {
  const rows = parseTable([H,
    row('E_P0_UNSUPPORTED', 'rule', '`fixtures/p0-unsupported-<field>.yaml`'),
    row('E_P0_UNSUPPORTED', 'rule', '`fixtures/p0-unsupported-<field>.yaml`')].join('\n'));
  assert.deepEqual(indexByCode(rows).get('E_P0_UNSUPPORTED').fixtures, ['p0-unsupported-<field>.yaml']);
});

test('a code whose rows name no fixture is doc-only; one that names a fixture is not', () => {
  const byCode = indexByCode(parseTable([H, row('E_A', 'rule', '\u2014'), row('E_B', 'rule', '`fixtures/b.yaml`')].join('\n')));
  assert.equal(byCode.get('E_A').docOnly, true);
  assert.equal(byCode.get('E_B').docOnly, false);
});

test('no arguments and a bad option are usage errors (exit 2), distinct from a verdict (1)', ({ skip }) => {
  if (!has('src/validate.js')) return skip('no src/validate.js in the project under test');
  const here = path.dirname(fileURLToPath(import.meta.url));
  const cli = path.join(here, '..', 'index.js');
  const run = (args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', cwd: os.tmpdir(), env: { ...process.env, AF_REPO_SRC: path.join(ROOT, 'src') } });
  const none = run([]);
  assert.equal(none.status, 2, `no args -> ${none.status}: ${none.stderr}`);
  assert.equal(run(['--no-such-option']).status, 2);
  assert.equal(run(['--codes']).status, 2);
  // a usage error never prints a JSON verdict
  assert.throws(() => JSON.parse(none.stdout));
});

test('the real table reads clean: every code has severity, locatable, class and a fixture or a reason for none', () => {
  // parseTable takes the md TEXT (the CLI reads the file); give it the text.
  const rows = parseTable(fs.readFileSync(repo('docs/error-codes.md'), 'utf8'));
  const byCode = indexByCode(rows);
  const byFixture = indexByFixture(rows);
  assert.ok(byCode.size >= 30);
  for (const e of byCode.values()) {
    assert.ok(e.severity.length >= 1, `${e.code} severity`);
    assert.equal(typeof e.locatable, 'boolean');
    assert.ok(CLASSES.has(e.klass), `${e.code} class`);
    if (e.klass !== 'rule') assert.equal(e.docOnly, true, `${e.code} is ${e.klass}: it has no fixture row`);
  }
  assert.deepEqual([...byFixture.get('missing-exit.yaml')], ['E_MISSING_EXIT']);
  assert.ok(byCode.get('E_ILLEGAL_JUMP').docOnly);
  assert.ok(byCode.get('E_LIMIT_UNBOUNDED').docOnly);
});
