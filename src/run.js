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
import { parseYaml } from './yamlish.js';

const DEFAULT_STAGES = ['design', 'build', 'verify'];

export async function runLinear({ rootDir, flowPath, fake, runId, allowDrift }) {
  const { stages, blocks } = loadFlow(flowPath);
  const runsDir = path.join(rootDir, '.forge', 'runs');
  fs.mkdirSync(runsDir, { recursive: true });
  const id = runId ?? new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14) + '-' + Math.random().toString(16).slice(2, 6);
  const runDir = path.join(runsDir, id);
  const isNewRun = !fs.existsSync(runDir);
  if (isNewRun) fs.mkdirSync(runDir, { recursive: true });

  // Drift check before anything is written to the run: a refused start leaves
  // no event and no repair behind (A7.2). Running this before the writer opens
  // also avoids truncating a half line on a start that will be refused.
  {
    const prior = fs.existsSync(path.join(runDir, 'manifest.json')) ? JSON.parse(fs.readFileSync(path.join(runDir, 'manifest.json'), 'utf8')) : null;
    if (flowPath && fs.existsSync(flowPath) && prior) {
      const { checkRefs } = await import('./refs.js');
      const refs = checkRefs({ rootDir, runId: id });
      if (!refs.ok && !allowDrift) throw { errors: refs.errors, exitCode: 1 };
      if (allowDrift && refs.drifts.length) blocks.driftAccepted = refs.drifts;
    }
  }
  // A7.2: a fresh run id must still refuse to start when a block the flow uses
  // changed since the most recent manifest recorded it.
  if (flowPath && fs.existsSync(flowPath) && !allowDrift) {
    let latest = null;
    let latestAt = '';
    for (const rid of fs.readdirSync(runsDir)) {
      const mf = path.join(runsDir, rid, 'manifest.json');
      if (!fs.existsSync(mf)) continue;
      try {
        const j = JSON.parse(fs.readFileSync(mf, 'utf8'));
        if (path.resolve(j.flow?.path ?? '') !== path.resolve(flowPath)) continue;
        const at = String(j.run_started_at ?? '');
        if (at > latestAt) {
          latestAt = at;
          latest = j;
        }
      } catch {
        /* an unreadable old manifest cannot be used as evidence */
      }
    }
    if (latest) {
      const blocksRoot = path.join(path.dirname(flowPath), '..', 'blocks');
      const drift = [];
      for (const [nodeId, rec] of Object.entries(latest.blocks ?? {})) {
        const m = /^block:([a-z][a-z0-9-]*)@([0-9]+)$/.exec(rec.ref ?? '');
        if (!m) continue;
        const bf = path.join(blocksRoot, m[1], `v${m[2]}.yaml`);
        const actual = fs.existsSync(bf) ? sha256Hex(fs.readFileSync(bf)) : null;
        const current = blocks[nodeId];
        // `blocks` here is the freshly loaded flow: it carries the *current* sha, so
        // the comparison must be against the recorded sha, never against it.
        const recordedOnly = rec.sha256;
        if (actual !== recordedOnly) drift.push({ nodeId, ref: rec.ref, recordedSha256: recordedOnly, actualSha256: actual });
      }
      if (drift.length) {
        const err = {
          errors: drift.map((d) =>
            structuredError({
              code: 'E_BLOCK_CONTENT_DRIFT',
              severity: 'block',
              locatable: false,
              path: `blocks/${d.ref.slice(6).split('@')[0]}/v${d.ref.split('@')[1]}.yaml`,
              ids: [d.ref],
              fix: { action: 'review the edit, then rerun with --allow-drift or restore the recorded content', recordedSha256: d.recordedSha256, actualSha256: d.actualSha256 },
            }),
          ),
          exitCode: 1,
        };
        if (!allowDrift) {
          err.beforeWrite = true;
          throw err;
        }
        blocks.driftAccepted = drift;
      }
    }
  }
  const lock = acquireRunLock(runDir);
  const existing = fs.existsSync(path.join(runDir, 'events.jsonl')) ? readEvents(path.join(runDir, 'events.jsonl')).events : [];
  const _w0 = new EventWriter(runDir, existing).open();
  const _rep = _w0.repairTrailingPartial();
  _w0.close();
  const tailOk = existing.length > 0 && fs.readFileSync(path.join(runDir, 'events.jsonl'), 'utf8').endsWith('\n');
  const writer = new EventWriter(runDir, existing).open();
  const notesRun = { run_id: id, stage: null, iteration: 1, actor: { kind: 'orchestrator', name: 'forge' } };
  // A resumed run records the (re)start in the same chain instead of replacing it.
  if (existing.length) writer.append({ ...notesRun, type: 'log', payload: { severity: 'info', message: 'resumed existing run' } });
  try {
    if (!tailOk) writer.append({ ...notesRun, type: 'log', payload: { severity: 'warn', message: 'trailing partial line truncated before append' } });
    writer.append({ run_id: id, stage: null, actor: { kind: 'orchestrator', name: 'forge' }, type: 'run.start', payload: { flow: flowPath ?? null, fake: fake ?? null } });
    if (blocks.driftAccepted) {
      writer.append({ run_id: id, stage: null, iteration: 1, actor: { kind: 'orchestrator', name: 'forge' }, type: 'ref.drift', payload: { drift: blocks.driftAccepted, acceptedBy: 'flag' } });
      delete blocks.driftAccepted;
    }
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
      const checksFile = path.join(runDir, 'checks.lock');
      fs.writeFileSync(checksFile, JSON.stringify({ stage, iteration }) + '\n');
      const checksShaBefore = sha256Hex(fs.readFileSync(checksFile));
      const res = invokeRunner({ rootDir, flowPath, fake, runDir, stage, iteration, prevSeqs: writer.nextSeq - 1, runId: id, checksFile });
      const checksShaAfter = sha256Hex(fs.readFileSync(checksFile));
      if (res.crash) {
        // Runner process died: exit 2, one stderr line, no error event (A5.8).
        writeWarnIfHalf(writer, runDir, id, stage);
        writeManifest(runDir, { runId: id, flowPath, blocks, status: 'crashed' });
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
      } else if (res.illegalEvent) {
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
      } else if (checksShaBefore !== checksShaAfter) {
        // Judgment wall: the checker file is read-only to the runner (A4.4).
        status = 'failed';
        error = structuredError({
          code: 'E_PERMISSION_GAP',
          severity: 'block',
          locatable: false,
          path: `runs/${id}/checks.lock`,
          ids: [`stage:${stage}`],
          fix: { tool: 'write_checks', requiredBy: 'runner', agentSpec: null, suggestAddTo: 'may_not 冲突' },
        });
      } else if (status === 'ok' && res.submit.status !== 'ok') {
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
        writeWarnIfHalf(writer, runDir, id, stage);
        writer.append({ run_id: id, stage: null, actor: { kind: 'orchestrator', name: 'forge' }, type: 'run.end', payload: { status: 'failed' } });
        writer.sync();
        writeManifest(runDir, { runId: id, flowPath, blocks, status: 'failed' });
        return { exitCode: 1, runId: id, error };
      }
    }
    writeWarnIfHalf(writer, runDir, id, null);
    writer.append({ run_id: id, stage: null, actor: { kind: 'orchestrator', name: 'forge' }, type: 'run.end', payload: { status: 'ok' } });
    writer.sync();
    writeManifest(runDir, { runId: id, flowPath, blocks, status: 'ok' });
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

