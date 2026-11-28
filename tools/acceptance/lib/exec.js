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

export function node(bin, args, opts = {}) {
  return run(process.execPath, [...NODE_FLAGS, bin, ...args], opts);
}

// Any executable (bash -n, python, ...) with the same result shape as node().
// The timeout is enforced with SIGKILL: `child_process`'s plain `timeout` sends SIGTERM,
// which a running `forge run` does not handle, so a walk that never ends would survive it
// and hold the whole suite (员工三号 7c90ccd9, 员工一号 580cfa1d). A kill comes back as
// `killed: true` with `signal: 'SIGKILL'`; callers treat that as a failed step.
export const DEFAULT_TIMEOUT_MS = Number(process.env.AF_RUN_TIMEOUT_MS) > 0 ? Number(process.env.AF_RUN_TIMEOUT_MS) : 120_000;

export function run(cmd, args, opts = {}) {
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const res = spawnSync(cmd, args, {
    cwd: opts.cwd,
    env: { ...process.env, ...(opts.env ?? {}) },
    encoding: 'utf8',
    timeout,
    killSignal: 'SIGKILL',
  });
  const killed = Boolean(res.error && res.error.code === 'ETIMEDOUT') || res.signal === 'SIGKILL';
  return {
    code: res.status,
    signal: res.signal,
    killed,
    timeoutMs: timeout,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    error: res.error,
  };
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
