// Flow / block validation (v2.4 §2.3, §2.9-adjacent, appendix A A3).
// One validator for humans (canvas) and agents: same engine, same errors.
import fs from 'node:fs';
import path from 'node:path';
import { structuredError } from './errors.js';
import { parseYaml } from './yamlish.js';

// Edge-level `on` / `max_iterations` / `on_exhausted` are P0 since #流水线:#10;
// `loop_id` / `group` stay P0.5.
export const P0_UNSUPPORTED_FIELDS = ['loop_id', 'group'];
const MAX_NODES = 100;
const MAX_FANOUT = 8;
const MAX_DEPTH = 3;

const code = (c, extra) =>
  structuredError({
    code: c,
    severity: extra.severity ?? 'block',
    locatable: extra.locatable ?? true,
    path: extra.path,
    ids: extra.ids ?? [],
    fix: extra.fix ?? null,
  });

export function loadYamlFile(file) {
  try {
    return parseYaml(fs.readFileSync(file, 'utf8'), file);
  } catch (e) {
    throw {
      errors: [code('E_SCHEMA_INVALID', { locatable: false, path: file, fix: { action: 'fix-syntax', detail: e.message } })],
      exitCode: 1,
    };
  }
}

// A flow may be a plain list of stage names (linear sample) or a FlowGraph.
//   projectDir -- the ONE project directory every file-reading rule uses
//                 (`blocks/`, `agents/`, `checks/`). When the caller gives it, it
//                 is used as-is; when it does not, it is resolved once from
//                 `file` (the flow's nearest ancestor holding blocks/). It is
//                 never re-derived per rule, so a caller cannot get a mix of
//                 "some rules judged the flow's project, others the cwd's".
// ---------------------------------------------------------------------------
// Graph helpers (#流水线:#10). Edges are identified by their index in `edges`;
// node ids are compared as strings. No object is ever used as a Map/Set key.
// ---------------------------------------------------------------------------

// Is this edge a "transporting" one for contract seams (cb43dbad 第 1 条)?
function transports(e) {
  if (!e.on || typeof e.on !== 'object') return true;
  return e.on.status === 'pass';
}

// Nodes that can reach `id` by following edges backwards.
function upstreamOf(id, edges) {
  const seen = new Set();
  const stack = edges.filter((x) => x.to === id).map((x) => x.from);
  while (stack.length) {
    const cur = stack.pop();
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const x of edges) if (x.to === cur && !seen.has(x.from)) stack.push(x.from);
  }
  return seen;
}

// Tarjan SCCs over node ids; edges only contribute from/to.
function stronglyConnected(ids, edges) {
  let index = 0;
  const idx = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const out = [];
  const adj = new Map(ids.map((id) => [id, []]));
  for (const e of edges) if (adj.has(e.from)) adj.get(e.from).push(e.to);
  const visit = (v) => {
    idx.set(v, index);
    low.set(v, index);
    index += 1;
    stack.push(v);
    onStack.add(v);
    for (const w of adj.get(v) ?? []) {
      if (!idx.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v), low.get(w)));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v), idx.get(w)));
      }
    }
    if (low.get(v) === idx.get(v)) {
      const comp = [];
      for (;;) {
        const w = stack.pop();
        onStack.delete(w);
        comp.push(w);
        if (w === v) break;
      }
      out.push(comp);
    }
  };
  for (const id of ids) if (!idx.has(id)) visit(id);
  return out;
}

// Back edges, 员工一号 第 13 条 (aadab14f) + 第 14 条 (845e5c84): per SCC, in
// file order. Repeatedly take the first remaining edge carrying a positive
// integer max_iterations; if there is none, take the first edge whose removal
// leaves its *target* able to reach its *source* AND leaves no closed cycle
// among the remaining edges (one back edge per loop: two loops sharing one
// back edge cannot be bounded by its single max_iterations). The taken edge is
// a back edge and leaves the list. A self-loop is always a back edge. Loops
// that share a back edge are the runtime counter's business (第 15 条).
// `closedCyclesOf` stays for the tests that assert the shape of a loop.
export function backEdgesOfScc(scc, loopEdges) {
  const list = [...loopEdges].sort((a, b) => a.index - b.index);
  const back = [];
  const reachesOver = (from, to, live) => {
    const seen = new Set([from]);
    const stack = [from];
    while (stack.length) {
      const cur = stack.pop();
      for (const x of live) {
        if (x.from !== cur) continue;
        if (x.to === to) return true;
        if (!seen.has(x.to)) {
          seen.add(x.to);
          stack.push(x.to);
        }
      }
    }
    return false;
  };
  for (;;) {
    const bounded = list.find((e) => Number.isInteger(e.raw.max_iterations) && e.raw.max_iterations > 0);
    let picked = bounded ?? null;
    if (!picked) {
      for (const e of list) {
        const live = list.filter((x) => x !== e);
        if (e.from === e.to) { picked = e; break; }
        if (!reachesOver(e.to, e.from, live)) continue;
        picked = e;
        break;
      }
    }
    if (!picked) break;
    list.splice(list.indexOf(picked), 1);
    back.push({ ...picked, liveAfter: [...list], liveWith: [...list, picked] });
  }
  return { back };
}

