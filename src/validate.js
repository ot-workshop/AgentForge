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
  if (p0) {
    // The field may sit anywhere it is meaningful: at the top level, on a node,
    // on an edge, or under a node's limits. One error per field, path names it.
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
    if (errors.length) return errors;
  }
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
  if (cycle.length) errors.push(code('E_CYCLE', { path: `${file}#${cycle[0][0]}`, ids: cycle[0], fix: { cycle: cycle[0] } }));
  // blocks present?
  for (const n of nodes) {
    const m = /^block:([a-z][a-z0-9-]*)@([0-9]+)$/.exec(n.uses ?? '');
    if (!m) {
      errors.push(code('E_UNKNOWN_REF', { locatable: false, path: `${file}#${n.id}.uses`, ids: [n.id], fix: { ref: n.uses ?? null, refKind: 'block', available: [] } }));
    }
  }
  return dedupe(errors);
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

export function findProjectRoot(start = process.cwd()) {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.forge'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return path.resolve(start);
    dir = up;
  }
}
