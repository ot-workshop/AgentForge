// Flow runner: a walk over the flow's edges (design → build → verify for the
// default chain). `on` edges branch, a bounded back edge writes `flow.goto`
// and re-enters its target with the loop's iteration. The fake runner stands
// in for a real agent until M2. Every state change is written by the
// orchestrator only.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, spawn as spawnRuntime } from 'node:child_process';
import { EventWriter, readEvents } from './eventlog.js';
import { acquireRunLock } from './lock.js';
import { sha256Hex } from './chain.js';
import { structuredError } from './errors.js';
import { canonicalJson } from './canonical.js';
import { parseYaml } from './yamlish.js';
import { backEdgesOfScc, validateFlow, validateP0 } from './validate.js';
import { stronglyConnectedIds } from './graph.js';

const DEFAULT_STAGES = ['design', 'build', 'verify'];
// Checker definitions live in the run dir and are read-only to the runner (A4.4).
// A fixed content makes "was it changed" a byte comparison that never depends on
// however the run dir was initialised before the stage.
const CHECKER_CONTENT = '{"checks":[],"sealed":true}\n';

// `run.start.payload.flow` and `manifest.flow.path` both hold this one value:
// the flow path relative to `rootDir` with `/` separators, so the same flow on
// another machine (or in a frozen sample) writes the same bytes. A flow outside
// `rootDir` has no such value: it is refused before the run dir is created.
export function recordFlowPath(flowPath, rootDir) {
  const abs = path.resolve(flowPath);
  const rel = path.relative(path.resolve(rootDir), abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

export async function runLinear({ rootDir, flowPath: flowInput, fake, runId, allowDrift, runtime = null, maxRuntimeCalls }) {
  const flowPath = flowInput == null ? null : path.resolve(flowInput);
  const flowRecord = flowPath == null ? null : recordFlowPath(flowPath, rootDir);
  // M2-B: a real runtime never runs the default stages. Refused here, before the
  // root check, the drift check, the lock or any event: nothing is created.
  if (runtime && flowPath == null) {
    return {
      exitCode: 1,
      runId: runId ?? null,
      beforeWrite: true,
      error: structuredError({ code: 'E_FILE_NOT_FOUND', severity: 'block', locatable: false, path: '--flow', ids: [], fix: { action: 'pass --flow <existing flow file>; the real runtime never runs the default stages' } }),
    };
  }
  if (flowPath && flowRecord === null) {
    throw {
      errors: [
        structuredError({
          code: 'E_INVALID_ARGS',
          severity: 'block',
          locatable: false,
          path: `--flow ${flowInput}`,
          ids: [],
          fix: { action: 'pass a flow inside the project root', rootDir: path.resolve(rootDir), got: flowInput },
        }),
      ],
      exitCode: 1,
    };
  }
  const { stages, blocks, doc } = loadFlow(flowPath);
  // A flow `validate` refuses is never run (#流水线:#10): an unbounded loop is
  // E_CYCLE, not an endless walk. `run` only accepts a flow the validator
  // lets through, judged the way the CLI's `validate` judges it — before the
  // run dir, the lock or any event exists.
  if (doc && flowPath) {
    const found = [...validateP0(doc, { file: flowRecord ?? flowPath })];
    // Same project root the CLI's `validate` uses: FORGE_ROOT (what `run` was
    // given) when set, else the nearest directory with `blocks/`.
    if (!found.length) {
      const projectDir = process.env.FORGE_ROOT ? path.resolve(process.env.FORGE_ROOT) : findProjectDir(path.dirname(flowPath), rootDir);
      found.push(...validateFlow(doc, { file: flowRecord ?? flowPath, p0: false, projectDir }));
    }
    if (found.length) return { exitCode: 1, runId: runId ?? null, beforeWrite: true, error: found[0] };
  }
  // M2-B: the real runtime may only replace a stage the flow actually has.
  if (runtime && !stages.includes(runtime.stage)) {
    return {
      exitCode: 1,
      runId: runId ?? null,
      beforeWrite: true,
      error: structuredError({ code: 'E_INVALID_ARGS', severity: 'block', locatable: false, path: flowRecord ?? flowPath, ids: [], fix: { action: `--runtime ${runtime.stage} needs a node with that id in the flow`, stages } }),
    };
  }
  // Hard cap on real-runtime invocations in one run (#9 b7d37ffa): the default
  // equals the number of stages; a run never auto-resumes past it.
  const quota = Number.isInteger(maxRuntimeCalls) && maxRuntimeCalls > 0 ? maxRuntimeCalls : stages.length;
  let runtimeCalls = 0;
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
      if (allowDrift && refs.drifts.length) driftAccepted = refs.drifts;
    }
  }
  // Drift accepted under --allow-drift; carried in a local so the `ref.drift`
  // event does not depend on a temporary field of `blocks` (A5.5).
  let driftAccepted = null;
  // A7.2: a fresh run id must still refuse to start when a block the flow uses
  // changed since the most recent manifest recorded it.
  // `allowDrift` only decides what to do with a detected drift (throw or record
  // `ref.drift`); detection itself must always run (A7.2/A5.5).
  if (flowPath && fs.existsSync(flowPath)) {
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
        driftAccepted = drift;
      }
    }
  }
  const lock = acquireRunLock(runDir);
  const existing = fs.existsSync(path.join(runDir, 'events.jsonl')) ? readEvents(path.join(runDir, 'events.jsonl')).events : [];
  // Any half-written tail is found from the bytes on disk; never open a temporary
  // writer here (its constructor may append a resume marker of its own).
  const _rep = existing.length ? readEvents(path.join(runDir, 'events.jsonl')).trailingPartial : false;
  const tailOk = existing.length === 0 || fs.readFileSync(path.join(runDir, 'events.jsonl'), 'utf8').endsWith('\n');
  const writer = new EventWriter(runDir, existing).open();
  const notesRun = { run_id: id, stage: null, iteration: 1, actor: { kind: 'orchestrator', name: 'forge' } };
  try {
    // A resumed run records the (re)start in the same chain instead of replacing it.
    if (existing.length) writer.append({ ...notesRun, type: 'log', payload: { severity: 'info', message: 'resumed existing run' } });
    if (!tailOk) writer.append({ ...notesRun, type: 'log', payload: { severity: 'warn', message: 'trailing partial line truncated before append' } });
    // A fresh run id with an empty run dir must start at seq 1 (A5.4).
    if (isNewRun && writer.nextSeq !== 1) writer.resetChain();
    const runStart = writer.append({ run_id: id, stage: null, actor: { kind: 'orchestrator', name: 'forge' }, type: 'run.start', payload: { flow: flowRecord, fake: fake ?? null } });
    if (driftAccepted) {
      writer.append({ run_id: id, stage: null, iteration: 1, actor: { kind: 'orchestrator', name: 'forge' }, type: 'ref.drift', payload: { drift: driftAccepted, acceptedBy: 'flag' } });
    }
    // Graph execution (#流水线:#10): the stage loop is a walk over the flow's
    // edges. Each step writes stage.start → stage.end, then picks the next edge
    // (an `on` edge named by the submit's outcome first, then a plain edge, file
    // order among equals). The two counters never derive from each other
    // (员工一号 4196b43d / 9d71bd96):
    //   gotoCount[loopId]  how often this back edge fired — `flow.goto.iteration`
    //   visitCount[stageId] how often this stage was entered — `stage.start.iteration`
    // A back edge (the validator's own rule, `backEdgesOfScc`) is judged only at
    // the moment it is taken: if the next goto would exceed max, no goto is
    // written and the target is not entered — the run ends right here, after the
    // stage.end of the turn that just finished (第 3 次不写 stage.start/stage.end).
    const graph = buildGraph(doc, stages);
    const ctxChain = new Map();
    const gotoCount = new Map();
    const visitCount = new Map();
    let cursor = graph.entry;
    let pending = null; // the edge that brought us to `cursor`, if any
    for (;;) {
      const stage = cursor;
      const visited = (visitCount.get(stage) ?? 0) + 1;
      visitCount.set(stage, visited);
      const iteration = visited;
      const prevArtifacts = pending ? (ctxChain.get(pending.from) ?? []) : [];
      const ctx = { runId: id, stage, iteration, prevArtifacts };
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
      fs.writeFileSync(checksFile, CHECKER_CONTENT);
      const checksShaBefore = sha256Hex(fs.readFileSync(checksFile));
      let res;
      if (runtime?.stage === stage && runtimeCalls + 1 <= quota) {
        runtimeCalls += 1;
        res = await invokeRuntime({ runtime, rootDir, doc, runDir, stage, iteration, prevSeqs: writer.nextSeq - 1, runId: id });
      } else if (runtime?.stage === stage) {
        // Over the cap: stop here instead of calling the runtime again.
        res = { submit: null, submitError: structuredError({ code: 'E_RUNTIME_QUOTA', severity: 'block', locatable: false, path: `runs/${id}/events.jsonl#${stage}`, ids: [`stage:${stage}`], fix: { action: 'stop; raise --max-runtime-calls only deliberately', used: runtimeCalls, limit: quota } }) };
      } else {
        res = invokeRunner({ rootDir, flowPath, fake, runDir, stage, iteration, prevSeqs: writer.nextSeq - 1, runId: id, checksFile });
      }
      let checksShaAfter = sha256Hex(fs.readFileSync(checksFile));
      const checksWritten = checksShaAfter !== checksShaBefore;
      if (checksWritten) {
        // The wall must refuse the write, not merely report it afterwards: put the
        // checker file back exactly as it was (E_PERMISSION_GAP is still recorded).
        fs.writeFileSync(checksFile, CHECKER_CONTENT);
        checksShaAfter = sha256Hex(fs.readFileSync(checksFile));
      }
      if (res.crash) {
        // Runner process died: exit 2, one stderr line, no error event (A5.8).
        writeWarnIfHalf(writer, runDir, id, stage);
        writeManifest(runDir, { runId: id, flowPath, flowRecord, blocks, status: 'crashed', runStartedAt: runStart.ts, drift: driftAccepted });
        writer.append({ run_id: id, stage, actor: { kind: 'orchestrator', name: 'forge' }, type: 'run.end', payload: { status: 'crashed' } });
        const err = new Error(res.stderr.trim().split('\n')[0] || 'runner crashed');
        err.exitCode = 2;
        throw err;
      }
      const judged = judgeSubmit({ res, checksWritten, id, stage, flowRecord });
      writer.append({
        run_id: id,
        stage,
        iteration,
        actor: { kind: 'orchestrator', name: 'forge' },
        type: 'stage.end',
        payload: { iteration, status: judged.status, submit: res.submit ?? null, ...(judged.error ? { error: judged.error } : {}) },
      });
      ctxChain.set(stage, Array.isArray(res.submit?.artifacts) ? res.submit.artifacts.filter((a) => a && typeof a.path === 'string').map((a) => a.path) : []);
      const out = graph.out.get(stage) ?? [];
      const taken = pickEdge(out, judged.status, res.submit?.status);
      if (taken) taken.edge = taken.raw;
      if (!taken) {
        // A dead end: a failed stage with nowhere to go ends the run like any
        // other failure; an ok stage stops the walk.
        if (judged.status !== 'ok') {
          writeWarnIfHalf(writer, runDir, id, stage);
          writer.append({ run_id: id, stage: null, actor: { kind: 'orchestrator', name: 'forge' }, type: 'run.end', payload: { status: 'failed' } });
          writer.sync();
          writeManifest(runDir, { runId: id, flowPath, flowRecord, blocks, status: 'failed', runStartedAt: runStart.ts, drift: driftAccepted });
          return { exitCode: 1, runId: id, error: judged.error };
        }
        // The old bare stage list has no edges: it moves on in file order.
        const next = graph.linear ? graph.nodes[graph.nodes.indexOf(stage) + 1] : null;
        if (next == null) break;
        pending = null;
        cursor = next;
        continue;
      }
      if (taken.backEdge) {
        const loopId = taken.edge.id ?? `${taken.edge.from}->${taken.edge.to}`;
        const used = gotoCount.get(loopId) ?? 0;
        const limit = Number.isInteger(taken.edge.max_iterations) && taken.edge.max_iterations > 0 ? taken.edge.max_iterations : null;
        if (limit == null) {
          // The validator refuses a back edge without a positive bound (E_LIMIT_UNBOUNDED),
          // so `run` never sees one; refuse rather than invent a bound.
          const err = structuredError({ code: 'E_LIMIT_UNBOUNDED', severity: 'block', locatable: false, path: `flows/${flowRecord}#${loopId}`, ids: [taken.edge.from, taken.edge.to], fix: { action: 'raise-limit-or-fix-loop', loop_id: loopId, max_iterations: null } });
          writeWarnIfHalf(writer, runDir, id, stage);
          writer.append({ run_id: id, stage: null, actor: { kind: 'orchestrator', name: 'forge' }, type: 'run.end', payload: { status: 'failed', code: err.code, loopId, from: taken.edge.from, to: taken.edge.to, iterations: used, fix: err.fix } });
          writer.sync();
          writeManifest(runDir, { runId: id, flowPath, flowRecord, blocks, status: 'failed', runStartedAt: runStart.ts, drift: driftAccepted });
          return { exitCode: 1, runId: id, error: err };
        }
        if (used + 1 > limit) {
          // The bound is spent: no goto, no stage.start/stage.end of a further
          // turn (314920dc / ab343c38). `on_exhausted` turns it into an ok end
          // with one info log; without it the run ends failed, rc=1.
          if (taken.edge.on_exhausted) {
            writer.append({ run_id: id, stage: null, actor: { kind: 'orchestrator', name: 'forge' }, type: 'log', payload: { severity: 'info', kind: 'loop-exhausted', loopId, iterations: used, onExhausted: String(taken.edge.on_exhausted) } });
            break;
          }
          const err = structuredError({
            code: 'E_LIMIT_UNBOUNDED',
            severity: 'block',
            locatable: false,
            path: `flows/${flowRecord}#${loopId}`,
            ids: [taken.edge.from, taken.edge.to],
            fix: { action: 'raise-limit-or-fix-loop', loop_id: loopId, max_iterations: limit },
          });
          writeWarnIfHalf(writer, runDir, id, stage);
          writer.append({ run_id: id, stage: null, actor: { kind: 'orchestrator', name: 'forge' }, type: 'run.end', payload: judgeRunEndFailed(err, used) });
          writer.sync();
          writeManifest(runDir, { runId: id, flowPath, flowRecord, blocks, status: 'failed', runStartedAt: runStart.ts, drift: driftAccepted });
          return { exitCode: 1, runId: id, error: err };
        }
        const gotoNo = used + 1;
        gotoCount.set(loopId, gotoNo);
        const checkResultId = checkResultIdOf(res.submit);
        const edgePayload = { from: taken.edge.from, to: taken.edge.to, on: taken.edge.on ?? null, ...(Number.isInteger(taken.edge.max_iterations) ? { max_iterations: taken.edge.max_iterations } : {}), ...(taken.edge.on_exhausted ? { on_exhausted: taken.edge.on_exhausted } : {}), ...(taken.edge.id ? { id: taken.edge.id } : {}) };
        writer.append({
          run_id: id,
          stage,
          iteration,
          actor: { kind: 'orchestrator', name: 'forge' },
          type: 'flow.goto',
          payload: { from: taken.edge.from, to: taken.edge.to, iteration: gotoNo, loopId, edge: edgePayload, ...(checkResultId ? { checkResultId } : {}) },
        });
        pending = taken.edge;
        cursor = taken.edge.to;
        continue;
      }
      // A plain edge: a failed stage that has somewhere to go keeps its
      // `failed` stage.end as recorded and the walk continues.
      pending = taken.edge;
      cursor = taken.edge.to;
    }
    writeWarnIfHalf(writer, runDir, id, null);
    writer.append({ run_id: id, stage: null, actor: { kind: 'orchestrator', name: 'forge' }, type: 'run.end', payload: { status: 'ok' } });
    writer.sync();
    writeManifest(runDir, { runId: id, flowPath, flowRecord, blocks, status: 'ok', runStartedAt: runStart.ts, drift: driftAccepted });
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

// The walk over a flow's edges (#流水线:#10). `doc` is the parsed flow; a flow
// given as a bare stage list (the old form) has no edges and is a chain.
// Back edges come from the validator's own rule (`backEdgesOfScc`, 第 13 条),
// so a goto is written exactly on the loops the validator let through, one
// counter per `loopId` (第 15 条).
export function buildGraph(doc, stages) {
  const nodes = Array.isArray(doc?.nodes) && doc.nodes.length ? doc.nodes.map((n) => n.id) : stages;
  const rawEdges = Array.isArray(doc?.edges) ? doc.edges.filter((e) => e && nodes.includes(e.from) && nodes.includes(e.to)) : [];
  const edges = rawEdges.map((e, index) => ({ index, from: e.from, to: e.to, raw: e }));
  const back = new Set();
  for (const scc of stronglyConnectedIds(nodes, edges)) {
    const members = new Set(scc);
    const selfLoop = edges.some((e) => e.from === e.to && members.has(e.from));
    if (scc.length < 2 && !selfLoop) continue;
    const loopEdges = edges.filter((e) => members.has(e.from) && members.has(e.to));
    const { back: found } = backEdgesOfScc(scc, loopEdges);
    for (const b of found) back.add(b.raw);
  }
  const out = new Map(nodes.map((id) => [id, []]));
  for (const e of rawEdges) {
    if (back.has(e)) e.__back = true; // a local mark on this parsed doc, never written out
    out.get(e.from).push(e);
  }
  // The flow's own entry when it has one; otherwise the first node in file order
  // that nothing points at (the old chain form has no `entry`).
  const entry = typeof doc?.entry === 'string' && out.has(doc.entry) ? doc.entry : nodes.find((id) => !rawEdges.some((e) => e.to === id)) ?? nodes[0];
  // The two counters live in `runLinear`, one per run (4196b43d): a goto's
  // number and a stage's entry number are different facts and never derive
  // from each other.
  return { nodes, out, entry, back, linear: rawEdges.length === 0 };
}

// Edge choice: a plain edge (no `on`) carries a stage that finished ok; an
// `on` edge carries the submit statuses it names. Among equals the file order
// wins, so the same flow always takes the same path.
function edgeMatches(e, status, submitStatus) {
  if (!e.on || typeof e.on !== 'object') return status === 'ok';
  if (e.on.status === 'pass') return status === 'ok' && submitStatus === 'ok';
  if (e.on.status === 'fail') return status === 'failed' && submitStatus === 'failed';
  if (e.on.status === 'error') return status === 'failed' && submitStatus !== 'failed';
  return false;
}

export function pickEdge(out, status, submitStatus) {
  const matches = out.filter((e) => edgeMatches(e, status, submitStatus));
  const conditional = matches.find((e) => e.on && typeof e.on === 'object');
  const edge = conditional ?? matches[0];
  return edge ? { edge, raw: edge, backEdge: edge.__back === true } : null;
}

// `run.end` is the one place a run ends, failed or not (69c94449). A plain
// stage failure keeps the shape it had before; an exhausted loop carries the
// loop's fields so the failure points at the counter that ran out. `iterations`
// is the number of gotos actually written (== max when the bound is spent),
// never `max` read back from the fix block (see `judgeSubmit` below).
export function judgeRunEndFailed(error, used) {
  if (error?.code === 'E_LIMIT_UNBOUNDED') {
    return { status: 'failed', code: error.code, loopId: error.fix.loop_id, from: error.ids[0], to: error.ids[1], iterations: used, fix: error.fix };
  }
  return { status: 'failed' };
}

// The stage's Submit, judged once: which `status` the stage.end records and
// which structured error goes with it (the order is the one `0957374` had).
function judgeSubmit({ res, checksWritten, id, stage, flowRecord }) {
  const ev = res.submit?.evidence;
  // A stage that reports `failed`/`blocked` is a failed stage for the walk
  // (stage.end.status and the `on: status=fail` edge both read this), as in
  // `0957374`: only an ok submit with a broken chain changes its status later.
  // A real runtime's classified error (E_RUNTIME_*, E_SCHEMA_INVALID from its
  // Submit check) is recorded as-is instead of being re-wrapped.
  if (res.submitError) return { status: 'failed', error: res.submitError };
  if (!res.illegalEvent && (!Array.isArray(ev) || ev.length === 0)) {
    return {
      status: 'failed',
      error: structuredError({
        code: 'E_MISSING_EVIDENCE',
        severity: 'block',
        locatable: false,
        path: `runs/${id}/events.jsonl#${stage}.submit.evidence`,
        ids: [`stage:${stage}`],
        fix: { action: 'attach evidence entries: {check, cmd, exit}' },
      }),
    };
  }
  if (res.illegalEvent) {
    return {
      status: 'failed',
      error: structuredError({
        code: 'E_ILLEGAL_STAGE_WRITE',
        severity: 'block',
        locatable: false,
        path: `flows/${flowRecord}#${stage}`,
        ids: [`stage:${stage}`],
        fix: { action: 'events must be written through the orchestrator, not by the runner' },
      }),
    };
  }
  if (checksWritten) {
    // Judgment wall: the checker file is read-only to the runner (A4.4).
    return {
      status: 'failed',
      error: structuredError({
        code: 'E_PERMISSION_GAP',
        severity: 'block',
        locatable: false,
        path: `runs/${id}/checks.lock`,
        ids: [`stage:${stage}`],
        fix: { tool: 'write_checks', requiredBy: 'runner', agentSpec: null, suggestMayNot: 'may_not 冲突' },
      }),
    };
  }
  if (res.submit.status !== 'ok') {
    return {
      status: 'failed',
      error: structuredError({
        code: 'E_STAGE_FAILED',
        severity: 'block',
        locatable: false,
        path: `runs/${id}/events.jsonl#${stage}`,
        ids: [`stage:${stage}`],
        fix: { action: 'retry-stage', hint: res.submit.next_hint ?? null },
      }),
    };
  }
  return { status: 'ok', error: null };
}

function checkResultIdOf(submit) {
  if (!submit || typeof submit !== 'object') return null;
  const body = { status: submit.status, summary: submit.summary ?? null, evidence: submit.evidence ?? [] };
  return sha256Hex(canonicalJson(body)).slice(0, 32);
}

const DEFAULT_RUNTIME_TIMEOUT_S = 120;
const RUNTIME_EVIDENCE_URL = /\b(?:https?|ftp|wss?):\/\//i;

// M2-B (#流水线:#9): run one stage on the real runtime through
// fixtures/design-runtime.js, started the way fixtures/fake-runner.js is (cwd =
// run dir, task book on stdin, one Submit JSON on stdout, the same crash
// contract: a non-zero exit without an answer is a crash, exit 2). The adapter
// is async and gets a hard timeout; its whole process group is killed on
// timeout, on adapter failure, or when the orchestrator is interrupted.
async function invokeRuntime({ runtime, rootDir, doc, runDir, stage, iteration, prevSeqs, runId }) {
  const unavailable = (detail, action = 'retry-stage') =>
    structuredError({ code: 'E_RUNTIME_UNAVAILABLE', severity: 'block', locatable: false, path: 'runtime', ids: [`stage:${stage}`], fix: { action, detail: String(detail).slice(-800) } });
  const adapter = path.join(rootDir, 'fixtures', 'design-runtime.js');
  if (!fs.existsSync(adapter)) return { submitError: unavailable('fixtures/design-runtime.js is missing', 'check out the M2-B files'), submit: null };
  const specPath = path.join(rootDir, 'agents', 'architect.yaml');
  let spec = null;
  try { spec = parseYaml(fs.readFileSync(specPath, 'utf8'), specPath); } catch { spec = null; }
  const t = spec?.limits?.timeout_s;
  const timeoutS = Number.isInteger(t) && t > 0 ? t : DEFAULT_RUNTIME_TIMEOUT_S;
  // The run id is also the run directory name and names the artifact path.
  if (path.basename(runId) !== runId) return { submitError: unavailable('run id must be a plain directory name', 'pass a run id without path separators'), submit: null };
  const node = doc?.nodes?.find((n) => n.id === stage) ?? {};
  const task = {
    v: 1,
    run_id: runId,
    stage,
    iteration,
    flow_id: doc?.id ?? null,
    request: String(node.with?.request ?? '').replace(/\{\{input\.request\}\}/g, 'the request in this task'),
    doc,
    run_dir: runDir,
    timeout_s: timeoutS,
    prev_seq: prevSeqs,
  };
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawnRuntime(process.execPath, [adapter, stage], {
      cwd: runDir,
      env: { ...process.env, FORGE_RUNTIME_BIN: runtime.bin, FORGE_RUNTIME_STAGE: stage, FORGE_RUN_ID: runId },
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const killTree = () => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, timeoutS * 1000);
    const onSignal = () => killTree();
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    const finish = (result) => {
      clearTimeout(timer);
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
      resolve(result);
    };
    child.on('error', (e) => finish({ submitError: unavailable(e.code ?? e.message, 'install the runtime or check FORGE_RUNTIME_BIN'), submit: null }));
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.stdin.on('error', () => { /* the adapter may exit before reading its input */ });
    child.stdin.end(JSON.stringify(task));
    child.on('close', (code, signal) => {
      if (timedOut) {
        return finish({ submitError: structuredError({ code: 'E_RUNTIME_TIMEOUT', severity: 'block', locatable: false, path: 'runtime', ids: [`stage:${stage}`], fix: { action: 'retry-stage or raise limits.timeout_s', stage, timeout_s: timeoutS } }), submit: null });
      }
      if (signal) return finish({ submitError: unavailable(`adapter killed by ${signal}`), submit: null });
      const start = stdout.indexOf('{');
      let submit = null;
      try { submit = JSON.parse(start >= 0 ? stdout.slice(start) : '{}'); } catch { submit = null; }
      const runtimeError = submit && submit.runtimeError && submit.runtimeError.code && submit.runtimeError.severity ? submit.runtimeError : null;
      if (runtimeError) return finish({ submitError: runtimeError, submit: null });
      if (code === 3) return finish({ submitError: unavailable(stderr.trim() || 'adapter refused the stage', 'check the task book'), submit: null });
      if (!submit || typeof submit !== 'object' || !('status' in submit)) {
        if (code !== 0) return finish({ crash: true, stderr: stderr.trim().split('\n')[0] || `runtime exited ${code}` });
        return finish({ submitError: structuredError({ code: 'E_SCHEMA_INVALID', severity: 'block', locatable: false, path: 'submit', ids: [`stage:${stage}`], fix: { action: 'emit a Submit JSON object with status/artifacts/summary/evidence', detail: String(stderr).slice(-400) } }), submit: null });
      }
      const bad = checkRuntimeSubmit(submit, stage);
      if (bad) return finish({ submitError: bad, submit: null });
      submit.runtime = { ...(submit.runtime ?? {}), duration_ms: Date.now() - started };
      finish({ submit });
    });
  });
}

