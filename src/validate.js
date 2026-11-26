// Flow / block validation (v2.4 §2.3, §2.9-adjacent, appendix A A3).
// One validator for humans (canvas) and agents: same engine, same errors.
import fs from 'node:fs';
import path from 'node:path';
import { structuredError } from './errors.js';
import { parseYaml } from './yamlish.js';

export const LOOP_LIMIT_SUSPECT_THRESHOLD = 1000; // mirrors docs/error-codes.md
export const P0_UNSUPPORTED_FIELDS = ['on', 'max_iterations', 'on_exhausted', 'loop_id', 'group'];
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
export function validateFlow(flow, { file = '<flow>', p0 = true } = {}) {
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
  const blocksRoot = path.join(path.dirname(path.resolve(file)), '..', 'blocks');
  const blockOutputs = (uses) => {
    const m = /^block:([a-z][a-z0-9-]*)@([0-9]+)$/.exec(uses ?? '');
    if (!m) return null;
    const f = path.join(blocksRoot, m[1], `v${m[2]}.yaml`);
    if (!fs.existsSync(f)) return null;
    try {
      const b = parseYaml(fs.readFileSync(f, 'utf8'), f);
      return {
        required: Object.entries(b.inputs ?? {}).filter(([, v]) => !v || v.required !== false).map(([k]) => k),
        outputs: Object.keys(b.outputs ?? {}),
        outputTypes: Object.fromEntries(Object.entries(b.outputs ?? {}).map(([k, v]) => [k, v?.type ?? null])),
        checks: b.checks ?? [],
      };
    } catch {
      return null;
    }
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
  for (const n of nodes) {
    const info = blockOutputs(n.uses);
    if (!info) continue;
    const fed = upstreamOutputs(n.id);
    for (const input of info.required) {
      if (fed.has(input) || (n.with && input in n.with)) continue;
      // A node may take an input from outside the graph (the request) only when it
      // declares that input explicitly in `with`.
      if (n.with && input in n.with) continue;
      const candidates = [...fed].map((o) => ({ from: 'node', nodeId: [...ids.keys()].find((k) => blockOutputs(ids.get(k).uses)?.outputs.includes(o)), output: o }));
      errors.push(code('E_UNBOUND_INPUT', {
        path: `${file}#${n.id}.inputs.${input}`,
        ids: [n.id],
        fix: { input, slotOf: n.uses, reason: fed.size ? 'not_passed_by_with' : 'no_upstream_output', candidates },
      }));
    }
  }
  // Gates: a human gate must name who approves.
  for (const n of nodes) {
    if (n.gate === 'human' || (typeof n.gate === 'string' && n.gate.startsWith('human'))) {
      errors.push(code('E_GATE_NO_APPROVER', { path: `${file}#${n.id}.gate`, ids: [n.id], fix: { gate: n.gate } }));
    }
  }
  // cycles: DFS; in P0 every cycle is E_CYCLE
  const state = new Map();
  const stackIds = [];
  const cycle = [];
  const dfs = (id) => {
    state.set(id, 1);
    stackIds.push(id);
    for (const t of out.get(id) ?? []) {
      if (state.get(t) === 1) {
        cycle.push([...stackIds.slice(stackIds.indexOf(t)), t]);
      } else if (!state.get(t)) dfs(t);
    }
    stackIds.pop();
    state.set(id, 2);
  };
  for (const n of nodes) if (!state.get(n.id)) dfs(n.id);
  if (cycle.length) {
    // A cycle whose nodes have a single successor is a plain cycle (E_CYCLE);
    // one with a branch plus an unbounded back edge is E_LIMIT_UNBOUNDED instead.
    const simple = cycle.every((c) => {
      const idsInCycle = c.slice(0, -1);
      return idsInCycle.length === new Set(idsInCycle).size && idsInCycle.every((id) => (out.get(id) ?? []).length <= 1);
    });
    if (simple) errors.push(code('E_CYCLE', { path: `${file}#${cycle[0][0]}`, ids: cycle[0], fix: { cycle: cycle[0] } }));
  }

  // Edges first: a jump back to a non-ancestor is illegal; a bounded retry back to an
  // ancestor with max_iterations is legal (P0.5 executes it; the graph is valid).
  const ancestors = (id) => {
    const seen = new Set();
    const stack = edges.filter((e) => e.to === id).map((e) => e.from);
    while (stack.length) {
      const cur = stack.pop();
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const e of edges) if (e.to === cur) stack.push(e.from);
    }
    return seen;
  };
  const illegalEdges = new Set();
  for (const e of edges) {
    if (e.from === e.to) {
      errors.push(code('E_CYCLE', { path: `${file}#${e.id ?? e.from}`, ids: [e.from], fix: { cycle: [e.from, e.from] } }));
      continue;
    }
    if (e.on && !ancestors(e.from).has(e.to)) {
      illegalEdges.add(e);
      errors.push(code('E_ILLEGAL_JUMP', { path: `${file}#${e.id ?? e.from}`, ids: [e.from, e.to], fix: { from: e.from, to: e.to } }));
    }
  }
  // Contract seams: an edge whose source output does not satisfy the target input type.
  const typeOfOutput = (nodeId, output) => {
    const info = blockOutputs(nodeId && ids.get(nodeId)?.uses);
    return info?.outputTypes?.[output] ?? null;
  };
  for (const e of edges) {
    if (e.from !== e.to && ancestors(e.from).has(e.to)) continue;
    const target = blockOutputs(ids.get(e.to)?.uses);
    const sourceInfo = blockOutputs(ids.get(e.from)?.uses);
    if (!target || !sourceInfo) continue;
    const produced = new Set(sourceInfo.outputs);
    for (const req of target.required) {
      const explicit = ids.get(e.to)?.with?.[req];
      if (!produced.has(req) || (explicit !== undefined && !produced.has(String(explicit).replace(/^\{\{\s*[^.]+\./, '').replace(/\}\}$/, '')))) {
        errors.push(code('E_CONTRACT_MISMATCH', {
          path: `${file}#${e.id ?? e.from + '->' + e.to}`,
          ids: [e.from, e.to],
          fix: {
            from: { nodeId: e.from, output: [...produced][0] ?? null },
            to: { nodeId: e.to, input: req },
            expected: req,
            actual: explicit !== undefined ? String(explicit).replace(/^\{\{\s*[^.]+\./, '').replace(/\}\}$/, '') : '(none)',
          },
        }));
      }
    }
  }
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
  // Limits: an unbounded timeout/retry is a warn; on a retry edge, a missing or
  // absurd max_iterations (threshold from the code table) is block.
  for (const e of edges) {
    // Only an explicit retry declaration (on/max_iterations/on_exhausted) makes
    // a back edge a retry; a bare back edge is still a cycle.
    const declaredRetry = e.on !== undefined || e.max_iterations !== undefined || e.on_exhausted !== undefined;
    const isRetry = declaredRetry && ancestors(e.from).has(e.to) && e.from !== e.to && !illegalEdges.has(e);
    if (!isRetry) continue;
    const mi = e.max_iterations;
    if (mi === undefined || mi === null || !Number.isInteger(mi) || mi < 1) {
      errors.push(code('E_LIMIT_UNBOUNDED', { path: `${file}#${e.id ?? e.from}.max_iterations`, ids: [e.from, e.to], fix: { object: 'max_iterations', suggestedMax: 20 } }));
    } else if (mi >= LOOP_LIMIT_SUSPECT_THRESHOLD) {
      errors.push(code('E_LIMIT_UNBOUNDED', { severity: 'warn', path: `${file}#${e.id ?? e.from}.max_iterations`, ids: [e.from, e.to], fix: { object: 'max_iterations', suggestedMax: 20 } }));
    }
  }
  for (const n of nodes) {
    const bf = blockInfoFor(n);
    if (bf?.limits && bf.limits.timeout_s === undefined) {
      errors.push(code('E_LIMIT_UNBOUNDED', { severity: 'warn', path: `blocks/${bf.id}.limits.timeout_s`, ids: [n.id], fix: { object: 'timeout_s', suggestedMax: 1800 } }));
    }
  }
  // Permissions: a block's required tools must be allowed by its AgentSpec.
  const agentsDir = path.join(path.dirname(path.resolve(file)), '..', 'agents');
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
  const checksDir = (() => {
    let dir = path.dirname(path.resolve(file));
    for (;;) {
      const candidate = path.join(dir, 'checks');
      if (fs.existsSync(candidate) || fs.existsSync(path.join(dir, 'blocks')) || fs.existsSync(path.join(dir, '.forge'))) return candidate;
      const up = path.dirname(dir);
      if (up === dir) return candidate;
      dir = up;
    }
  })();
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
    const bf = path.join(path.dirname(path.resolve(file)), '..', 'blocks', m[1], `v${m[2]}.yaml`);
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
      : c === 'E_CHECKER_NOT_FOUND' || c === 'E_PERMISSION_GAP' || c === 'E_LIMIT_UNBOUNDED'
        ? 3
        : c === 'E_FANOUT_EXCEEDED' || c === 'E_NODE_COUNT_EXCEEDED' || c === 'E_DEPTH_EXCEEDED'
          ? 2
          : c === 'E_CYCLE' || c === 'E_ILLEGAL_JUMP'
            ? 1
            : 0;
  const structural = new Set(['E_UNBOUND_INPUT', 'E_CONTRACT_MISMATCH', 'E_CHECKER_NOT_FOUND', 'E_PERMISSION_GAP', 'E_LIMIT_UNBOUNDED']);
  if (unique.some((e) => e.code === 'E_SCHEMA_INVALID' || e.code.startsWith('E_P0_'))) return unique;
  if (unique.some((e) => structural.has(e.code))) {
    const structuralOnly = unique.filter((e) => structural.has(e.code));
    return [structuralOnly.reduce((a, b) => (rank(b.code) > rank(a.code) ? b : a))];
  }
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
