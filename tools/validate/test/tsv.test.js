// Layer 2: fixtures/expected-codes.tsv is a projection of docs/error-codes.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseTable, indexByCode, indexByFixture } from '../lib/table.js';
import { parseTsv, crossCheck, notesOf, TsvError } from '../lib/tsv.js';
import { repo } from './paths.js';

const HEAD = '# source: agentforge-v2.md §A3.3';
const H = '| code | severity | locatable | fix | class | fixture |';
const row = (code, klass, fixture) => `| \`${code}\` | block | false | \`{action}\` | ${klass} | ${fixture} |`;
const load = () => {
  const md = fs.readFileSync(repo('docs/error-codes.md'), 'utf8');
  const rows = parseTable(md);
  return { md, byCode: indexByCode(rows), byFixture: indexByFixture(rows), notes: notesOf(md) };
};

test('one fixture may carry several codes: the tsv is read as fixture -> set', () => {
  const t = parseTsv([HEAD, 'missing-exit.yaml\tE_MISSING_EXIT', 'missing-exit.yaml\tE_CYCLE'].join('\n'));
  assert.deepEqual([...t.byFixture.get('missing-exit.yaml')].sort(), ['E_CYCLE', 'E_MISSING_EXIT']);
});

test('the same (fixture, code) pair twice is refused; a fixture twice with different codes is not', () => {
  assert.throws(() => parseTsv([HEAD, 'a.yaml\tE_A', 'a.yaml\tE_A'].join('\n')), /ERRTSV_DUP/);
  assert.doesNotThrow(() => parseTsv([HEAD, 'a.yaml\tE_A', 'a.yaml\tE_B'].join('\n')));
});

test('tsv header, columns and doc-only shape are checked', () => {
  assert.throws(() => parseTsv('a.yaml\tE_A'), /ERRTSV_HEADER/);
  assert.throws(() => parseTsv([HEAD, 'a.yaml E_A'].join('\n')), /ERRTSV_COLUMNS/);
  assert.throws(() => parseTsv([HEAD, '# doc-only: not-a-code'].join('\n')), /ERRTSV_DOC_ONLY/);
  assert.deepEqual([...parseTsv([HEAD, '# doc-only: E_X E_Y'].join('\n')).docOnly], ['E_X', 'E_Y']);
});

test('the real table and the real tsv agree in both directions (zero divergences)', () => {
  const { byCode, byFixture, notes, md } = load();
  const tsv = parseTsv(fs.readFileSync(repo('fixtures/expected-codes.tsv'), 'utf8'));
  assert.deepEqual(crossCheck(byCode, byFixture, tsv, { notes }), []);
  assert.deepEqual([...tsv.docOnly].sort(), ['E_ILLEGAL_JUMP', 'E_LIMIT_UNBOUNDED']);
  assert.ok(byCode.get('E_ILLEGAL_JUMP').klass === 'rule' && byCode.get('E_ILLEGAL_JUMP').docOnly);
  assert.match(md, /fixtures\/illegal-jump\.yaml/); // the note says why the cell is "—"
});

test('a missing tsv row, a wrong code and a missing doc-only line are each reported', () => {
  const base = {
    byCode: indexByCode(parseTable([H, row('E_A', 'rule', '`fixtures/a.yaml`'), row('E_B', 'rule', '\u2014')].join('\n'))),
    byFixture: indexByFixture(parseTable([H, row('E_A', 'rule', '`fixtures/a.yaml`'), row('E_B', 'rule', '\u2014')].join('\n'))),
    notes: '',
  };
  const p1 = crossCheck(base.byCode, base.byFixture, parseTsv([HEAD, '# doc-only: E_B'].join('\n')), { notes: '' });
  assert.ok(p1.some((p) => p.includes('missing from tsv: a.yaml')), p1.join('\n'));
  const p2 = crossCheck(base.byCode, base.byFixture, parseTsv([HEAD, 'a.yaml\tE_B', '# doc-only: E_B'].join('\n')), { notes: '' });
  assert.ok(p2.some((p) => p.includes('not bound to E_B')), p2.join('\n'));
  const p3 = crossCheck(base.byCode, base.byFixture, parseTsv([HEAD, 'a.yaml\tE_A'].join('\n')), { notes: '' });
  assert.ok(p3.some((p) => p.includes('doc-only') && p.includes('E_B')), p3.join('\n'));
});

test('a fixture that the md never names is reported even when its code is right', () => {
  const { byCode, byFixture, notes } = load();
  const tsv = parseTsv([HEAD, 'broken-yaml.yaml\tE_SCHEMA_INVALID', 'no-such-file.yaml\tE_UNREACHABLE'].join('\n'));
  const problems = crossCheck(byCode, byFixture, tsv, { notes });
  assert.ok(problems.some((p) => p.includes('named nowhere') && p.includes('no-such-file.yaml')), problems.join('\n'));
});

test('the placeholder row covers every p0-unsupported-* file in the tsv', () => {
  const { byCode, byFixture, notes } = load();
  const tsv = parseTsv(fs.readFileSync(repo('fixtures/expected-codes.tsv'), 'utf8'));
  const p0Files = [...tsv.byFixture.keys()].filter((f) => f.startsWith('p0-unsupported-'));
  assert.equal(p0Files.length, 4);
  assert.ok(byCode.get('E_P0_UNSUPPORTED').fixtures.some((f) => f.includes('<')), 'the md row is a placeholder');
  assert.deepEqual(crossCheck(byCode, byFixture, tsv, { notes }), []);
});
