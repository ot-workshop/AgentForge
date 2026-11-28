// Thin process helpers for the final acceptance suite.
//
// Everything here reads the repo under test; nothing writes into it. A run
// that needs `.forge/` state gets a throwaway FORGE_ROOT (for `serve`) or a
// scratch copy of the frozen sample (for replay), never the checkout itself.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// `--stack-size`: never inherit whatever the caller's shell was started with. A small
// value makes Node re-run the entry under a worker thread on startup, which run.js
// does not survive (observed here: `forge ... → internal error: Cannot read properties
// of undefined (reading 'from')`, rc=2, no run dir). The probes want the plain default.
const NODE_FLAGS = ['--stack-size=984'];

// Timeouts are enforced with SIGKILL: `child_process`'s plain `timeout` sends SIGTERM, which
// a running `forge run` does not handle, so a walk that never ends would survive it and hold
// the whole suite (员工三号 7c90ccd9, 员工一号 580cfa1d). A killed call comes back as
// `killed: true` and the row treats it as a failed step. AF_RUN_TIMEOUT_MS sets the ceiling
// (default 120s).
//
// KNOWN GAP (员工一号 f8b0004f; 员工三号 cc39f9c9 / 970c2db4): SIGKILL of the direct child
// takes ~5s reproducibly, but `spawnSync`'s timeout is not reliable for a child with
// long-lived grandchildren (`forge run` spawns `fake-runner.js` per stage): a 5s limit has
// been seen to return in ~59s, grandchildren have outlived a killed parent, and a scratch
// copy left behind by a kill is not removed (one held 11.8 MB of events). This guarantees
// "the suite ends", not "every descendant is gone and every scratch dir removed". A
// process-group kill + provable cleanup is tracked separately.
export const DEFAULT_TIMEOUT_MS = Number(process.env.AF_RUN_TIMEOUT_MS) > 0 ? Number(process.env.AF_RUN_TIMEOUT_MS) : 120_000;

// Diagnostic only: AF_EXEC_TRACE=<file> appends one JSON line per call (pid, group, how it
// ended), so a leftover process can be matched to the call that started it.
function trace(event) {
  const f = process.env.AF_EXEC_TRACE;
  if (!f) return;
  try {
    fs.appendFileSync(f, JSON.stringify({ t: Date.now(), ...event }) + '\n');
  } catch {
    /* tracing must never fail a call */
  }
}

// Synchronous calls (the CLI and every helper here is sync): the direct child gets
// `timeout` + `killSignal: SIGKILL`.
export function run(cmd, args, opts = {}) {
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const started = Date.now();
  const res = spawnSync(cmd, args, {
    cwd: opts.cwd,
    env: { ...process.env, ...(opts.env ?? {}) },
    encoding: 'utf8',
    timeout,
    killSignal: 'SIGKILL',
  });
  const killed = Boolean(res.error && res.error.code === 'ETIMEDOUT') || res.signal === 'SIGKILL';
  trace({ kind: killed ? 'killed' : 'end', cwd: opts.cwd, cmd, args: args.slice(-3), timeout, killed, signal: res.signal, code: res.status, elapsedMs: Date.now() - started });
  return { code: res.status, signal: res.signal, killed, elapsedMs: Date.now() - started, timeoutMs: timeout, stdout: res.stdout ?? '', stderr: res.stderr ?? '', error: res.error };
}

export function node(bin, args, opts = {}) {
  return run(process.execPath, [...NODE_FLAGS, bin, ...args], opts);
}

// One short line of a command's original output, for the report's "原始行".
export function rawLine(s, n = 200) {
  if (!s) return '';
  const lines = String(s).trim().split('\n').filter((l) => l.trim() !== '');
  const line = lines.length ? lines[lines.length - 1] : '';
  return line.length > n ? line.slice(0, n - 1) + '…' : line;
}

export function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function copyDir(src, dst) {
  fs.cpSync(src, dst, { recursive: true });
}

export function removeDir(d) {
  fs.rmSync(d, { recursive: true, force: true, maxRetries: 3 });
}
