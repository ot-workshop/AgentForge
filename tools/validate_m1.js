#!/usr/bin/env node
// M1 acceptance commands (agentforge-v2.4 §8.2), one process, no deps.
// usage: node tools/validate_m1.js [projectRoot]
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2] ?? '.');
const forge = path.join(root, 'bin', 'forge.js');
const run = (args) => spawnSync(process.execPath, [forge, ...args], { cwd: root, env: { ...process.env, FORGE_ROOT: root }, encoding: 'utf8' });
let fail = 0;
const row = (ok, name, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ' -- ' + detail}`);
  if (!ok) fail++;
};

const main = run(['validate', path.join(root, 'flows/main.yaml'), '--json']);
row(main.status === 0 && JSON.parse(main.stdout).errors.length === 0, 'main flow validates (exit 0, errors [])', main.stdout || main.stderr);

const tsv = fs
  .readFileSync(path.join(root, 'fixtures/expected-codes.tsv'), 'utf8')
  .split('\n')
  .filter((l) => l.trim() && !l.startsWith('#'))
  .map((l) => l.split('\t'));
for (const [name, code] of tsv) {
  const r = run(['validate', path.join(root, 'fixtures', name), '--json']);
  let codes = [];
  try { codes = JSON.parse(r.stdout).errors.map((e) => e.code); } catch {}
  const p0 = name.startsWith('p0-unsupported-');
  const ok = r.status === 1 && codes.includes(code) && (!p0 || codes.length === 1);
  row(ok, `fixtures/${name} -> ${code}${p0 ? ' (exactly one)' : ''}`, JSON.stringify(codes));
}

// A7.4: `forge design` is an interface reserved for P1; in P0 it must fail
// loudly (exit 2 = unknown command), never silently produce something.
const empty = run(['design', '--request', 'three stage flow']);
row(empty.status === 2, 'forge design (A7.4) is not part of P0 — exit 2 (unknown command)', empty.stderr.split('\n')[0]);

console.log(fail === 0 ? 'RESULT: all M1 commands PASS' : `RESULT: ${fail} FAIL`);
process.exit(fail ? 1 : 0);
