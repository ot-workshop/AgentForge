// The ONE projection implementation (v2.4 §2.2, A1.1/A1.3).
// Both `replay` (full) and `incremental --since N` go through project();
// the only difference is the filter, and there is exactly one filter:
// seq > since. Nothing else may inspect or reshape events.
export const PROJECTION_MODULE = 'src/project.js';

export function* project(events, since = 0) {
  for (const ev of events) {
    if (ev.seq > since) yield projectEvent(ev);
  }
}

// projectEvent is the only place an event becomes a projected item.
function projectEvent(ev) {
  return {
    seq: ev.seq,
    ts: ev.ts,
    run_id: ev.run_id,
    stage: ev.stage,
    iteration: ev.iteration ?? 1,
    type: ev.type,
    actor: ev.actor,
    payload: ev.payload ?? {},
    prev: ev.prev,
    hash: ev.hash,
  };
}

export function replayJsonl(events, since = 0) {
  const out = [];
  for (const item of project(events, since)) out.push(JSON.stringify(item));
  return out.join('\n') + (out.length ? '\n' : '');
}

// Live state keyed by (stage, iteration) (v2.4 §3.3 / A9.1 sub-assertion).
export function snapshot(events) {
  const runs = new Map();
  for (const item of project(events, 0)) {
    let run = runs.get(item.run_id);
    if (!run) {
      run = { run_id: item.run_id, stages: [], lastSeq: 0 };
      runs.set(item.run_id, run);
    }
    run.lastSeq = item.seq;
    if (!item.stage) continue;
    const key = `${item.stage}@${item.iteration}`;
    let cell = run.stages.find((s) => s.key === key);
    if (!cell) {
      cell = { key, stage: item.stage, iteration: item.iteration, status: 'pending', lastSeq: 0 };
      run.stages.push(cell);
    }
    cell.lastSeq = item.seq;
    if (item.type === 'stage.start') cell.status = 'running';
    if (item.type === 'stage.end') cell.status = item.payload?.status ?? 'ended';
  }
  return { runs: [...runs.values()] };
}
