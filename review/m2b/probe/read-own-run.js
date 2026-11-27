// Probe for docs/runtime-binding.md §4.2: listed as the fake runner in a throwaway copy; reports what
// the stage can see from its own working directory (the run dir).
// Probe: what the stage can see from its own working directory (the run dir).
// Reports file presence + cwd only; reading events.jsonl in the run dir is probed by probe-walls.cjs (relative path).
import fs from 'node:fs';
const probe = { cmd: 'list the run dir from the runner cwd (A4.4 target is checks.lock)', exit: 0 };
try {
  for (const f of ['checks.lock', 'manifest.json', 'context', 'events.jsonl']) probe[f] = fs.existsSync(f);
  probe.files = fs.readdirSync('.').join(',');
  probe.cwd_ends_with = process.cwd().split('/').slice(-2).join('/');
} catch (e) { probe.result = e.code; probe.exit = 1; }
process.stdout.write(JSON.stringify({ v: 1, status: probe.exit === 0 ? 'ok' : 'failed', artifacts: [], summary: 'probe: ' + JSON.stringify(probe), evidence: [{ check: 'runner-cwd', cmd: probe.cmd, exit: probe.exit, log: probe.result ?? 'listed' }] }) + '\n');
