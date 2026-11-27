// Suite self-tests. Each one breaks ONE thing in a scratch copy and asserts the
// suite goes red for the right row — a judge that cannot fail is not a judge.
//
// Run it with the repo under test named explicitly:
//   AF_REPO=<checkout> node --test tools/acceptance/test/
// (the repo root's own `node --test` picks this file up but has no such target;
//  it skips itself there instead of importing the suite into the M1 test count.)
import { test, describe } from 'node:test';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SUITE = fileURLToPath(new URL('../index.mjs', import.meta.url));
const REPO = process.env.AF_REPO ? path.resolve(process.env.AF_REPO) : '';
function runSuite(repo) {
  const r = spawnSync(process.execPath, [SUITE, '--repo', repo, '--json'], { encoding: 'utf8', timeout: 300_000 });
  return { code: r.status, json: JSON.parse(r.stdout), stderr: r.stderr };
}

function scratchCopy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-suite-'));
  // Only what the probes read: code, fixtures, flows, deploy scripts, the suite.
  // Copying `.git` made every test clone a full checkout for nothing.
  for (const d of ['src', 'bin', 'fixtures', 'flows', 'blocks', 'agents', 'checks', 'deploy', 'tools', 'package.json']) {
    fs.cpSync(path.join(REPO, d), path.join(dir, d), { recursive: true });
  }
  fs.rmSync(path.join(dir, '.forge'), { recursive: true, force: true });
  return dir;
}

const pickOne = (repo) => runSuite(repo);

