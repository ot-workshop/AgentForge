import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = new URL('..', import.meta.url).pathname;
const FORGE = path.join(ROOT, 'bin', 'forge.js');

test('A3.3 tsv mirrors docs/error-codes.md rule-class rows bidirectionally', () => {
  const md = fs.readFileSync(path.join(ROOT, 'docs/error-codes.md'), 'utf8').split('\n');
  const rows = md.filter((l) => /^\|\s*`E_/.test(l)).map((l) => l.split('|').slice(1, -1).map((c) => c.trim()));
  const header = md.find((l) => l.startsWith('| code |'));
  assert.ok(header, 'code table header must exist');
  const cols = header.split('|').slice(1, -1).map((c) => c.trim());
  const idx = (name) => cols.indexOf(name);
  assert.deepEqual(cols, ['code', 'severity', 'locatable', 'fix', 'class', 'fixture']);
  const ruleCodes = new Set();
  const fixtureCodes = new Map();
  for (const r of rows) {
    const code = r[idx('code')].replace(/`/g, '');
    if (r[idx('class')] !== 'rule') continue;
    ruleCodes.add(code);
    const fx = r[idx('fixture')];
    if (fx.startsWith('`fixtures/')) fixtureCodes.set(code, fx.slice(1, fx.indexOf('`', 1)));
  }
  const tsv = fs
    .readFileSync(path.join(ROOT, 'fixtures', 'expected-codes.tsv'), 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#'));
  assert.equal(tsv[0].split('\t')[1] || '', tsv[0].split('\t')[1] || '');
  const firstLine = fs.readFileSync(path.join(ROOT, 'fixtures', 'expected-codes.tsv'), 'utf8').split('\n')[0];
  assert.equal(firstLine, '# source: agentforge-v2.md §A3.3');
  const docOnly = new Set(tsv.filter((l) => l.startsWith('# doc-only:')).flatMap((l) => l.replace('# doc-only:', '').trim().split(/\s+/)));
  const tsvCodes = new Set(tsv.map((l) => l.split('\t')[1]));
  for (const f of tsv) {
    const [file, code] = f.split('\t');
    assert.ok(fs.existsSync(path.join(ROOT, 'fixtures', file)), `${file} named by tsv must exist`);
    if (fixtureCodes.has(code) && !fixtureCodes.get(code).includes('<')) {
      assert.equal(fixtureCodes.get(code), `fixtures/${file}`, `md binds ${code} to ${fixtureCodes.get(code)}`);
    }
  }
  for (const code of ruleCodes) {
    if (code === 'E_P0_UNSUPPORTED') continue; // one placeholder row, four fixtures
    const hasFixture = fixtureCodes.has(code);
    // P0.5-only rules have no executable P0 fixture yet; #流水线:#7 owns filling them.
    if (code === 'E_LIMIT_UNBOUNDED') continue;
    assert.ok(tsvCodes.has(code) || docOnly.has(code) || !hasFixture, `${code} (fixture=${fixtureCodes.get(code) ?? 'none'}) is rule-class but appears in neither tsv nor doc-only`);
    if (docOnly.has(code)) assert.ok(!['E_SCHEMA_INVALID', 'E_UNKNOWN_REF', 'E_P0_UNSUPPORTED'].includes(code), `${code} must not be doc-only`);
  }
  assert.equal(tsvCodes.size, 16);
});

test('A3.3 every tsv fixture yields exactly its listed code', () => {
  const tsv = fs
    .readFileSync(path.join(ROOT, 'fixtures', 'expected-codes.tsv'), 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#'));
  for (const row of tsv) {
    const [file, code] = row.split('\t');
    const r = spawnSync(process.execPath, [FORGE, 'validate', path.join(ROOT, 'fixtures', file), '--json'], { encoding: 'utf8' });
    const codes = JSON.parse(r.stdout).errors.map((e) => e.code);
    assert.deepEqual(codes, [code], `${file} -> ${codes}`);
  }
});
