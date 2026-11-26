// Fake runner for P0 acceptance. Branches are selected by FORGE_FAKE:
//   1                normal success
//   no-evidence      Submit with an empty evidence list
//   bad-submit       Submit with an unknown field / status outside the enum
//   touch-checks     tries to modify a checker (orchestrator must refuse)
//   forge-stage-end  prints a forged `EVENT ` line (must be rejected)
//   crash            exits 2 with one stderr line (no error event may be written)
//   crash-midwrite   leaves a half line in events.jsonl, then exits 2
//   fail-<stage>     that stage submits `failed`, all others succeed
//   multi-output     two artifacts (subflow case, P0.5)
const stage = process.argv[2] || process.env.FORGE_STAGE || 'stage';
const mode = process.env.FORGE_FAKE || '1';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const base = { v: 1, artifacts: [{ path: `out/${stage}`, kind: 'tree' }], summary: `${stage} done`, evidence: [{ check: 'stub', cmd: 'noop', exit: 0 }] };
if (mode && mode.startsWith('fail-')) {
  // Stage-scoped failure: `fail-<stage>` makes only that stage submit `failed`.
  if (stage === mode.slice(5)) out({ ...base, status: 'failed', evidence: [{ check: 'stub', cmd: 'noop', exit: 1 }], next_hint: `${stage} failed` });
  else out({ ...base, status: 'ok' });
  process.exit(0);
}
const crashMode = mode === 'crash' || mode === 'crash-midwrite';
if (crashMode) {
  if (mode === 'crash-midwrite') {
    // Write a half line straight into events.jsonl, then die (A5.8/A5.11).
    const f = process.env.FORGE_EVENTS;
    if (f) require('fs').appendFileSync(f, '{"seq":' + (Number(process.env.FORGE_PREV_SEQ) + 1) + ',"type":"stage.st');
    process.stderr.write('fake-runner: simulated crash mid-write\n');
  } else process.stderr.write('fake-runner: simulated crash\n');
  process.exit(2);
}
if (mode === 'crash-midwrite') {
  // Write a half line straight into events.jsonl, then die (A5.8/A5.11).
  const f = process.env.FORGE_EVENTS;
  if (f) require('fs').appendFileSync(f, '{"seq":' + (Number(process.env.FORGE_PREV_SEQ) + 1) + ',"type":"stage.st');
  process.stderr.write('fake-runner: simulated crash mid-write\n');
  process.exit(2);
}
if (mode === 'forge-stage-end') {
  process.stdout.write('EVENT ' + JSON.stringify({ v: 1, type: 'stage.end', stage }) + '\n');
  process.exit(0);
}
if (mode === 'no-evidence') out({ ...base, status: 'ok', evidence: [] });
else if (mode === 'bad-submit') out({ v: 1, status: 'done', artifacts: [], summary: '', evidence: [] });
else if (mode === 'touch-checks') {
  const target = process.env.FORGE_CHECKS_FILE;
  if (!target) {
    process.stderr.write('fake-runner: FORGE_CHECKS_FILE missing; refusing to guess the protected file\n');
    process.exit(3);
  }
  require('fs').writeFileSync(target, 'tampered');
  out({ ...base, status: 'ok' });
} else if (mode === 'multi-output') out({ ...base, status: 'ok', artifacts: [...base.artifacts, { path: `out/${stage}-extra`, kind: 'file' }] });
else out({ ...base, status: 'ok' });
