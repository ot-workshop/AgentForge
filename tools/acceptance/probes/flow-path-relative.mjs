// Probe: with `--flow`, manifest.flow.path and run.start.payload.flow must be
// the SAME string and must not carry the absolute prefix of the root
// (员工一号 a34c49e8 §4): a frozen run has to replay verbatim on another machine.
// usage: node flow-path-relative.mjs <repo>
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repo = process.argv[2];
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'af-rel-'));
try {
  const r = spawnSync(process.execPath, [path.join(repo, 'bin', 'forge.js'), 'run', '--run', 'rel-1', '--flow', 'flows/main.yaml'], {
    cwd: repo,
    env: { ...process.env, FORGE_ROOT: root },
    encoding: 'utf8',
    timeout: 120_000,
  });
  const runDir = path.join(root, '.forge', 'runs', 'rel-1');
  const manifest = JSON.parse(fs.readFileSync(path.join(runDir, 'manifest.json'), 'utf8'));
  const first = JSON.parse(fs.readFileSync(path.join(runDir, 'events.jsonl'), 'utf8').split('\n')[0]);
  const mp = manifest.flow?.path ?? null;
  const ep = first.payload?.flow ?? null;
  const ok = r.status === 0 && typeof mp === 'string' && mp === ep && !path.isAbsolute(mp) && !mp.startsWith(root);
  process.stdout.write(JSON.stringify({ ok, rc: r.status, manifest: mp, event: ep }) + '\n');
  process.exitCode = ok ? 0 : 1;
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
