// Fake runner for P0 acceptance. Branches are selected by FORGE_FAKE:
//   1                normal success
//   no-evidence      Submit with an empty evidence list
//   bad-submit       Submit with an unknown field / status outside the enum
//   touch-checks     tries to modify a checker (orchestrator must refuse)
//   forge-stage-end  prints a forged `EVENT ` line (must be rejected)
//   crash            exits 2 with one stderr line (no error event may be written)
//   multi-output     two artifacts (subflow case, P0.5)
const stage = process.argv[2] || process.env.FORGE_STAGE || 'stage';
const mode = process.env.FORGE_FAKE || '1';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const base = { v: 1, artifacts: [{ path: `out/${stage}`, kind: 'tree' }], summary: `${stage} done`, evidence: [{ check: 'stub', cmd: 'noop', exit: 0 }] };
if (mode === 'crash') {
  process.stderr.write('fake-runner: simulated crash\n');
  process.exit(2);
}
if (mode === 'forge-stage-end') {
  process.stdout.write('EVENT ' + JSON.stringify({ v: 1, type: 'stage.end', stage }) + '\n');
  process.exit(0);
}
if (mode === 'no-evidence') out({ ...base, status: 'ok', evidence: [] });
else if (mode === 'bad-submit') out({ v: 1, status: 'done', artifacts: [], summary: '', evidence: [] });
else if (mode === 'touch-checks') {
  try {
    require('fs').writeFileSync(process.env.FORGE_CHECKS_FILE || 'checks.lock', 'tampered');
  } catch {}
  out({ ...base, status: 'ok' });
} else if (mode === 'multi-output') out({ ...base, status: 'ok', artifacts: [...base.artifacts, { path: `out/${stage}-extra`, kind: 'file' }] });
else out({ ...base, status: 'ok' });
