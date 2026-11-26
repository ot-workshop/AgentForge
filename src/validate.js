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
// Options:
//   file       -- path text used as the prefix of every error's `path`
//   p0         -- apply the P0-unsupported field scan (default true)
//   projectDir -- REQUIRED: the project whose blocks/ checks/ are consulted.
//                 There is no fallback to the current working directory: a
//                 library call that forgot the project would silently judge a
//                 different project (fewer errors, looks like a pass). Missing
//                 projectDir throws a usage error the CLI turns into exit 2.
//                 A project file that will not parse is E_SCHEMA_INVALID at that
//                 file, never E_UNKNOWN_REF: "the reference is fine, the content
//                 is broken".
export function validateFlow(flow, { file = '<flow>', p0 = true, projectDir = null } = {}) {
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
  // E_ILLEGAL_JUMP is NOT emitted here. By definition a back edge u -> v has v
  // reaching u, so v is always an ancestor of u: with no bounded retry edges
  // (P0), "a back edge whose target is not an ancestor" is an empty set. The
  // code has no trigger source in P0 and is verified in P0.5 instead
  // (员工一号 57cfe581, v2.4 A12.4 [P0.5]).
  // Everything below reads project files (blocks/, checks/) through one loader,
  // so "missing" and "present but broken" stay distinguishable.
  if (!projectDir) {
    const err = new Error('validateFlow needs projectDir (the root with blocks/ and checks/); not falling back to cwd');
    err.exitCode = 2;
    throw err;
  }
  const project = new Project(projectDir);
  // blocks present, and their checks / gates / inputs resolvable?
  const contracts = new Map(); // node id -> block document, for the edge contract check
  for (const n of nodes) {
    const b = project.block(n.uses);
    if (!b.ok) {
      const bad = project.schemaError(b);
      if (bad) errors.push(bad);
      else errors.push(code('E_UNKNOWN_REF', { locatable: false, path: `${file}#${n.id}.uses`, ids: [n.id], fix: { ref: n.uses ?? null, refKind: 'block', available: project.availableBlocks() } }));
      continue;
    }
    contracts.set(n.id, b.doc);
    for (const c of b.doc.checks ?? []) {
      const name = checkName(c);
      if (!name || !project.checkerExists(name)) {
        errors.push(code('E_CHECKER_NOT_FOUND', { path: `${file}#${n.id}`, ids: [n.id], fix: { check: name, searched: project.checkerNames() } }));
      }
    }
    if (n.gate) {
      const approver = n.gate === 'human' ? n.approver ?? n.approvers ?? b.doc.approver : n.gate === 'auto' ? 'auto' : n.gate;
      if (!approver) errors.push(code('E_GATE_NO_APPROVER', { path: `${file}#${n.id}`, ids: [n.id], fix: { gate: n.gate } }));
    }
  }
  // unbound inputs: a required input is neither passed through `with` nor
  // produced by an upstream node.
  const producers = new Map(); // output name -> node ids that produce it
  for (const [id, doc] of contracts) for (const o of Object.keys(doc.outputs ?? {})) producers.set(o, [...(producers.get(o) ?? []), id]);
  const reaches = (from, to) => {
    const seenUp = new Set();
    const st = [from];
    while (st.length) {
      const cur = st.pop();
      if (cur === to) return true;
      if (seenUp.has(cur)) continue;
      seenUp.add(cur);
      for (const t of out.get(cur) ?? []) st.push(t);
    }
    return false;
  };
  for (const n of nodes) {
    const doc = contracts.get(n.id);
    if (!doc) continue;
    const passed = new Set(Object.keys(n.with ?? {}));
    for (const [input, spec] of Object.entries(doc.inputs ?? {})) {
      if (spec?.required === false || passed.has(input)) continue;
      const upstream = (producers.get(input) ?? []).filter((p) => p !== n.id && reaches(p, n.id));
      if (upstream.length) continue;
      errors.push(code('E_UNBOUND_INPUT', { path: `${file}#${n.id}.${input}`, ids: [n.id], fix: { input, slotOf: n.uses, reason: 'not_passed_by_with', candidates: [] } }));
    }
  }
  // A `with` value that binds an upstream output ({{node.output}}) must match the
  // input's declared type. A mismatch names both ends in ids[]; the fix carries
  // the two declarations so "same name, different type" reads as what it is.
  for (const n of nodes) {
    const doc = contracts.get(n.id);
    if (!doc) continue;
    for (const [input, value] of Object.entries(n.with ?? {})) {
      const ref = /^\{\{\s*([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\s*\}\}$/.exec(String(value));
      if (!ref) continue;
      const src = contracts.get(ref[1]);
      if (!src || !reaches(ref[1], n.id)) continue;
      const declared = src.outputs?.[ref[2]];
      const slot = doc.inputs?.[input];
      if (!declared || !slot) continue;
      if (declared.type !== undefined && slot.type !== undefined && declared.type !== slot.type) {
        errors.push(code('E_CONTRACT_MISMATCH', { path: `${file}#${n.id}.${input}`, ids: [ref[1], n.id], fix: { from: { nodeId: ref[1], output: ref[2], type: declared.type }, to: { nodeId: n.id, input, type: slot.type }, expected: slot.type, actual: declared.type } }));
      }
    }
  }
  return dedupe(errors);
}

function checkName(c) {
  if (typeof c === 'string') return c;
  // A check names its checker by `artifact` (a file under checks/) or by `name`;
  // `run` is a shell command, not a reference, so it is never looked up here.
  const raw = c?.artifact ?? c?.id ?? c?.name ?? null;
  if (typeof raw !== 'string') return null;
  const m = /(?:^|\s|\/)([A-Za-z0-9_.-]+)\.(?:m?js|cjs|sh|py|bash)\b/.exec(raw) ?? /\bchecks\/([A-Za-z0-9_.-]+)\b/.exec(raw);
  return m ? m[1].replace(/\.(?:m?js|cjs|sh|py|bash)$/, '') : raw;
}

// The project files a flow points at: blocks/, checks/, agents/.
class Project {
  constructor(dir) {
    this.dir = path.resolve(dir);
  }
  block(ref) {
    const m = /^block:([a-z][a-z0-9-]*)@([0-9]+)$/.exec(String(ref ?? ''));
    if (!m) return { kind: 'ref', ref };
    const rel = path.join('blocks', m[1], `v${m[2]}.yaml`);
    const abs = path.join(this.dir, rel);
    if (!fs.existsSync(abs)) return { kind: 'missing', abs, rel };
    try {
      const doc = parseYaml(fs.readFileSync(abs, 'utf8'), abs);
      if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { kind: 'broken', abs, rel, reason: 'block document must be a mapping' };
      if (doc.checks !== undefined && !Array.isArray(doc.checks)) return { kind: 'broken', abs, rel, reason: 'block `checks` must be a list' };
      return { ok: true, doc, abs, rel };
    } catch (e) {
      return { kind: 'broken', abs, rel, reason: e.message, line: e.line };
    }
  }
  schemaError(b) {
    if (!b || b.ok || (b.kind !== 'broken')) return null;
    const rel = path.relative(process.cwd(), b.abs);
    return code('E_SCHEMA_INVALID', { locatable: false, path: `${rel}${b.line ? ':' + b.line : ''}`, fix: { action: 'fix-syntax', detail: b.reason } });
  }
  availableBlocks() {
    const root = path.join(this.dir, 'blocks');
    if (!fs.existsSync(root)) return [];
    const out = [];
    for (const id of fs.readdirSync(root)) {
      const dir = path.join(root, id);
      if (!fs.statSync(dir).isDirectory()) continue;
      for (const f of fs.readdirSync(dir)) {
        const m = /^v(\d+)\.yaml$/.exec(f);
        if (m) out.push(`block:${id}@${m[1]}`);
      }
    }
    return out.sort();
  }
  checkerNames() {
    const root = path.join(this.dir, 'checks');
    if (!fs.existsSync(root)) return [];
    return fs.readdirSync(root).filter((f) => /\.(m?js|cjs|sh|py|bash)$/.test(f)).map((f) => f.replace(/\.(m?js|cjs|sh|py|bash)$/, '')).sort();
  }
  checkerExists(name) {
    return this.checkerNames().includes(name);
  }
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