// The rules the fake runner's Submit already meets, plus the one rule for real
// runtimes (#9 b7d37ffa): evidence names a command or a path, never a URL.
function checkRuntimeSubmit(submit, stage) {
  const bad = (fix, where = 'submit') =>
    structuredError({ code: 'E_SCHEMA_INVALID', severity: 'block', locatable: false, path: where, ids: [`stage:${stage}`], fix });
  if (!['ok', 'failed', 'blocked'].includes(submit.status)) return bad({ action: 'status must be ok | failed | blocked', field: 'status' });
  if (!Array.isArray(submit.artifacts) || submit.artifacts.length > 1) return bad({ action: 'artifacts: at most one tree/file entry', field: 'artifacts' });
  for (const a of submit.artifacts) {
    if (!a || typeof a.path !== 'string' || !a.path || path.isAbsolute(a.path) || a.path.includes('\0') || a.path.split(/[\\/]/).includes('..') || RUNTIME_EVIDENCE_URL.test(a.path))
      return bad({ action: 'artifact path must be a relative path inside the run dir', field: 'artifacts' }, 'submit.artifacts');
  }
  if (typeof submit.summary !== 'string' || !submit.summary || submit.summary.length > 2000) return bad({ action: 'summary: 1..2000 chars', field: 'summary' });
  if (!Array.isArray(submit.evidence)) return bad({ action: 'evidence must be an array', field: 'evidence' });
  for (let i = 0; i < submit.evidence.length; i++) {
    const e = submit.evidence[i];
    if (!e || typeof e.check !== 'string' || typeof e.cmd !== 'string' || !Number.isInteger(e.exit)) return bad({ action: 'evidence entries need check/cmd/exit', field: `evidence[${i}]` }, `submit.evidence[${i}]`);
    if (RUNTIME_EVIDENCE_URL.test(e.cmd) || RUNTIME_EVIDENCE_URL.test(e.check)) return bad({ action: 'evidence must name a command or a file path, not a URL', field: `evidence[${i}].cmd` }, `submit.evidence[${i}]`);
  }
  return null;
}

