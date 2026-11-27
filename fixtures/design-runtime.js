// Real design-stage runtime for M2-B: thin CLI over src/runtime/design.js so
// the orchestrator can start it exactly like fixtures/fake-runner.js.
//   node fixtures/design-runtime.js design      (task JSON on stdin)
// env: FORGE_RUNTIME_BIN (default `opencode`), FORGE_RUNTIME_STAGE (must be `design`)
import fs from 'node:fs';
import { runDesign } from '../src/runtime/design.js';

async function main() {
  const stage = process.argv[2] ?? process.env.FORGE_RUNTIME_STAGE;
  let task;
  try {
    task = JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    process.stderr.write('design-runtime: task book on stdin is not JSON\n');
    return 2;
  }
  if (stage !== 'design' || task.stage !== 'design') {
    process.stderr.write('design-runtime: only the design stage runs on a real runtime\n');
    return 3;
  }
  if (task.doc && JSON.stringify(task).length > 64 * 1024) {
    process.stderr.write('design-runtime: task book is larger than 64 KiB\n');
    return 3;
  }
  const submit = await runDesign({
    binary: process.env.FORGE_RUNTIME_BIN || 'opencode',
    task,
    runDir: process.cwd(),
    timeoutS: task.timeout_s ?? 120,
  });
  process.stdout.write(JSON.stringify(submit) + '\n');
  return 0;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    // A classified runtime failure (E_RUNTIME_*) is reported on the orchestrator's
    // private fd 3 as one structured error line, then the stage exits non-zero.
    if (e && e.code && e.severity) process.stdout.write(JSON.stringify({ v: 1, status: 'blocked', artifacts: [], summary: e.message || e.code, evidence: [{ check: 'runtime', cmd: 'design-runtime', exit: 1 }], runtimeError: e }) + '\n');
    else process.stderr.write(`design-runtime: ${e && e.message ? e.message : e}\n`);
    process.exit(e && e.code === 'E_RUNTIME_TIMEOUT' ? 2 : 1);
  },
);