function loadFlow(flowPath) {
  if (!flowPath || !fs.existsSync(flowPath)) return { stages: DEFAULT_STAGES, blocks: {} };
  const doc = parseYaml(fs.readFileSync(flowPath, 'utf8'), flowPath);
  if (Array.isArray(doc)) return { stages: doc, blocks: {} };
  const nodes = doc.nodes ?? [];
  const blocksRoot = path.join(path.dirname(flowPath), '..', 'blocks');
  const blocks = {};
  for (const n of nodes) {
    const m = /^block:([a-z][a-z0-9-]*)@([0-9]+)$/.exec(n.uses ?? '');
    if (!m) continue;
    const f = path.join(blocksRoot, m[1], `v${m[2]}.yaml`);
    blocks[n.id] = { ref: n.uses, sha256: fs.existsSync(f) ? sha256Hex(fs.readFileSync(f)) : null, file: f, with: n.with ?? {} };
  }
  return { stages: nodes.map((n) => n.id), blocks };
}

function writeManifest(runDir, { runId, flowPath, blocks, status }) {
  const file = path.join(runDir, 'manifest.json');
  const prev = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const refs = { ...(prev.blocks ?? {}), ...blocks };
  const manifest = {
    run_id: runId,
    run_started_at: prev.run_started_at ?? new Date().toISOString(),
    flow: flowPath ? { path: flowPath, sha256: fs.existsSync(flowPath) ? sha256Hex(fs.readFileSync(flowPath)) : null } : null,
    // order is fixed: content sha256 -> validator version -> validation result
    blocks: Object.fromEntries(Object.entries(refs).map(([id, b]) => [id, { ref: b.ref, sha256: b.sha256, validator: VALIDATOR_VERSION, result: b.result ?? 'ok' }])),
    status,
  };
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

const VALIDATOR_VERSION = 'forge-protocol-v1';

function writeContext(runDir, stage, iteration, ctx) {
  const dir = path.join(runDir, 'context');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${stage}@${iteration}.json`);
  const body = canonicalJson(ctx);
  fs.writeFileSync(file, body + '\n');
  return sha256Hex(body + '\n');
}

function invokeRunner({ rootDir, flowPath, fake, runDir, stage, iteration, prevSeqs, checksFile }) {
  const script = path.join(rootDir, 'fixtures', 'fake-runner.js');
  if (!fs.existsSync(script)) {
    return { submit: { v: 1, status: 'ok', artifacts: [], summary: `stub ${stage}`, evidence: [{ check: 'stub', cmd: 'noop', exit: 0 }] } };
  }
  const res = spawnSync(process.execPath, [script, stage], {
    cwd: runDir,
    env: { ...process.env, FORGE_FAKE: fake ?? '1', FORGE_STAGE: stage, FORGE_ITERATION: String(iteration), FORGE_EVENTS: path.join(runDir, 'events.jsonl'), FORGE_CHECKS_FILE: checksFile, FORGE_PREV_SEQ: String(prevSeqs) },
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

// Forge roots never ship a half-written events.jsonl (A5.9). Runs here are
// short-lived, so the tail is checked at the end of each append instead of
// waiting for the next one; a truncation is reported as a warn event.
function writeWarnIfHalf(writer, runDir, runId, stage) {
  const repaired = ensureTrailingNewline(writer, runId);
  if (!repaired) return;
  writer.append({ run_id: runId, stage, iteration: 1, actor: { kind: 'orchestrator', name: 'forge' }, type: 'log', payload: { severity: 'warn', message: 'trailing partial line truncated before append' } });
}

function ensureTrailingNewline(writer, runId) {
  const file = writer.file;
  const buf = fs.readFileSync(file);
  if (!buf.length || buf[buf.length - 1] === 0x0a) return false;
  fs.truncateSync(file, buf.lastIndexOf(0x0a) + 1);
  writer.sync();
  return true;
}