// The nearest directory that has `blocks/`, starting at the flow's directory
// and falling back to the run's root — the same rule the CLI's `validate`
// uses to decide which block files a flow is judged against.
function findProjectDir(start, fallback) {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, 'blocks'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return path.resolve(fallback);
    dir = up;
  }
}

function loadFlow(flowPath) {
  if (!flowPath || !fs.existsSync(flowPath)) return { stages: DEFAULT_STAGES, blocks: {}, doc: null };
  const doc = parseYaml(fs.readFileSync(flowPath, 'utf8'), flowPath);
  if (Array.isArray(doc)) return { stages: doc, blocks: {}, doc: null };
  const nodes = doc.nodes ?? [];
  const blocksRoot = path.join(path.dirname(flowPath), '..', 'blocks');
  const blocks = {};
  for (const n of nodes) {
    const m = /^block:([a-z][a-z0-9-]*)@([0-9]+)$/.exec(n.uses ?? '');
    if (!m) continue;
    const f = path.join(blocksRoot, m[1], `v${m[2]}.yaml`);
    blocks[n.id] = { ref: n.uses, sha256: fs.existsSync(f) ? sha256Hex(fs.readFileSync(f)) : null, file: f, with: n.with ?? {} };
  }
  return { stages: nodes.map((n) => n.id), blocks, doc };
}

function writeManifest(runDir, { runId, flowPath, flowRecord, blocks, status, runStartedAt, drift }) {
  const file = path.join(runDir, 'manifest.json');
  const prev = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const refs = { ...(prev.blocks ?? {}), ...blocks };
  const manifest = {
    run_id: runId,
    // Must equal the `run.start` event ts of this run (A2.4f); a resumed run keeps its first one.
    run_started_at: prev.run_started_at ?? runStartedAt ?? new Date().toISOString(),
    flow: flowPath ? { path: flowRecord, sha256: fs.existsSync(flowPath) ? sha256Hex(fs.readFileSync(flowPath)) : null } : null,
    // order is fixed: content sha256 -> validator version -> validation result
    blocks: Object.fromEntries(Object.entries(refs).map(([id, b]) => [id, { ref: b.ref, sha256: b.sha256, validator: VALIDATOR_VERSION, result: b.result ?? 'ok' }])),
    status,
    // The drift record is a projection of the `ref.drift` event, never a second fact.
    ...(drift ? { drift: { acceptedBy: 'flag', refs: drift } } : {}),
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
