import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const FORGE = new URL('../bin/forge.js', import.meta.url).pathname;
const ROOT = new URL('..', import.meta.url).pathname;
const REAL_RUNNER = fs.readFileSync(path.join(ROOT, 'fixtures/fake-runner.js'));

// A run root outside the repository: copied flows/blocks/checks/fixtures into a
// temp dir, so an absolute path would carry that temp prefix.
function externalRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-entry-'));
  for (const d of ['flows', 'blocks', 'checks']) fs.cpSync(path.join(ROOT, d), path.join(root, d), { recursive: true });
  fs.mkdirSync(path.join(root, 'fixtures'), { recursive: true });
  fs.writeFileSync(path.join(root, 'fixtures', 'fake-runner.js'), REAL_RUNNER);
  return root;
}

function forge(root, args) {
  return spawnSync(process.execPath, [FORGE, ...args], { cwd: root, env: { ...process.env, FORGE_ROOT: root, FORGE_FAKE: '1' }, encoding: 'utf8' });
}

function onlyRun(root) {
  const runs = fs.readdirSync(path.join(root, '.forge', 'runs'));
  assert.equal(runs.length, 1, 'exactly one run');
  return path.join(root, '.forge', 'runs', runs[0]);
}

test('#10 pre: `forge run <positional>` is refused with E_INVALID_ARGS, exit 1', () => {
  // Structured error, as any block error: code on stderr, exit 1 (not 2), and
  // `--json` carries the fix (`--flow <path>`).
  const root = externalRoot();
  try {
    const r = forge(root, ['run', 'flows/main.yaml']);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /E_INVALID_ARGS/);
    assert.equal(fs.existsSync(path.join(root, '.forge', 'runs')), false, 'nothing ran');

    const withRun = forge(root, ['run', 'r1', 'flows/main.yaml']);
    assert.equal(withRun.status, 1, withRun.stderr);
    assert.match(withRun.stderr, /E_INVALID_ARGS/);

    // The explicit `--flow` form is unaffected.
    const ok = forge(root, ['run', '--run', 'pos-ok', '--flow', 'flows/main.yaml']);
    assert.equal(ok.status, 0, ok.stderr);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('#10 pre: a `--flow` that names no file is refused and creates no run', () => {
  const root = externalRoot();
  try {
    // `--flow /tmp/xxx.yaml` does not exist: structured error, rc=1, no run.
    const missing = forge(root, ['run', '--flow', '/tmp/xxx.yaml']);
    assert.equal(missing.status, 1, missing.stderr);
    assert.match(missing.stderr, /E_FILE_NOT_FOUND/);
    assert.equal(fs.existsSync(path.join(root, '.forge')), false, 'no .forge/');

    const missingRel = forge(root, ['run', '--flow', 'flows/nope.yaml']);
    assert.equal(missingRel.status, 1, missingRel.stderr);
    assert.match(missingRel.stderr, /E_FILE_NOT_FOUND/);

    // `--flow` with no value is a usage error (2), not a default run.
    const bare = forge(root, ['run', '--flow']);
    assert.equal(bare.status, 2, bare.stderr);
    assert.equal(fs.existsSync(path.join(root, '.forge')), false, 'no .forge/');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('#10 pre: `--flow` in an external root writes one relative path in both places', () => {
  const root = externalRoot();
  try {
    const r = forge(root, ['run', '--run', 'rel', '--flow', 'flows/main.yaml']);
    assert.equal(r.status, 0, r.stderr);
    const runDir = onlyRun(root);
    const manifest = JSON.parse(fs.readFileSync(path.join(runDir, 'manifest.json'), 'utf8'));
    const first = JSON.parse(fs.readFileSync(path.join(runDir, 'events.jsonl'), 'utf8').split('\n')[0]);
    assert.equal(first.type, 'run.start');
    assert.equal(first.payload.flow, 'flows/main.yaml');
    assert.equal(manifest.flow.path, first.payload.flow);
    assert.equal(manifest.flow.path.includes(root), false);
    assert.equal(manifest.flow.path, manifest.flow.path.split(path.sep).join('/'));

    // Same file, absolute argument: the recorded value does not change.
    const abs = forge(root, ['run', '--run', 'rel-abs', '--flow', path.join(root, 'flows/main.yaml')]);
    assert.equal(abs.status, 0, abs.stderr);
    const m2 = JSON.parse(fs.readFileSync(path.join(root, '.forge', 'runs', 'rel-abs', 'manifest.json'), 'utf8'));
    assert.equal(m2.flow.path, 'flows/main.yaml');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('#10 pre: a flow outside the root is refused with E_INVALID_ARGS and leaves no run dir', () => {
  const root = externalRoot();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-outside-'));
  try {
    const flow = path.join(outside, 'main.yaml');
    fs.writeFileSync(flow, fs.readFileSync(path.join(ROOT, 'flows/main.yaml'), 'utf8'));
    const r = forge(root, ['run', '--run', 'abs', '--flow', flow]);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /E_INVALID_ARGS/);
    assert.equal(fs.existsSync(path.join(root, '.forge', 'runs', 'abs')), false, 'no run dir');
    assert.equal(fs.existsSync(path.join(root, '.forge', 'runs')), false, 'nothing ran');

    // `--flow ../<outside>` relative to the root is the same refusal.
    const rel = forge(root, ['run', '--flow', path.relative(root, flow)]);
    assert.equal(rel.status, 1, rel.stderr);
    assert.match(rel.stderr, /E_INVALID_ARGS/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('#10 pre: validate finds blocks/ from the flow file itself (no FORGE_ROOT needed)', () => {
  const root = externalRoot();
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-cwd-'));
  try {
    const env = { ...process.env };
    delete env.FORGE_ROOT;
    const args = [FORGE, 'validate', path.join(root, 'flows/main.yaml'), '--json'];
    const inOther = spawnSync(process.execPath, args, { cwd: other, env, encoding: 'utf8' });
    const inRepo = spawnSync(process.execPath, args, { cwd: ROOT, env, encoding: 'utf8' });
    assert.equal(inOther.status, 0, inOther.stderr);
    assert.equal(inOther.stdout, inRepo.stdout, 'outside cwd and repo root agree byte for byte');
    assert.deepEqual(JSON.parse(inOther.stdout), { errors: [] });

    // A flow with a defect is judged the same from any cwd; since #流水线:#10
    // flows/bugfix.yaml is the valid bounded-retry sample, so the defect sample is
    // contract-mismatch.yaml.
    const badFile = path.join(root, 'fixtures/contract-mismatch.yaml');
    const bad = spawnSync(process.execPath, [FORGE, 'validate', badFile, '--json'], { cwd: other, env, encoding: 'utf8' });
    const badRepo = spawnSync(process.execPath, [FORGE, 'validate', badFile, '--json'], { cwd: ROOT, env, encoding: 'utf8' });
    assert.equal(bad.stdout, badRepo.stdout);
    assert.ok(JSON.parse(bad.stdout).errors.length > 0);

    // FORGE_ROOT still wins when set (explicit root for a file kept elsewhere).
    const withRoot = spawnSync(process.execPath, args, { cwd: other, env: { ...env, FORGE_ROOT: root }, encoding: 'utf8' });
    assert.equal(withRoot.status, 0);
    assert.equal(withRoot.stdout, inRepo.stdout);

    // A flow in a directory tree without blocks/ and no FORGE_ROOT keeps the
    // old cwd-based answer instead of failing: that is the documented fallback.
    const loose = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-loose-'));
    fs.writeFileSync(path.join(loose, 'main.yaml'), fs.readFileSync(path.join(ROOT, 'flows/main.yaml')));
    const noBlocks = spawnSync(process.execPath, [FORGE, 'validate', path.join(loose, 'main.yaml'), '--json'], { cwd: other, env, encoding: 'utf8' });
    assert.equal(noBlocks.status, 1);
    assert.ok(JSON.parse(noBlocks.stdout).errors.some((e) => e.code === 'E_UNKNOWN_REF'));
    fs.rmSync(loose, { recursive: true, force: true });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(other, { recursive: true, force: true });
  }
});

test('#10 pre: no --flow still means the default stages and a null flow in both places', () => {
  const root = externalRoot();
  try {
    const r = forge(root, ['run', '--run', 'default']);
    assert.equal(r.status, 0, r.stderr);
    const runDir = onlyRun(root);
    const manifest = JSON.parse(fs.readFileSync(path.join(runDir, 'manifest.json'), 'utf8'));
    const first = JSON.parse(fs.readFileSync(path.join(runDir, 'events.jsonl'), 'utf8').split('\n')[0]);
    assert.equal(manifest.flow, null);
    assert.equal(first.payload.flow, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
