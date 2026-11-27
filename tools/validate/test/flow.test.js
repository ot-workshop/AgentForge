// Layer 3: the per-flow verdict is the repository's src/validate.js, called with
// an explicit projectDir. No rule lives in this package.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadRepo, judgeFlow, codeSet, ToolError } from '../lib/delegate.js';
import { parseTsv } from '../lib/tsv.js';
import { ROOT, repo } from './paths.js';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.js');
const SRC = repo('src');
const repoExists = fs.existsSync(path.join(SRC, 'validate.js'));

function cli(args, { cwd = os.tmpdir() } = {}) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd, env: { ...process.env, AF_REPO_SRC: SRC } });
}

test('projectDir is required: without it the call is a tool error, never a guess from cwd', async (t) => {
  if (!repoExists) return t.skip('no src/validate.js in the project under test');
  const r = await loadRepo(SRC);
  await assert.rejects(() => judgeFlow(r, repo('fixtures/cycle.yaml'), {}), ToolError);
  await assert.rejects(() => judgeFlow(r, repo('fixtures/cycle.yaml'), { projectDir: '' }), ToolError);
  const out = cli([repo('fixtures/cycle.yaml'), '--codes', repo('docs/error-codes.md'), '--json']);
  assert.equal(out.status, 2, out.stdout + out.stderr);
  assert.match(out.stderr, /projectDir is required/);
});

test('the CLI and the library report the same code set, from any cwd', async (t) => {
  if (!repoExists) return t.skip('no src/validate.js in the project under test');
  const r = await loadRepo(SRC);
  const flow = repo('flows/main.yaml');
  const lib = codeSet((await judgeFlow(r, flow, { projectDir: ROOT })).errors);
  const fromTmp = cli([flow, '--project', ROOT, '--codes', repo('docs/error-codes.md'), '--json']);
  const fromRoot = spawnSync(process.execPath, [CLI, flow, '--project', ROOT, '--codes', repo('docs/error-codes.md'), '--json'], {
    encoding: 'utf8', cwd: ROOT, env: { ...process.env, AF_REPO_SRC: SRC },
  });
  // Same verdict from two cwds, and the same verdict as the library call.
  assert.equal(fromTmp.status, fromRoot.status);
  const cliSet = codeSet(JSON.parse(fromTmp.stdout).errors);
  assert.deepEqual(codeSet(JSON.parse(fromRoot.stdout).errors), cliSet);
  assert.deepEqual(lib, cliSet);
  assert.deepEqual(lib, []); // the shipped sample is clean
});

test('every fixture reports exactly the code set the tsv registers (fixture | expected | actual | agree)', async (t) => {
  if (!repoExists) return t.skip('no src/validate.js in the project under test');
  const r = await loadRepo(SRC);
  const tsv = parseTsv(fs.readFileSync(repo('fixtures/expected-codes.tsv'), 'utf8'));
  const table = [];
  for (const [fixture, expected] of [...tsv.byFixture].sort(([a], [b]) => a.localeCompare(b))) {
    const file = repo(path.join('fixtures', fixture));
    const { errors } = await judgeFlow(r, file, { projectDir: ROOT });
    const actual = codeSet(errors);
    table.push({ fixture, expected: [...expected].sort(), actual, agree: JSON.stringify([...expected].sort()) === JSON.stringify(actual) });
  }
  const bad = table.filter((x) => !x.agree);
  assert.deepEqual(bad, [], bad.map((x) => `${x.fixture}: expected ${x.expected} got ${x.actual}`).join('\n'));
  assert.ok(table.length >= 19);
});

test('a missing input file is E_FILE_NOT_FOUND: exit 1, locatable false, fix.path, not a schema error', async (t) => {
  if (!repoExists) return t.skip('no src/validate.js in the project under test');
  const r = await loadRepo(SRC);
  const flow = repo('flows/no-such-flow.yaml');
  const { errors } = await judgeFlow(r, flow, { projectDir: ROOT });
  assert.deepEqual(errors.map((e) => e.code), ['E_FILE_NOT_FOUND']);
  assert.equal(errors[0].locatable, false);
  assert.ok(errors[0].fix && errors[0].fix.path);
  const out = cli([flow, '--project', ROOT, '--codes', repo('docs/error-codes.md'), '--json']);
  assert.equal(out.status, 1, out.stdout + out.stderr);
  assert.equal(JSON.parse(out.stdout).errors[0].code, 'E_FILE_NOT_FOUND');
});

test('a P0.5 field yields one answer and the structural rules do not also run', async (t) => {
  if (!repoExists) return t.skip('no src/validate.js in the project under test');
  const r = await loadRepo(SRC);
  // same order the repository CLI uses: validateP0 first, validateFlow only if clean.
  // Since #流水线:#10 `on` on an edge is P0, so the remaining P0.5 answer is
  // `loop_id` on a node.
  const { errors } = await judgeFlow(r, repo('fixtures/p0-unsupported-loop_id.yaml'), { projectDir: ROOT });
  assert.ok(errors.length >= 1);
  assert.ok(errors.every((e) => e.code === 'E_P0_UNSUPPORTED'), errors.map((e) => e.code).join(','));
});

test('a file that will not parse is E_SCHEMA_INVALID at that file, never a tool error', async (t) => {
  if (!repoExists) return t.skip('no src/validate.js in the project under test');
  const r = await loadRepo(SRC);
  const { errors } = await judgeFlow(r, repo('fixtures/broken-yaml.yaml'), { projectDir: ROOT });
  assert.deepEqual(errors.map((e) => e.code), ['E_SCHEMA_INVALID']);
  assert.equal(errors[0].severity, 'block');
});