describe('final acceptance suite', { skip: process.env.AF_REPO ? false : 'AF_REPO not set' }, () => {
test('baseline: the suite runs and reports one row per criterion', () => {
  const { json } = pickOne(REPO);
  const ids = json.rows.map((r) => r.id);
  assert.ok(ids.some((i) => i.startsWith('V1.1')));
  assert.ok(ids.some((i) => i.startsWith('V1.5')));
  assert.equal(typeof json.counts.pass, 'number');
});

test('V1.1 goes red when the library validator disagrees with the CLI', () => {
  const dir = scratchCopy();
  try {
    // Drop E_CYCLE. The CLI and the library both load src/validate.js, so the
    // verdicts stay equal — but a cycle is no longer refused, which the probe
    // must catch as a red row rather than paper over.
    const f = path.join(dir, 'src', 'validate.js');
    const src = fs.readFileSync(f, 'utf8');
    const patched = src.replace("errors.push(code('E_CYCLE', { path: `${file}#${cycle[0][0]}`", "void ({ path: `${file}#${cycle[0][0]}`");
    assert.notEqual(patched, src, 'patch point not found');
    fs.writeFileSync(f, patched);
    // Equal verdicts (true) but invalid flows no longer refused: the red probes
    // inside V1.1 must turn the row red.
    const { json } = pickOne(dir);
    const row = json.rows.find((r) => r.id.startsWith('V1.1'));
    assert.equal(row.status, 'fail', JSON.stringify({ raw: row.raw, reds: row.reds }));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('V1.2b goes red when a failed stage is not recorded as failed', () => {
  const dir = scratchCopy();
  try {
    const f = path.join(dir, 'fixtures', 'fake-runner.js');
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace("status: 'failed', evidence", "status: 'ok', evidence"));
    const { json } = pickOne(dir);
    const row = json.rows.find((r) => r.id.startsWith('V1.2b'));
    assert.equal(row.status, 'fail');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('V1.3 goes red when the orchestrator does not notice a tampered checker', () => {
  const dir = scratchCopy();
  try {
    const f = path.join(dir, 'src', 'run.js');
    const s = fs.readFileSync(f, 'utf8');
    // Disable the permission comparison: pretend the checker never changed.
    const patched = s.replace('const checksWritten = checksShaAfter !== checksShaBefore;', 'const checksWritten = false;');
    assert.notEqual(patched, s, 'patch point not found');
    fs.writeFileSync(f, patched);
    const { json } = pickOne(dir);
    const row = json.rows.find((r) => r.id.startsWith('V1.3'));
    assert.equal(row.status, 'fail');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('H1 goes green only when a positional flow argument is refused', () => {
  const dir = scratchCopy();
  try {
    const f = path.join(dir, 'src', 'cli.js');
    const s = fs.readFileSync(f, 'utf8');
    const patched = s.replace(
      "flowPath: opts.flow && opts.flow !== true ? path.resolve(opts.flow) : null,",
      "flowPath: opts.flow && opts.flow !== true ? path.relative(root(), path.resolve(opts.flow)) : opts._[0] ? (() => { throw Object.assign(new Error('E_INVALID_ARGS'), { errors: [structuredError({ code: 'E_INVALID_ARGS', severity: 'block', locatable: true, path: String(opts._[0]), ids: [], fix: { action: 'use --flow <path>' } })], exitCode: 1 }); })() : null,",
    );
    assert.notEqual(patched, s, 'patch point not found');
    fs.writeFileSync(f, patched);
    const { json } = pickOne(dir);
    const h1 = json.rows.find((r) => r.id.startsWith('H1'));
    const h2 = json.rows.find((r) => r.id.startsWith('H2'));
    const g0 = json.rows.find((r) => r.id.startsWith('G0'));
    assert.equal(h1.status, 'pass', JSON.stringify(h1.raw));
    assert.equal(h2.status, 'pass', JSON.stringify(h2.raw));
    assert.equal(g0.status, 'pass');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('G0 stays red while H2 is red', () => {
  const { json } = pickOne(REPO);
  const h2 = json.rows.find((r) => r.id.startsWith('H2'));
  const g0 = json.rows.find((r) => r.id.startsWith('G0'));
  if (h2.status !== 'pass') assert.equal(g0.status, 'fail');
});
test('D1 goes red when smoke.sh loses /events or deploy.sh is emptied', () => {
  const dir = scratchCopy();
  try {
    const smoke = path.join(dir, 'deploy', 'smoke.sh');
    fs.writeFileSync(smoke, fs.readFileSync(smoke, 'utf8').replaceAll('/events', ''));
    let { json } = pickOne(dir);
    assert.equal(json.rows.find((r) => r.id.startsWith('D1')).status, 'fail');
    fs.writeFileSync(path.join(dir, 'deploy', 'deploy.sh'), '#!/usr/bin/env bash\nexit 0\n');
    ({ json } = pickOne(dir));
    const d1 = json.rows.find((r) => r.id.startsWith('D1'));
    assert.equal(d1.status, 'fail', JSON.stringify(d1.raw));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('D2 goes red when /events stops streaming run.start', () => {
  const dir = scratchCopy();
  try {
    const f = path.join(dir, 'src', 'serve.js');
    const s = fs.readFileSync(f, 'utf8');
    // Serve an empty SSE stream: /healthz and /snapshot stay fine, only the
    // event tail breaks, so a green D2 would be a judge that does not look.
    const i = s.indexOf("url.pathname === '/events'");
    assert.ok(i > 0, 'events route not found');
    const patched = s.slice(0, i) + "url.pathname === '/events-broken'" + s.slice(i + "url.pathname === '/events'".length);
    fs.writeFileSync(f, patched);
    const { json } = pickOne(dir);
    const d2 = json.rows.find((r) => r.id.startsWith('D2'));
    assert.equal(d2.status, 'fail', JSON.stringify(d2.raw));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test('V1.5 goes red when src/ can write a human acceptance event', () => {
  const dir = scratchCopy();
  try {
    const f = path.join(dir, 'src', 'run.js');
    const s = fs.readFileSync(f, 'utf8');
    const marker = "    // A resumed run records the (re)start in the same chain instead of replacing it.";
    assert.ok(s.includes(marker), 'insert point not found');
    fs.writeFileSync(f, s.replace(marker, `${marker}\n    if (process.env.FORGE_SELFPASS) writer.append({ run_id: id, type: 'run.accept', actor: { kind: 'human', name: 'orchestrator' } });`));
    const { json } = pickOne(dir);
    const v15 = json.rows.find((r) => r.id.startsWith('V1.5'));
    assert.equal(v15.status, 'fail', JSON.stringify(v15.raw));
    assert.ok(/run\.js/.test(v15.raw), v15.raw);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('V1.5 stays green on a human gate in a flow (a declaration is not an acceptance)', () => {
  // The src/ scanner must not trip on ref.drift's acceptedBy or on validate.js's
  // "human gate" wording: those are not run-level acceptance.
  const { json } = pickOne(REPO);
  const v15 = json.rows.find((r) => r.id.startsWith('V1.5'));
  assert.equal(v15.status, 'pass', JSON.stringify(v15.raw));
});
});
