#!/usr/bin/env node
// Final acceptance suite (路线第 5 块, #流水线:#11).
//
// usage: node tools/acceptance/index.mjs --repo <checkout> [--json]
//
// READ-ONLY: probes run on scratch copies under os.tmpdir(); the checkout given
// with --repo is never written to. Exit: 0 every judged row pass (unverified
// rows do not fail the suite), 1 any judged row fail, 2 usage error.
import fs from 'node:fs';
import path from 'node:path';
import {
  gate_freezeAllowed,
  h1_positionalRefused,
  h2_flowPathRelative,
  v1_sameValidator,
  v2_failureLocated,
  v2_replayEquivalence,
  v3_permissionEnforced,
  v4_loops,
  v4_frozenLoop,
  v5_humanEnds,
  d1_deployScriptsSubstantive,
  d2_servedRunTraceable,
} from './lib/criteria.js';

function parse(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') o.json = true;
    else if (a === '--repo') o.repo = argv[++i];
    else if (a === '--help' || a === '-h') o.help = true;
    else return { error: `unknown argument: ${a}` };
  }
  return o;
}

const o = parse(process.argv.slice(2));
if (o.error) {
  process.stderr.write(`${o.error}\nusage: node tools/acceptance/index.mjs --repo <checkout> [--json]\n`);
  process.exit(2);
}
if (o.help) {
  process.stdout.write('usage: node tools/acceptance/index.mjs --repo <checkout> [--json]\n');
  process.exit(0);
}
if (!o.repo) {
  process.stderr.write('usage: node tools/acceptance/index.mjs --repo <checkout> [--json]\n');
  process.exit(2);
}
const repo = path.resolve(o.repo);
if (!fs.existsSync(path.join(repo, 'bin', 'forge.js'))) {
  process.stderr.write(`not an AgentForge checkout: ${repo}\n`);
  process.exit(2);
}

// A probe that throws is a FAIL row with the exception's line, never a crash:
// an acceptance suite that cannot report is worse than one that reports red.
async function guarded(id, fn) {
  try {
    return await fn();
  } catch (e) {
    return { id, standard: '(probe threw)', status: 'fail', commands: [], raw: String(e?.message ?? e).split('\n')[0] };
  }
}

const rows = [
  await guarded('G0 freeze-allowed', () => gate_freezeAllowed(repo)),
  await guarded('H1 run-positional-arg', () => h1_positionalRefused(repo)),
  await guarded('H2 flow-path-relative', () => h2_flowPathRelative(repo)),
  await guarded('V1.1 人机同门', () => v1_sameValidator(repo)),
  await guarded('V1.2a replay==incremental==从头', () => v2_replayEquivalence(repo)),
  await guarded('V1.2b 失败定位到阶段', () => v2_failureLocated(repo)),
  await guarded('V1.3 越权被拦', () => v3_permissionEnforced(repo)),
  await guarded('V1.4 分支与有限循环', () => v4_loops(repo)),
  await guarded('V1.4f 冻结样例 loop-bounded', () => v4_frozenLoop(repo)),
  { id: 'V1.4u 未覆盖：M3/M4', standard: 'M3 经普通边再次进入 / M4 on 边优先', status: 'unverified', commands: [], raw: '按员工一号 1c4df2e6 从 PR #16 摘出，合并后单开任务', notes: '不在本条判，不计入 PASS' },
  await guarded('V1.5 人只在两端', () => v5_humanEnds(repo)),
  await guarded('D1 deploy-scripts-substantive', () => d1_deployScriptsSubstantive(repo)),
  await guarded('D2 serves-healthz-snapshot-events', () => d2_servedRunTraceable(repo)),
];

const count = (st) => rows.filter((r) => r.status === st).length;
const counts = { pass: count('pass'), fail: count('fail'), unverified: count('unverified') };

if (o.json) {
  process.stdout.write(JSON.stringify({ repo, rows, counts }, null, 2) + '\n');
} else {
  for (const r of rows) {
    process.stdout.write(`${r.status.toUpperCase().padEnd(10)} ${r.id}\n`);
    for (const c of r.commands) process.stdout.write(`           cmd: ${c}\n`);
    if (r.raw) process.stdout.write(`           raw: ${r.raw}\n`);
    if (r.notes) process.stdout.write(`           note: ${r.notes}\n`);
    for (const red of r.reds ?? []) {
      process.stdout.write(`           red[${red.status}] ${red.id}: ${red.raw}\n`);
    }
  }
  process.stdout.write(`RESULT: PASS=${counts.pass} FAIL=${counts.fail} UNVERIFIED=${counts.unverified}\n`);
}
process.exitCode = counts.fail > 0 ? 1 : 0;
