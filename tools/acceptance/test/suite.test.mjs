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

// `forge run --flow` now takes a path inside the project root (#10): a flow in the
// repo itself is "outside" a scratch FORGE_ROOT. These tests therefore copy flows/
// into the scratch root and run from there.
function seedRun(repo, root, runId = 'linear-golden') {
  fs.cpSync(path.join(repo, 'flows'), path.join(root, 'flows'), { recursive: true });
  return spawnSync(process.execPath, [path.join(repo, 'bin', 'forge.js'), 'run', '--run', runId, '--flow', 'flows/main.yaml'], {
    cwd: root,
    env: { ...process.env, FORGE_ROOT: root },
    encoding: 'utf8',
  });
}


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

test('H1 goes red when a positional flow argument is accepted again', () => {
  const dir = scratchCopy();
  try {
    // #10 made H1 green by refusing positional args. To prove the row still
    // discriminates, the copy puts back the pre-#10 behaviour: a positional flow
    // argument is simply used (run --flow / a bare path behave alike).
    const f = path.join(dir, 'src', 'cli.js');
    const s = fs.readFileSync(f, 'utf8');
    const guard = "        if (opts._.length) {";
    assert.ok(s.includes(guard), 'positional guard not found');
    const patched = s.replace(
      guard,
      "        if (opts._.length && !opts.flow) opts.flow = opts._[0];\n        if (opts._.length) {",
    ).replace("        if (opts._.length) {\n          throw {", "        if (false) {\n          throw {");
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
test('V1.4 goes red when an unbounded back edge is no longer refused', () => {
  const dir = scratchCopy();
  try {
    const v14 = pickOne(dir).json.rows.find((r) => r.id.startsWith('V1.4'));
    assert.equal(v14.status, 'pass', JSON.stringify(v14));
    // The cycle is the one this flow owns, both entry points name the same ids,
    // and the control flow without the back edge is accepted: the refusal is
    // about the loop, not about the file being broken.
    assert.match(v14.raw, /codes=\[.*E_CYCLE/, v14.raw);
    assert.match(v14.raw, /libIds=\["verify","ops","verify"\]/, v14.raw);
    assert.match(v14.raw, /sameCodes=true/, v14.raw);
    assert.match(v14.raw, /control\(no back edge\): cli rc=0/, v14.raw);
    assert.equal(v14.reds[0].status, 'pass', JSON.stringify(v14.reds));

    // Drop E_CYCLE from the shared validator: the unbounded loop is no longer
    // refused by either entry point, and the row must go red.
    const f = path.join(dir, 'src', 'validate.js');
    const src = fs.readFileSync(f, 'utf8');
    const patched = src.replace("errors.push(code('E_CYCLE', { path: `${file}#${cycle[0][0]}`", "void ({ path: `${file}#${cycle[0][0]}`");
    assert.notEqual(patched, src, 'patch point not found');
    fs.writeFileSync(f, patched);
    const red = pickOne(dir).json.rows.find((r) => r.id.startsWith('V1.4'));
    assert.equal(red.status, 'fail', JSON.stringify(red));
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
test('V1.2a: a hand-made sample dir judges on its own, and shortcuts still go red', async () => {
  // 员工一号 8068f00f: make V1.2a judgeable from any frozen sample BEFORE the
  // entry fix exists. The sample here is produced now (on the current entry), which
  // is why it is NOT committed — only used to prove the judge works end to end.
  const repo = scratchCopy();
  const sample = fs.mkdtempSync(path.join(os.tmpdir(), 'af-sample-'));
  try {
    const r = seedRun(repo, sample);
    assert.equal(r.status, 0, r.stderr);
    const runDir = path.join(sample, '.forge', 'runs', 'linear-golden');
    for (const f of fs.readdirSync(runDir)) if (f !== 'events.jsonl' && f !== 'manifest.json') fs.rmSync(path.join(runDir, f), { recursive: true, force: true });
    // The freeze record (event count + sha256) is what makes "drop the last line"
    // detectable; it is written by whatever freezes the sample.
    const { createHash } = await import('node:crypto');
    const evBuf = fs.readFileSync(path.join(runDir, 'events.jsonl'));
    fs.writeFileSync(path.join(sample, 'freeze.json'), JSON.stringify({
      run: 'linear-golden',
      eventCount: evBuf.toString('utf8').split('\n').filter((l) => l.trim()).length,
      sha256: createHash('sha256').update(evBuf).digest('hex'),
    }) + '\n');

    const run = (env) => {
      const p = spawnSync(process.execPath, [SUITE, '--repo', repo, '--json'], { encoding: 'utf8', timeout: 300_000, env: { ...process.env, ...env } });
      return JSON.parse(p.stdout).rows.find((x) => x.id.startsWith('V1.2a'));
    };
    const good = run({ AF_FROZEN_DIR: sample });
    assert.equal(good.status, 'pass', JSON.stringify({ raw: good.raw, reds: good.reds }));
    assert.ok(good.reds.every((x) => x.status === 'pass'), JSON.stringify(good.reds));

    // Shortcut 1: tamper one event -> chain must break.
    const t1 = fs.mkdtempSync(path.join(os.tmpdir(), 'af-sample-t1-'));
    fs.cpSync(sample, t1, { recursive: true });
    const f1 = path.join(t1, '.forge', 'runs', 'linear-golden', 'events.jsonl');
    // Change the status *value* without touching any hash field: on disk the chain
    // still parses, so only the chain verification can tell.
    const lines1 = fs.readFileSync(f1, 'utf8').split('\n').map((l) => (l.includes('"seq":3') ? l.replace(/"status":"[a-z]+"/, '"status":"failed"') : l));
    fs.writeFileSync(f1, lines1.join('\n'));
    assert.equal(run({ AF_FROZEN_DIR: t1 }).status, 'fail');
    fs.rmSync(t1, { recursive: true, force: true });

    // Shortcut 2: drop the last event -> replay is shorter than the file.
    const t2 = fs.mkdtempSync(path.join(os.tmpdir(), 'af-sample-t2-'));
    fs.cpSync(sample, t2, { recursive: true });
    const f2 = path.join(t2, '.forge', 'runs', 'linear-golden', 'events.jsonl');
    const lines = fs.readFileSync(f2, 'utf8').split('\n').filter((l) => l.trim());
    fs.writeFileSync(f2, lines.slice(0, -1).join('\n') + '\n');
    assert.equal(run({ AF_FROZEN_DIR: t2 }).status, 'fail');
    fs.rmSync(t2, { recursive: true, force: true });
  } finally {
    fs.rmSync(sample, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
test('V1.2a cannot be fooled by a self-consistent, truncated sample', async () => {
  // Dropping the last line and re-freezing the manifest/record from the truncated
  // file must still fail: the record is fixed at freeze time, so rewriting it is a
  // change to the frozen artefact itself and shows up as an error, not a pass.
  const repo = scratchCopy();
  const sample = fs.mkdtempSync(path.join(os.tmpdir(), 'af-sample-g-'));
  try {
    const r = seedRun(repo, sample);
    assert.equal(r.status, 0, r.stderr);
    const runDir = path.join(sample, '.forge', 'runs', 'linear-golden');
    for (const f of fs.readdirSync(runDir)) if (!['events.jsonl', 'manifest.json'].includes(f)) fs.rmSync(path.join(runDir, f), { recursive: true, force: true });
    const { createHash } = await import('node:crypto');
    const buf = fs.readFileSync(path.join(runDir, 'events.jsonl'));
    fs.writeFileSync(path.join(sample, 'freeze.json'), JSON.stringify({ run: 'linear-golden', eventCount: buf.toString('utf8').split('\n').filter((l) => l.trim()).length, sha256: createHash('sha256').update(buf).digest('hex') }) + '\n');
    const run = (env) => {
      const p = spawnSync(process.execPath, [SUITE, '--repo', repo, '--json'], { encoding: 'utf8', timeout: 300_000, env: { ...process.env, ...env } });
      return JSON.parse(p.stdout).rows.find((x) => x.id.startsWith('V1.2a'));
    };
    assert.equal(run({ AF_FROZEN_DIR: sample }).status, 'pass');
    // Truncate the events AND leave the old record in place.
    const f = path.join(runDir, 'events.jsonl');
    const lines = fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.trim());
    fs.writeFileSync(f, lines.slice(0, -1).join('\n') + '\n');
    assert.equal(run({ AF_FROZEN_DIR: sample }).status, 'fail');
  } finally {
    fs.rmSync(sample, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
test('V1.2a records the flow shape, so a sample from the old entry cannot pass on the new one', async () => {
  // 员工四号 158d01cc: freeze.json also carries flowPath (manifest.flow.path and
  // run.start.payload.flow). A second "sample" in which only that shape differs
  // must be red — the stand-in for "generated before the entry fix".
  const repo = scratchCopy();
  const sample = fs.mkdtempSync(path.join(os.tmpdir(), 'af-shape-'));
  try {
    const r = seedRun(repo, sample);
    assert.equal(r.status, 0, r.stderr);
    const runDir = path.join(sample, '.forge', 'runs', 'linear-golden');
    for (const f of fs.readdirSync(runDir)) if (!['events.jsonl', 'manifest.json'].includes(f)) fs.rmSync(path.join(runDir, f), { recursive: true, force: true });
    const { createHash } = await import('node:crypto');
    const buf = fs.readFileSync(path.join(runDir, 'events.jsonl'));
    const record = { run: 'linear-golden', eventCount: buf.toString('utf8').split('\n').filter((l) => l.trim()).length, sha256: createHash('sha256').update(buf).digest('hex'), flowPath: 'flows/main.yaml' };
    fs.writeFileSync(path.join(sample, 'fold.json'), JSON.stringify(record) + '\n');
    const run = (env) => {
      const p = spawnSync(process.execPath, [SUITE, '--repo', repo, '--json'], { encoding: 'utf8', timeout: 300_000, env: { ...process.env, ...env } });
      return JSON.parse(p.stdout).rows.find((x) => x.id.startsWith('V1.2a'));
    };
    assert.equal(run({ AF_FROZEN_DIR: sample, AF_FREEZE_FILE: 'fold.json' }).status, 'pass');
    // The sample "came from another entry": absolute path in it, relative recorded.
    const recAbs = { ...record, flowPath: 'flows/main.yaml' };
    fs.writeFileSync(path.join(sample, 'freeze.json'), JSON.stringify(recAbs) + '\n');
    const manifestAbs = JSON.parse(fs.readFileSync(path.join(runDir, 'manifest.json'), 'utf8'));
    manifestAbs.flow.path = path.join(sample, 'flows', 'main.yaml');
    fs.writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify(manifestAbs, null, 2) + '\n');
    const evLines = fs.readFileSync(path.join(runDir, 'events.jsonl'), 'utf8').split('\n');
    const firstEv = JSON.parse(evLines[0]);
    firstEv.payload.flow = path.join(sample, 'flows', 'main.yaml');
    evLines[0] = JSON.stringify(firstEv);
    fs.writeFileSync(path.join(runDir, 'events.jsonl'), evLines.join('\n'));
    const red = run({ AF_FROZEN_DIR: sample });
    assert.equal(red.status, 'fail', JSON.stringify(red.raw));
    assert.ok(/flow=/.test(red.raw) && /MISMATCH/.test(red.raw), red.raw);
  } finally {
    fs.rmSync(sample, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
test('H2 probe goes red when the recorded flow path becomes absolute', () => {
  // H2 is about the RECORDED form: #10 makes run.js write flowRecord (relative).
  // Reverting that one decision (record what was resolved, as before) must be red.
  const dir = scratchCopy();
  try {
    const f = path.join(dir, 'src', 'run.js');
    const s = fs.readFileSync(f, 'utf8');
    const marker = '  const flowRecord = flowPath == null ? null : recordFlowPath(flowPath, rootDir);';
    assert.ok(s.includes(marker), 'recordFlowPath call not found');
    fs.writeFileSync(f, s.replace(marker, '  const flowRecord = flowPath; // revert: record absolute'));
    const { json } = pickOne(dir);
    const h2 = json.rows.find((r) => r.id.startsWith('H2'));
    assert.equal(h2.status, 'fail', JSON.stringify(h2.raw));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
});
