// Real agent runtime for the design stage (M2-B, #流水线:#9).
//
// Scope: only `design` runs here; every other stage keeps the fake runner.
// The adapter answers the same contract as fixtures/fake-runner.js: it starts
// in the run dir, reads the task from stdin, writes ONE Submit JSON object to
// stdout and exits 0. It never writes the event stream (A5.8): the
// orchestrator alone appends events.
//
// Input: the task book (JSON) handed over on stdin by src/run.js's design
// branch. Output: {v, status, artifacts, summary, evidence} per
// protocol/v1/submit.json. Evidence must be a command or a path, never a URL.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { structuredError } from '../errors.js';

export const DEFAULT_TIMEOUT_S = 120;
export const MAX_TASK_BYTES = 64 * 1024;
const URL_RE = /\b(?:https?|ftp|wss?):\/\//i;

export function timeoutForSpec(spec) {
  const t = spec?.limits?.timeout_s;
  return Number.isInteger(t) && t > 0 ? t : DEFAULT_TIMEOUT_S;
}

export function buildPrompt(task) {
  const stages = (task.doc?.nodes ?? []).map((n) => `- ${n.id} (${n.uses})`).join('\n') || '(none)';
  // opencode resolves tool commands against the directory it was started in,
  // so the stage dir is named explicitly rather than as "the current directory".
  const dir = task.run_dir ?? 'the current directory';
  return [
    `You are the "design" stage of an AgentForge run (run_id ${task.run_id}).`,
    `Task: ${task.request}`,
    `Flow ${task.flow_id} has these stages:`,
    stages,
    '',
    `Do exactly one thing: create the file ${dir}/plan.md with a short design plan for this task`,
    '(Markdown, at most 30 lines). Do not touch any other file.',
    'Then reply with one short sentence confirming what you wrote.',
  ].join('\n');
}

export function buildSubmit({ reply, planPath, planText, runtime, startedAt }) {
  const evidence = [{ check: 'plan-written', cmd: `test -s ${planPath}`, exit: planText.length ? 0 : 1 }];
  return {
    v: 1,
    status: planText.length ? 'ok' : 'failed',
    artifacts: [{ path: planPath, kind: 'file' }],
    summary: (reply || `design plan written to ${planPath}`).slice(0, 2000),
    evidence,
    ...(planText.length ? {} : { next_hint: 'the runtime did not write plan.md' }),
    runtime: { name: runtime.name, version: runtime.version, duration_ms: Date.now() - startedAt },
  };
}

// Validate a Submit that came from a real runtime against the same rules the
// fake runner's output meets. Returns a structured error or null.
export function checkSubmit(submit, { stage }) {
  const bad = (fix, where = 'submit') =>
    structuredError({ code: 'E_SCHEMA_INVALID', severity: 'block', locatable: false, path: where, ids: [`stage:${stage}`], fix });
  if (!submit || typeof submit !== 'object') return bad({ action: 'emit a Submit JSON object' });
  if (!['ok', 'failed', 'blocked'].includes(submit.status)) return bad({ action: 'status must be ok | failed | blocked', field: 'status' });
  if (!Array.isArray(submit.artifacts) || submit.artifacts.length > 1) return bad({ action: 'artifacts: at most one tree/file entry', field: 'artifacts' });
  for (const a of submit.artifacts) {
    if (!a || typeof a.path !== 'string' || !a.path || path.isAbsolute(a.path) || a.path.includes('\0') || a.path.split(/[\\/]/).includes('..') || URL_RE.test(a.path))
      return bad({ action: 'artifact path must be a relative path inside the run dir', field: 'artifacts' }, 'submit.artifacts');
  }
  if (typeof submit.summary !== 'string' || !submit.summary || submit.summary.length > 2000) return bad({ action: 'summary: 1..2000 chars', field: 'summary' });
  if (!Array.isArray(submit.evidence)) return bad({ action: 'evidence must be an array', field: 'evidence' });
  for (let i = 0; i < submit.evidence.length; i++) {
    const e = submit.evidence[i];
    if (!e || typeof e.check !== 'string' || typeof e.cmd !== 'string' || !Number.isInteger(e.exit)) return bad({ action: 'evidence entries need check/cmd/exit', field: `evidence[${i}]` }, `submit.evidence[${i}]`);
    if (URL_RE.test(e.cmd) || URL_RE.test(e.check)) return bad({ action: 'evidence must name a command or a file path, not a URL', field: `evidence[${i}].cmd` }, `submit.evidence[${i}]`);
  }
  return null;
}

function tail(s, n = 400) {
  const t = String(s ?? '').trim();
  return t.length > n ? t.slice(-n) : t;
}