// Closed loops among `edges`: a strongly connected component of >= 2 nodes, or
// a self-loop. Each loop comes back as a closed node list over real edges.
function closedCyclesOf(edges) {
  const nodes = [...new Set(edges.flatMap((e) => [e.from, e.to]))];
  const loops = [];
  for (const scc of stronglyConnected(nodes, edges)) {
    const members = new Set(scc);
    const loopEdges = edges.filter((e) => members.has(e.from) && members.has(e.to)).sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    const self = loopEdges.find((e) => e.from === e.to);
    if (scc.length < 2 && !self) continue;
    if (scc.length < 2) { loops.push([self.from, self.from]); continue; }
    const start = scc.filter((id) => loopEdges.some((e) => e.from === id)).sort()[0] ?? scc[0];
    const path = [start];
    let cur = start;
    for (let guard = 0; guard < loopEdges.length + 2; guard++) {
      const next = loopEdges.find((x) => x.from === cur && !path.slice(0, -1).some((p, i) => p === cur && path[i + 1] === x.to));
      if (!next) break;
      path.push(next.to);
      cur = next.to;
      if (cur === start) break;
    }
    loops.push(path[path.length - 1] === start ? path : [...path, start]);
  }
  return loops;
}

// `on` itself: `from` is a value source, `status` a state, an optional `check`
// names a checker (员工一号 aa5f8e59).
function onError(file, e) {
  const on = e.on;
  const where = `${file}#${e.id ?? e.from + '->' + e.to}.on`;
  const ids = [e.from, e.to];
  if (typeof on !== 'object' || Array.isArray(on)) {
    return code('E_CONTRACT_MISMATCH', { path: where, ids, fix: { edge: e.id ?? null, on: on ?? null, expected: '{from, status[, check]}' } });
  }
  if (!['pass', 'fail', 'error'].includes(on.status)) {
    return code('E_CONTRACT_MISMATCH', { path: where, ids, fix: { edge: e.id ?? null, field: 'status', expected: 'pass | fail | error', actual: on.status ?? null } });
  }
  if (on.from !== undefined && !/^(check\.(result|status)|input\.|\{\{)/.test(String(on.from))) {
    return code('E_CONTRACT_MISMATCH', { path: where, ids, fix: { edge: e.id ?? null, field: 'from', expected: 'check.result | check.status | input.*', actual: String(on.from) } });
  }
  if (on.check !== undefined && (typeof on.check !== 'string' || !on.check.trim())) {
    return code('E_CONTRACT_MISMATCH', { path: where, ids, fix: { edge: e.id ?? null, field: 'check', expected: 'a checker name', actual: on.check } });
  }
  return null;
}

// An `on.check` must name one of the target stage's checkers (aa5f8e59).
function checkRefError(file, e, target) {
  if (e.on?.check === undefined) return null;
  const checks = (target?.checks ?? []).map((c) => c?.name ?? c);
  if (checks.includes(e.on.check)) return null;
  return code('E_CONTRACT_MISMATCH', {
    path: `${file}#${e.id ?? e.from + '->' + e.to}.on`,
    ids: [e.from, e.to],
    fix: { edge: e.id ?? null, field: 'check', expected: checks, actual: e.on.check },
  });
}

// Resolve a `{{node.output}}` value against the graph (null when it is not one).
function resolveRef(ids, blockOutputs, ref) {
  const parts = String(ref).split('.');
  const nodeId = parts[0];
  const out = parts.slice(1).join('.');
  if (!ids.has(nodeId) || !out) return null;
  const info = blockOutputs(ids.get(nodeId)?.uses);
  if (!info || !info.outputs.includes(out)) return null;
  return { nodeId, out, type: info.outputTypes?.[out] ?? null };
}

export function validateFlow(flow, { file = '<flow>', p0 = true, projectDir = null } = {}) {
  if (flow == null) return [code('E_SCHEMA_INVALID', { locatable: false, path: file, fix: { action: 'fix-syntax', detail: 'empty document' } })];
  const errors = [];
  if (Array.isArray(flow)) {
    if (flow.length > MAX_NODES) errors.push(code('E_NODE_COUNT_EXCEEDED', { locatable: false, path: file, fix: { count: flow.length, max: MAX_NODES } }));
    return errors;
  }
  if (typeof flow !== 'object') return [code('E_SCHEMA_INVALID', { locatable: false, path: file, fix: { action: 'fix-syntax' } })];
  // P0 unsupported fields: exactly one error per field, pointing at it.
  const nodes = flow.nodes;
  if (!Array.isArray(nodes) || nodes.length === 0) {
    return [code('E_MISSING_ENTRY', { locatable: false, path: file, fix: { action: 'add-nodes' } })];
  }
  if (nodes.length > MAX_NODES) errors.push(code('E_NODE_COUNT_EXCEEDED', { locatable: false, path: file, fix: { count: nodes.length, max: MAX_NODES } }));
  const ids = new Map(nodes.map((n) => [n.id, n]));
  const edges = flow.edges ?? [];
  const out = new Map(nodes.map((n) => [n.id, []]));
  for (const e of edges) {
    if (!ids.has(e.from) || !ids.has(e.to)) {
      errors.push(code('E_UNKNOWN_REF', { locatable: false, path: `${file}#edges`, ids: [e.from, e.to].filter((x) => !ids.has(x)), fix: { ref: [e.from, e.to].find((x) => !ids.has(x)), refKind: 'node', available: [...ids.keys()] } }));
      continue;
    }
    out.get(e.from).push(e.to);
  }
  for (const [id, targets] of out) {
    if (targets.length > MAX_FANOUT) errors.push(code('E_FANOUT_EXCEEDED', { path: `${file}#${id}`, ids: [id], fix: { nodeId: id, fanout: targets.length, max: MAX_FANOUT } }));
  }
  if (flow.entry && !ids.has(flow.entry)) errors.push(code('E_UNKNOWN_REF', { locatable: false, path: `${file}#entry`, fix: { ref: flow.entry, refKind: 'node', available: [...ids.keys()] } }));
  const entry = flow.entry ?? nodes[0].id;
  const forwardClosure = (from, skip) => {
    const seen = new Set();
    const stack = [from];
    while (stack.length) {
      const cur = stack.pop();
      for (const e of edges) {
        if (e === skip || e.from !== cur) continue;
        if (!seen.has(e.to)) {
          seen.add(e.to);
          stack.push(e.to);
        }
      }
    }
    return seen;
  };

  // reachability
  const seen = new Set([entry]);
  const stack = [entry];
  while (stack.length) {
    const cur = stack.pop();
    for (const t of out.get(cur) ?? []) if (!seen.has(t)) { seen.add(t); stack.push(t); }
  }
  for (const n of nodes) if (!seen.has(n.id)) errors.push(code('E_UNREACHABLE', { path: `${file}#${n.id}`, ids: [n.id], fix: { nodeId: n.id } }));
  // exit
  if (!nodes.some((n) => (out.get(n.id) ?? []).length === 0)) errors.push(code('E_MISSING_EXIT', { locatable: false, path: file, fix: { action: 'add-terminal-node' } }));

  // Seams: every required input must be fed by an upstream output or by `with`.
  // Block outputs are looked up in blocks/<id>/v<n>.yaml next to the flow.
  const projectRoot = projectDir
    ? path.resolve(projectDir)
    : (() => {
        let dir = path.dirname(path.resolve(file));
        for (;;) {
          if (fs.existsSync(path.join(dir, 'blocks'))) return dir;
          const up = path.dirname(dir);
          if (up === dir) return path.dirname(path.resolve(file));
          dir = up;
        }
      })();
  const blocksRoot = path.join(projectRoot, 'blocks');
  const blockCache = new Map();
  const blockOutputs = (uses) => {
    const key = String(uses ?? '');
    if (blockCache.has(key)) return blockCache.get(key);
    let out = null;
    const m = /^block:([a-z][a-z0-9-]*)@([0-9]+)$/.exec(key);
    if (m) {
      const f = path.join(blocksRoot, m[1], `v${m[2]}.yaml`);
      try {
        const b = parseYaml(fs.readFileSync(f, 'utf8'), f);
        out = {
          required: Object.entries(b.inputs ?? {}).filter(([, v]) => !v || v.required !== false).map(([k]) => k),
          inputTypes: Object.fromEntries(Object.entries(b.inputs ?? {}).map(([k, v]) => [k, v?.type ?? null])),
          outputs: Object.keys(b.outputs ?? {}),
          outputTypes: Object.fromEntries(Object.entries(b.outputs ?? {}).map(([k, v]) => [k, v?.type ?? null])),
          checks: b.checks ?? [],
        };
      } catch {
        out = null;
      }
    }
    blockCache.set(key, out);
    return out;
  };
  const blockInfoFor = (n) => {
    const m = /^block:([a-z][a-z0-9-]*)@([0-9]+)$/.exec(n?.uses ?? '');
    if (!m) return null;
    const f = path.join(blocksRoot, m[1], `v${m[2]}.yaml`);
    if (!fs.existsSync(f)) return null;
    try {
      return parseYaml(fs.readFileSync(f, 'utf8'), f);
    } catch {
      return null;
    }
  };
  const upstreamOutputs = (id) => {
    const seenNodes = new Set();
    const stack = (edges?.filter((e) => e.to === id).map((e) => e.from)) ?? [];
    const outs = new Set();
    while (stack.length) {
      const cur = stack.pop();
      if (seenNodes.has(cur)) continue;
      seenNodes.add(cur);
      const node = ids.get(cur);
      const info = node && blockOutputs(node.uses);
      for (const o of info?.outputs ?? []) outs.add(o);
      for (const e of edges ?? []) if (e.to === cur) stack.push(e.from);
    }
    return outs;
  };
  const seamErrors = new Map(); // target node id -> first seam error
  for (const e of edges) {
    if (!transports(e)) continue;
    if (e.from !== e.to && upstreamOf(e.from, edges).has(e.to)) continue; // retry back edge
    const target = blockOutputs(ids.get(e.to)?.uses);
    const source = blockOutputs(ids.get(e.from)?.uses);
    if (!target || !source) continue;
    const produced = new Set(source.outputs);
    const withObj = (() => {
      const w = ids.get(e.to)?.with;
      return w && typeof w === 'object' ? w : null;
    })();
    for (const req of target.required) {
      if (withObj && Object.hasOwn(withObj, req)) {
        // A reference (`{{node.output}}`) is compared by type with that output;
        // a literal value means the target fills this input itself (718294d7).
        const ref = String(withObj[req]).match(/^\{\{\s*([^}]+?)\s*\}\}$/);
        if (!ref) continue;
        const got = resolveRef(ids, blockOutputs, ref[1]);
        if (!got) {
          // 员工一号 845e5c84: a {{...}} value that names no output is a seam error,
          // not a silently filled input.
          if (!seamErrors.has(e.to)) {
            const [refNode, ...rest] = ref[1].split('.');
            seamErrors.set(e.to, code('E_CONTRACT_MISMATCH', {
              path: `${file}#${e.id ?? e.from + '->' + e.to}`,
              ids: [e.from, e.to],
              fix: { from: { nodeId: refNode, output: rest.join('.') || null }, to: { nodeId: e.to, input: req }, expected: req, actual: '(unresolved)' },
            }));
          }
          continue;
        }
        const want = target.inputTypes?.[req] ?? null;
        if (!want || !got.type || want === got.type) continue;
        if (!seamErrors.has(e.to)) {
          seamErrors.set(e.to, code('E_CONTRACT_MISMATCH', {
            path: `${file}#${e.id ?? e.from + '->' + e.to}`,
            ids: [e.from, e.to],
            fix: { from: { nodeId: got.nodeId, output: got.out }, to: { nodeId: e.to, input: req }, expected: req, actual: got.out },
          }));
        }
        continue;
      }
      if (produced.has(req)) continue;
      const fromElsewhere = edges.some((x) => x !== e && x.to === e.to && blockOutputs(ids.get(x.from)?.uses)?.outputs.includes(req));
      if (fromElsewhere) continue;
      if (!seamErrors.has(e.to)) {
        seamErrors.set(e.to, code('E_CONTRACT_MISMATCH', {
          path: `${file}#${e.id ?? e.from + '->' + e.to}`,
          ids: [e.from, e.to],
          fix: { from: { nodeId: e.from, output: [...produced][0] ?? null }, to: { nodeId: e.to, input: req }, expected: req, actual: '(none)' },
        }));
      }
    }
  }
  // `on` itself (cb43dbad 第 1 条 / aa5f8e59): parseable, a known status, a value
  // source; an optional `check` must name one of the target's checkers.
  // 员工一号 845e5c84: a bad `on` on a node that already has a seam error stays
  // silent (one location per defect, cb43dbad 第 2 条). Intentional.
  for (const e of edges) {
    if (!e.on) continue;
    const bad = onError(file, e) ?? checkRefError(file, e, blockOutputs(ids.get(e.to)?.uses));
    if (bad && !seamErrors.has(e.to)) seamErrors.set(e.to, bad);
  }
  for (const n of nodes) {
    const info = blockOutputs(n.uses);
    if (!info) continue;
    const fed = upstreamOutputs(n.id);
    const withObj = n.with && typeof n.with === 'object' ? n.with : null;
    for (const input of info.required) {
      if (fed.has(input) || (withObj && Object.hasOwn(withObj, input))) continue;
      // cb43dbad 第 2 条: one location per defect -- an unbound input on a node
      // whose seam error is already reported is not listed again.
      if (seamErrors.has(n.id)) continue;
      const candidates = [...fed].map((o) => ({ from: 'node', nodeId: [...ids.keys()].find((k) => blockOutputs(ids.get(k)?.uses)?.outputs.includes(o)), output: o }));
      errors.push(code('E_UNBOUND_INPUT', {
        path: `${file}#${n.id}.inputs.${input}`,
        ids: [n.id],
        fix: { input, slotOf: n.uses, reason: fed.size ? 'not_passed_by_with' : 'no_upstream_output', candidates },
      }));
    }
  }
  for (const [target, err] of seamErrors) {
    void target;
    errors.push(err);
  }
  // Gates: a human gate must name who approves.
  for (const n of nodes) {
    if (n.gate === 'human' || (typeof n.gate === 'string' && n.gate.startsWith('human'))) {
      errors.push(code('E_GATE_NO_APPROVER', { path: `${file}#${n.id}.gate`, ids: [n.id], fix: { gate: n.gate } }));
    }
  }
  // Cycles, 员工一号 第 13 条 (aadab14f): per SCC, back edges in file order
  // (bounded first). A SCC with a back edge lacking a positive integer
  // max_iterations is one E_CYCLE; ids is a closed walk from that back edge's
  // start over the edges still in the SCC's list.
  const indexed = edges.map((e, index) => ({ index, from: e.from, to: e.to, raw: e }));
  // Node position in the file: "first in file order" must not depend on SCC walk order.
  const nodePos = new Map(nodes.map((n, i) => [n.id, i]));
  const fileOrder = (id) => nodePos.get(id) ?? Infinity;
  const sccs = stronglyConnected(nodes.map((n) => n.id), edges);
  for (const scc of sccs) {
    const members = new Set(scc);
    const selfLoop = indexed.some((e) => e.from === e.to && members.has(e.from));
    if (scc.length < 2 && !selfLoop) continue;
    const loopEdges = indexed.filter((e) => members.has(e.from) && members.has(e.to));
    const { back } = backEdgesOfScc(scc, loopEdges);
    const bad = back.find((b) => !(Number.isInteger(b.raw.max_iterations) && b.raw.max_iterations > 0));
    if (!bad) continue;
    // ids: start at the back edge's source, follow the back edge to its target,
    // then walk over the edges still in the SCC's list (`liveAfter`) back to the
    // source. Every step is an edge of the file.
    const loopEdgesAfter = edges.map((e, index) => ({ index, from: e.from, to: e.to, raw: e })).filter((x) => members.has(x.from) && members.has(x.to));
    const walk = [bad.from, bad.to];
    let cur = bad.to;
    for (let guard = 0; guard < loopEdges.length + 2 && cur !== bad.from; guard++) {
      const next = loopEdgesAfter.find((x) => x.from === cur && x !== bad && !walk.slice(1, -1).some((n, i) => n === cur && walk[i + 2] === x.to));
      if (!next) break;
      walk.push(next.to);
      cur = next.to;
    }
    const closed = walk.length >= 3 && walk[walk.length - 1] === bad.from;
    const ids = closed ? walk : [bad.from, bad.to, bad.from];
    errors.push(code('E_CYCLE', { path: `${file}#${ids[0]}`, ids, fix: { cycle: ids } }));
  }
  // E_ILLEGAL_JUMP stays doc-only in P0 (ab6557a6 第 8 条 (a)): a "back edge that
  // leaves its SCC" cannot be told apart from a legal entry edge, so it is not
  // emitted; docs/error-codes.md carries the rule for P0.5.

  // E_LIMIT_UNBOUNDED is produced by the runtime only (ca9e717d): the validator
  // output never carries it.

  // Subflow nesting: depth = longest chain of stages that call a subflow.
  const subflowDepth = (id, trail = new Set()) => {
    if (trail.has(id)) return 0;
    trail.add(id);
    const info = blockInfoFor(ids.get(id));
    const isSub = !!info?.subflow;
    const below = edges.filter((e) => e.to === id);
    if (!below.length) return isSub ? 1 : 0;
    if (!isSub) return Math.max(...below.map((e) => subflowDepth(e.from, new Set(trail))));
    return 1 + Math.max(...below.map((e) => subflowDepth(e.from, new Set(trail))));
  };
  const depth = Math.max(0, ...nodes.map((n) => subflowDepth(n.id)));
  if (depth > MAX_DEPTH) errors.push(code('E_DEPTH_EXCEEDED', { locatable: false, path: file, ids: [], fix: { depth, max: MAX_DEPTH } }));
  // Permissions: a block's required tools must be allowed by its AgentSpec.
  const agentsDir = path.join(projectRoot, 'agents');
  for (const n of nodes) {
    const bf = blockInfoFor(n);
    const am = /^([a-z][a-z0-9-]*)@([0-9]+)$/.exec(bf?.agent ?? '');
    if (!am) continue;
    const af = path.join(agentsDir, `${am[1]}.yaml`);
    if (!fs.existsSync(af)) continue;
    let agent;
    try {
      agent = parseYaml(fs.readFileSync(af, 'utf8'), af);
    } catch {
      continue;
    }
    const allowed = new Set([...(agent.tools?.allow ?? []), ...(agent.responsibilities?.may ?? [])]);
    const denied = new Set([...(agent.tools?.deny ?? []), ...(agent.responsibilities?.may_not ?? [])]);
    for (const tool of bf.requires?.tools ?? []) {
      if (denied.has(tool) || !allowed.has(tool)) {
        errors.push(code('E_PERMISSION_GAP', { path: `${file}#${n.id}`, ids: [n.id], fix: { tool, requiredBy: bf.id, agentSpec: bf.agent, suggestAddTo: denied.has(tool) ? 'may_not 冲突' : 'tools.allow' } }));
      }
    }
    const need = String(bf.requires?.network === true ? 'network' : '');
    if (need && (denied.has(need) || !allowed.has(need))) {
      errors.push(code('E_PERMISSION_GAP', { path: `${file}#${n.id}`, ids: [n.id], fix: { tool: need, requiredBy: bf.id, agentSpec: bf.agent, suggestAddTo: 'may_not 冲突' } }));
    }
  }
  // Checkers: every check must name a checker that exists under checks/.
  const checksDir = path.join(projectRoot, 'checks');
  const knownChecks = fs.existsSync(checksDir) ? fs.readdirSync(checksDir).map((f) => f.replace(/\.[^.]+$/, '')) : [];
  for (const n of nodes) {
    const bf = blockInfoFor(n);
    for (const c of bf?.checks ?? []) {
      const known = knownChecks.includes(c.name) || knownChecks.includes(path.basename(String(c.run).split(/\s+/).pop()).replace(/\.[^.]+$/, ''));
      if (knownChecks.length && !known) {
        errors.push(code('E_CHECKER_NOT_FOUND', { path: `${file}#${n.id}.checks.${c.name}`, ids: [n.id], fix: { check: c.name, searched: knownChecks } }));
      }
    }
  }
  // blocks present?
  for (const n of nodes) {
    const m = /^block:([a-z][a-z0-9-]*)@([0-9]+)$/.exec(n.uses ?? '');
    if (!m) {
      errors.push(code('E_UNKNOWN_REF', { locatable: false, path: `${file}#${n.id}.uses`, ids: [n.id], fix: { ref: n.uses ?? null, refKind: 'block', available: [] } }));
      continue;
    }
    const bf = path.join(blocksRoot, m[1], `v${m[2]}.yaml`);
    if (!fs.existsSync(bf)) {
      errors.push(code('E_UNKNOWN_REF', { locatable: false, path: `${file}#${n.id}.uses`, ids: [n.id], fix: { ref: n.uses, refKind: 'block', available: [] } }));
    }
  }
  const unique = dedupe(errors);
  if (unique.length <= 1) return unique;
  // One fixture, one root cause: keep the most specific error only.
  const rank = (c) =>
    c === 'E_EVENT_CORRUPT' || c === 'E_CHAIN_HASH_MISMATCH'
      ? 5
      : c === 'E_UNBOUND_INPUT' || c === 'E_CONTRACT_MISMATCH'
        ? 4
      : c === 'E_CHECKER_NOT_FOUND' || c === 'E_PERMISSION_GAP'
        ? 3
        : c === 'E_FANOUT_EXCEEDED' || c === 'E_NODE_COUNT_EXCEEDED' || c === 'E_DEPTH_EXCEEDED'
          ? 2
          : c === 'E_CYCLE' || c === 'E_ILLEGAL_JUMP'
            ? 1
            : 0;
  const structural = new Set(['E_UNBOUND_INPUT', 'E_CONTRACT_MISMATCH', 'E_CHECKER_NOT_FOUND', 'E_PERMISSION_GAP']);
  if (unique.some((e) => e.code === 'E_SCHEMA_INVALID' || e.code.startsWith('E_P0_'))) return unique;
  if (unique.some((e) => structural.has(e.code))) {
    // A4.4/A12.4: an illegal jump outranks a cycle (the cycle is its symptom).
    const jumps = unique.filter((e) => e.code === 'E_ILLEGAL_JUMP');
    if (jumps.length) return [jumps[0]];
    const structuralOnly = unique.filter((e) => structural.has(e.code));
    return [structuralOnly.reduce((a, b) => (rank(b.code) > rank(a.code) ? b : a))];
  }
  // Most specific only: a jump outranks the cycle it closes.
  const jump = unique.find((e) => e.code === 'E_ILLEGAL_JUMP');
  if (jump) return [jump];
  return unique;
}

function dedupe(errors) {
  const seen = new Set();
  return errors.filter((e) => {
    const k = e.code + '|' + e.path;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// P0 baseline check, separate from structure checks: using a P0.5 field is one
// answer with exactly one error, not something mixed into cycle/unbound errors.
export function validateP0(flow, { file = '<flow>' } = {}) {
  if (!flow || typeof flow !== 'object' || Array.isArray(flow)) return [];
  const errors = [];
  const scan = (obj, where, ids = []) => {
    if (!obj || typeof obj !== 'object') return;
    for (const field of P0_UNSUPPORTED_FIELDS) {
      if (field in obj) {
        errors.push(code('E_P0_UNSUPPORTED', { path: where ? `${file}#${where}.${field}` : `${file}#${field}`, ids, fix: { field, reason: 'field is P0.5' } }));
      }
    }
    if (obj.limits && typeof obj.limits === 'object') {
      for (const field of ['max_iterations', 'on_exhausted']) {
        if (field in obj.limits) {
          errors.push(code('E_P0_UNSUPPORTED', { path: `${file}#${where ? where + '.' : ''}limits.${field}`, ids, fix: { field, reason: 'field is P0.5' } }));
        }
      }
    }
  };
  scan(flow, '');
  for (const n of flow.nodes ?? []) scan(n, String(n?.id ?? ''), n?.id ? [n.id] : []);
  for (const e of flow.edges ?? []) scan(e, e?.id ? String(e.id) : '', e?.from && e?.to ? [e.from, e.to] : []);
  return errors;
}

export function findProjectRoot(start = process.cwd()) {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.forge'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return path.resolve(start);
    dir = up;
  }
}
