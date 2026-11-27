// Probe: `forge run <file>` with a POSITIONAL flow argument (员工一号 a34c49e8).
// Must exit non-zero with E_INVALID_ARGS; a run that silently uses DEFAULT_STAGES
// (rc=0, manifest.flow null) is the regression this probe catches.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repo = process.argv[2];
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'af-pos-'));
try {
  // A checkout copy is not needed: the CLI resolves --flow against the repo, and
  // a positional argument must be rejected before any .forge/ dir is created.
  const r = spawnSync(process.execPath, [path.join(repo, 'bin', 'forge.js'), 'run', 'flows/main.yaml'], {
    cwd: repo,
    env: { ...process.env, FORGE_ROOT: root },
    encoding: 'utf8',
    timeout: 60_000,
  });
  const out = `${r.stdout}\n${r.stderr}`;
  const sawCode = /E_INVALID_ARGS/.test(out);
  const madeRun = fs.existsSync(path.join(root, '.forge', 'runs')) &&
    fs.readdirSync(path.join(root, '.forge', 'runs')).length > 0;
  const ok = r.status !== 0 && sawCode && !madeRun;
  process.stdout.write(JSON.stringify({ ok, rc: r.status, sawCode, madeRun, line: (r.stderr || r.stdout).trim().split('\n').slice(-1)[0] ?? '' }) + '\n');
  process.exitCode = ok ? 0 : 1;
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