function parseReply(stdout) {
  // opencode --format json: one JSON event per line; the assistant's answer is
  // the concatenation of `text` parts.
  const texts = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev?.type === 'text' && typeof ev.part?.text === 'string') texts.push(ev.part.text);
  }
  return texts.join('\n').trim();
}

function readRuntimeVersion(binary, cwd) {
  return new Promise((resolve) => {
    const p = spawn(binary, ['--version'], { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    // A --version probe must never be able to hang a stage; this timer stays
    // referenced so a fake that ignores --version still finishes at 10s.
    const t = setTimeout(() => {
      try { process.kill(-p.pid, 'SIGKILL'); } catch { /* already gone */ }
      done('unknown');
    }, 10000);
    p.stdout.on('data', (c) => (out += c));
    p.on('error', () => {
      clearTimeout(t);
      done('unknown');
    });
    p.on('close', () => {
      clearTimeout(t);
      done(out.trim().split('\n')[0] || 'unknown');
    });
  });
}

// Run one design stage with `opencode run --archived --format json`.
// No credential is read or forwarded by us: opencode uses its own state.
// resolveOnTimeout: the orchestrator owns the process-wide timeout; this hook
// only decides what to do if it fires (kill the whole process group).
export async function runDesign({ binary, task, runDir, timeoutS, resolveOnTimeout }) {
  timeoutS = Number.isInteger(timeoutS) && timeoutS > 0 ? timeoutS : DEFAULT_TIMEOUT_S;
  const startedAt = Date.now();
  const version = await readRuntimeVersion(binary, runDir);
  const prompt = buildPrompt(task);
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ['run', '--archived', '--format', 'json'], {
      cwd: runDir,
      env: { ...process.env },
      detached: true, // its own process group: a timeout kills the whole tree
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const killTree = () => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
    };
    // .unref(): the orchestrator's own timer decides the outcome (A/B tests run
    // this function with a fake binary and must not be held open by it).
    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, timeoutS * 1000);
    timer.unref?.();
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('error', (e) => {
      clearTimeout(timer);
      // The runtime binary itself could not be started: this is a crash of the
      // environment, not a classified runtime failure (A5.8: exit 2, one line).
      const err = new Error(`runtime ${binary} could not start: ${e.code ?? e.message}`);
      err.cause = e;
      err.exitCode = 2;
      err.errors = [structuredError({ code: 'E_RUNTIME_UNAVAILABLE', severity: 'block', locatable: false, path: `runtime:${binary}`, ids: ['stage:design'], fix: { action: 'install the runtime or check FORGE_RUNTIME_BIN', detail: e.code ?? e.message } })];
      reject(err);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const elapsed = Date.now() - startedAt;
      const blob = tail(stderr + '\n' + stdout);
      if (timedOut || signal) {
        return reject(structuredError({ code: 'E_RUNTIME_TIMEOUT', severity: 'block', locatable: false, path: 'runtime', ids: ['stage:design'], fix: { action: 'retry-stage', stage: 'design', timeout_s: timeoutS, signal: signal ?? null, detail: tail(stderr) } }));
      }
      if (code === 401 || /401|unauthori[sz]ed|invalid_api_key|api key/i.test(stderr)) {
        return reject(structuredError({ code: 'E_RUNTIME_AUTH', severity: 'block', locatable: false, path: 'runtime', ids: ['stage:design'], fix: { action: 'ask-credential-holder', runtime: 'opencode', detail: tail(stderr) } }));
      }
      if (/quota|rate.?limit|429|insufficient/i.test(stderr)) {
        return reject(structuredError({ code: 'E_RUNTIME_QUOTA', severity: 'block', locatable: false, path: 'runtime', ids: ['stage:design'], fix: { action: 'stop; do not auto-resume', detail: tail(stderr) } }));
      }
      if (code !== 0) {
        return reject(structuredError({ code: 'E_RUNTIME_UNAVAILABLE', severity: 'block', locatable: false, path: 'runtime', ids: ['stage:design'], fix: { action: 'retry-stage', exit: code, detail: blob } }));
      }
      // The artifact path is relative to the project root, as the Submit contract
      // expects. plan.md is created in the run dir (the stage's cwd), so the
      // Submit names it from the root.
      const planPath = path.posix.join('.forge', 'runs', task.run_id, 'plan.md');
      const abs = path.join(runDir, 'plan.md');
      const planText = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
      const submit = buildSubmit({ reply: parseReply(stdout), planPath, planText, runtime: { name: 'opencode', version }, startedAt });
      if (!planText) submit.status = 'failed';
      resolve(submit);
    });
    child.stdin.on('error', () => { /* the child may exit before reading its input */ });
    // Same contract as fixtures/fake-runner.js: the task book arrives on stdin.
    // (Real runtimes read the prompt from stdin; a fake that parses argv[2]
    // gets the same JSON there, see test/runtime.test.js.)
    child.stdin.end(JSON.stringify(task));
  });
}
