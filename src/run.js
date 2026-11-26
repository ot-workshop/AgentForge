// Minimal linear-flow runner: design → build → verify.
// Stages run sequentially from a stage list; the fake runner stands in for a
// real agent until M2. Every state change is written by the orchestrator only.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { EventWriter, readEvents } from './eventlog.js';
import { acquireRunLock } from './lock.js';
import { sha256Hex } from './chain.js';
import { structuredError } from './errors.js';
import { canonicalJson } from './canonical.js';

const DEFAULT_STAGES = ['design', 'build', 'verify'];

export function runLinear({ rootDir, flowPath, fake, runId, allowDrift }) {
  const stages = loadStages(flowPath);
  const runsDir = path.join(rootDir, '.forge', 'runs');
  fs.mkdirSync(runsDir, { recursive: true });
  const id = runId ?? new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14) + '-' + Math.random().toString(16).slice(2, 6);
  const runDir = path.join(runsDir, id);
  fs.mkdirSync(runDir, { recursive: true });

  const lock = acquireRunLock(runDir);
  const writer = new EventWriter(runDir, []).open();
  try {
    writer.append({ run_id: id, stage: null, actor: { kind: 'orchestrator', name: 'forge' }, type: 'run.start', payload: { flow: flowPath ?? null, fake: fake ?? null } });
    for (const stage of stages) {
      const iteration = 1;
      const ctx = { runId: id, stage, iteration, prevArtifacts: [] };
      const contextSha = writeContext(runDir, stage, iteration, ctx);
      writer.append({
        run_id: id,
        stage,
        iteration,
        actor: { kind: 'orchestrator', name: 'forge' },
        type: 'stage.start',
        payload: { iteration, inputs: [], contextSha256: contextSha },
      });
      const res = invokeRunner({ rootDir, flowPath, fake, runDir, stage, iteration });
      if (res.crash) {
        // Runner process died: exit 2, one stderr line, no error event (A5.8).
        writer.append({ run_id: id, stage, actor: { kind: 'orchestrator', name: 'forge' }, type: 'run.end', payload: { status: 'crashed' } });
        const err = new Error(res.stderr.trim().split('\n')[0] || 'runner crashed');
        err.exitCode = 2;
        throw err;
      }
      let status = 'ok';
      let error = null;
      const ev = res.submit?.evidence;
      if (!res.illegalEvent && !res.submitError && (!Array.isArray(ev) || ev.length === 0)) {
        status = 'failed';
        error = structuredError({
          code: 'E_MISSING_EVIDENCE',
          severity: 'block',
          locatable: false,
          path: `runs/${id}/events.jsonl#${stage}.submit.evidence`,
          ids: [`stage:${stage}`],
          fix: { action: 'attach evidence entries: {check, cmd, exit}' },
        });
      }
      if (res.illegalEvent) {
        status = 'failed';
        error = structuredError({
          code: 'E_ILLEGAL_STAGE_WRITE',
          severity: 'block',
          locatable: false,
          path: `flows/${flowPath}#${stage}`,
          ids: [`stage:${stage}`],
          fix: { action: 'events must be written through the orchestrator, not by the runner' },
        });
      } else if (res.submitError) {
        status = 'failed';
        error = res.submitError;
      } else if (status === 'failed') {
        /* evidence wall already set the error */
      } else if (res.submit.status !== 'ok') {
        status = res.submit.status;
        error = structuredError({
          code: 'E_STAGE_FAILED',
          severity: 'block',
          locatable: false,
          path: `runs/${id}/events.jsonl#${stage}`,
          ids: [`stage:${stage}`],
          fix: { action: 'retry-stage', hint: res.submit.next_hint ?? null },
        });
      }
      writer.append({
        run_id: id,
        stage,
        iteration,
        actor: { kind: 'orchestrator', name: 'forge' },
        type: 'stage.end',
        payload: { iteration, status, submit: res.submit ?? null, ...(error ? { error } : {}) },
      });
      if (status !== 'ok') {
        writer.append({ run_id: id, stage: null, actor: { kind: 'orchestrator', name: 'forge' }, type: 'run.end', payload: { status: 'failed' } });
        writer.sync();
        return { exitCode: 1, runId: id, error };
      }
    }
    writer.append({ run_id: id, stage: null, actor: { kind: 'orchestrator', name: 'forge' }, type: 'run.end', payload: { status: 'ok' } });
    writer.sync();
    return { exitCode: 0, runId: id };
  } finally {
    writer.close();
    if (writer.repairedPartial) {
      // The repair happened before any event of this run was appended; record
      // it as a warn so the truncation is visible (A5.9).
      const w = new EventWriter(runDir, readEvents(path.join(runDir, 'events.jsonl')).events).open();
      try {
        w.append({ run_id: id, stage: null, actor: { kind: 'orchestrator', name: 'forge' }, type: 'log', payload: { severity: 'warn', message: 'trailing partial line truncated before append' } });
        w.sync();
      } finally {
        w.close();
      }
    }
    lock.release();
  }
}

function loadStages(flowPath) {
  if (!flowPath || !fs.existsSync(flowPath)) return DEFAULT_STAGES;
  const text = fs.readFileSync(flowPath, 'utf8');
  const names = [...text.matchAll(/^\s*-\s*(?:id:\s*)?([A-Za-z0-9_-]+)\s*$/gm)].map((m) => m[1]);
  return names.length ? names : DEFAULT_STAGES;
}

function writeContext(runDir, stage, iteration, ctx) {
  const dir = path.join(runDir, 'context');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${stage}@${iteration}.json`);
  const body = canonicalJson(ctx);
  fs.writeFileSync(file, body + '\n');
  return sha256Hex(body + '\n');
}

function invokeRunner({ rootDir, flowPath, fake, runDir, stage, iteration }) {
  const script = path.join(rootDir, 'fixtures', 'fake-runner.js');
  if (!fs.existsSync(script)) {
    return { submit: { v: 1, status: 'ok', artifacts: [], summary: `stub ${stage}`, evidence: [{ check: 'stub', cmd: 'noop', exit: 0 }] } };
  }
  const res = spawnSync(process.execPath, [script, stage], {
    cwd: runDir,
    env: { ...process.env, FORGE_FAKE: fake ?? '1', FORGE_STAGE: stage, FORGE_ITERATION: String(iteration) },
    encoding: 'utf8',
  });
  if (res.status === 2) return { crash: true, stderr: res.stderr ?? '' };
  const stdout = res.stdout ?? '';
  if (/^EVENT /m.test(stdout)) return { illegalEvent: true };
  const start = stdout.indexOf('{');
  let submit;
  try {
    submit = JSON.parse(start >= 0 ? stdout.slice(start) : '{}');
  } catch {
    submit = null;
  }
  if (!submit || typeof submit !== 'object' || !('status' in submit)) {
    return {
      submitError: structuredError({
        code: 'E_SCHEMA_INVALID',
        severity: 'block',
        locatable: false,
        path: `submit`,
        ids: [],
        fix: { action: 'emit a Submit JSON object with status/artifacts/summary/evidence' },
      }),
      submit: null,
    };
  }
  return { submit };
}
