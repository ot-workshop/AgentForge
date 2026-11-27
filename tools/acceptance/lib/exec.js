// Thin process helpers for the final acceptance suite.
//
// Everything here reads the repo under test; nothing writes into it. A run
// that needs `.forge/` state gets a throwaway FORGE_ROOT (for `serve`) or a
// scratch copy of the frozen sample (for replay), never the checkout itself.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function node(bin, args, opts = {}) {
  return run(process.execPath, [bin, ...args], opts);
}

// Any executable (bash -n, python, ...) with the same result shape as node().
export function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    cwd: opts.cwd,
    env: { ...process.env, ...(opts.env ?? {}) },
    encoding: 'utf8',
    timeout: opts.timeoutMs ?? 120_000,
  });
  return { code: res.status, signal: res.signal, stdout: res.stdout ?? '', stderr: res.stderr ?? '', error: res.error };
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
