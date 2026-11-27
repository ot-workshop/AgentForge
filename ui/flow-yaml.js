// Flow model <-> the YAML subset `src/yamlish.js` parses.
// The model keeps every flow key it read so that open -> export does not drop
// anything the validator knows about. Unknown keys are carried through as-is.

const ORDER = ['id', 'version', 'entry'];
const EDGE_ORDER = ['id', 'from', 'to', 'on', 'max_iterations', 'on_exhausted'];

export function emptyFlow() {
  return { id: 'canvas', nodes: [], edges: [], extra: {}, layout: {} };
}

export function parseFlow(text) {
  const doc = parseSubset(text);
  if (Array.isArray(doc) || doc == null || typeof doc !== 'object') {
    throw new Error('顶层必须是映射（nodes/edges），或至少含 nodes 列表');
  }
  const flow = emptyFlow();
  const known = new Set(['nodes', 'edges']);
  for (const k of Object.keys(doc)) {
    if (known.has(k)) continue;
    if (ORDER.includes(k)) flow[k] = doc[k];
    else flow.extra[k] = doc[k];
  }
  // `nodes:` with no entries produces null: keep `nodes: []` on export.
  const nodes = Array.isArray(doc.nodes) ? doc.nodes : [];
  const edges = Array.isArray(doc.edges) ? doc.edges : [];
  flow.edgesWasExplicit = Array.isArray(doc.edges);
  flow.nodes = nodes.map((n) => ({
    id: String(n?.id ?? ''),
    uses: n?.uses == null ? '' : String(n.uses),
    with: n?.with ?? {},
    extra: extraKeys(n, ['id', 'uses', 'with']),
    ui: pickUi(n),
  }));
  flow.edges = edges.map((e) => ({
    id: e?.id == null ? null : String(e.id),
    from: e?.from == null ? '' : String(e.from),
    to: e?.to == null ? '' : String(e.to),
    ...restEdge(e),
  }));
  return flow;
}

function extraKeys(obj, known) {
  const out = {};
  for (const k of Object.keys(obj ?? {})) if (!known.includes(k)) out[k] = obj[k];
  return out;
}

function restEdge(e) {
  const out = {};
  for (const k of Object.keys(e ?? {})) if (!['id', 'from', 'to', 'ui'].includes(k)) out[k] = e[k];
  return out;
}

function pickUi(n) {
  const ui = n?.ui;
  if (ui && Number.isFinite(ui.x) && Number.isFinite(ui.y)) return { x: ui.x, y: ui.y };
  return null;
}

export function exportFlow(flow) {
  const out = [];
  for (const k of ORDER) if (flow[k] !== undefined && flow[k] !== null) out.push(`${k}: ${scalar(flow[k])}`);
  for (const k of Object.keys(flow.extra)) {
    if (isBlockValue(flow.extra[k])) out.push(...blockField(k, flow.extra[k]));
    else out.push(`${keyLine(k, flow.extra[k])}`);
  }
  out.push('nodes:' + (flow.nodes.length ? '' : ' []'));
  for (const n of flow.nodes) {
    const first = [];
    if (n.id) first.push(`id: ${scalar(n.id)}`);
    if (n.uses) first.push(`uses: ${scalar(n.uses)}`);
    out.push(`  - ${first.length ? first.join('\n    ') : '{}'}`);
    if (isMapping(n.with) && Object.keys(n.with).length) out.push(...blockField('    with', n.with));
    for (const [k, v] of Object.entries(n.extra ?? {})) {
      if (isBlockValue(v)) out.push(...blockField(`    ${k}`, v));
      else out.push(`    ${keyLine(k, v)}`);
    }
    if (n.ui) out.push(`    ui: {x: ${num(n.ui.x)}, y: ${num(n.ui.y)}}`);
  }
  // An absent `edges` key stays absent; an explicit `edges: []` stays `[]`.
  if (!flow.edges.length) {
    if (Object.prototype.hasOwnProperty.call(flow, 'edgesWasExplicit') && flow.edgesWasExplicit) out.push('edges: []');
  } else out.push('edges:');
  for (const e of flow.edges) {
    // `on:` first, then the other scalars (export order of the sample), then
    // any remaining nested value: a later key still belongs to the list item.
    const keys = Object.keys(e).filter((k) => k !== 'ui');
    const order = ['id', 'from', 'to', 'on', 'max_iterations', 'on_exhausted'];
    keys.sort((x, y) => rank(order, x) - rank(order, y));
    let first = true;
    for (const k of keys) {
      if (e[k] === null || e[k] === undefined) continue;
      if (isBlockValue(e[k])) out.push(...blockField(`${first ? '  - ' : '    '}${k}`, e[k]));
      else out.push(`${first ? '  - ' : '    '}${keyLine(k, e[k])}`);
      first = false;
    }
  }
  return out.join('\n') + '\n';
}

function rank(order, k) {
  const at = order.indexOf(k);
  return at < 0 ? order.length : at;
}

// Only plain mappings with at least one key are emitted as a nested block: an
// empty object is written as `{}` and anything parsed from a non-mapping
// scalar is written back unchanged.
function isMapping(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isBlockValue(v) {
  // A mapping that opens with a list (`on:` style) keeps its first key inline.
  return isMapping(v);
}

function keyLine(k, v) {
  return `${safeKey(k)}:${v === undefined ? ' null' : ' ' + scalar(v)}`;
}

// `  key:` followed by the `sub` block of a mapping/array value; `head` is the
// whole `  - key` / `    key` token, list items included.
function blockField(head, value) {
  const lead = head.match(/^(\s*- +)(.*)$/);
  const pad = lead ? lead[1].length : indentOf(head);
  const lines = subsetLines(value, pad + 2);
  if (!lines.length) return [`${head}: ${isBlockValue(value) ? '{}' : scalar(value)}`];
  return [`${head}:`, ...lines];
}

function indentOf(head) {
  return head.length - head.trimStart().length;
}

function subsetLines(value, indent) {
  const pad = ' '.repeat(indent);
  if (Array.isArray(value)) {
    const out = [];
    for (const item of value) {
      if (isBlockValue(item) || (Array.isArray(item) && item.length)) {
        const ent = entries(item);
        if (!ent.length) continue;
        const [k0, v0] = ent[0];
        const first = [k0, v0];
        out.push(...subsetLines(Object.fromEntries([first]), indent).map((l, idx) => (idx === 0 ? `${pad}- ${l.trimStart()}` : l)));
        out.push(...continuation(ent.slice(1), indent + 2, true));
      } else if (typeof item === 'string' && needsQuote(item)) out.push(`${pad}- "${item.replace(/(["\\])/g, '\\$1')}"`);
      else out.push(`${pad}- ${scalar(item)}`);
    }
    return out;
  }
  return continuation(entries(value), indent, false);
}

function indentLines(lines, n) {
  const pad = ' '.repeat(n);
  return lines.map((l) => pad + l);
}

function entries(value) {
  if (Array.isArray(value)) return value.map((x, idx) => [String(idx), x]);
  return Object.entries(value ?? {});
}

function continuation(ent, indent, afterDash) {
  const pad = ' '.repeat(indent);
  const out = [];
  const structural = [];
  for (const [k, v] of ent) {
    if (isBlockValue(v) || (Array.isArray(v) && v.length)) structural.push([k, v]);
    else if (Array.isArray(v)) out.push(`${pad}${safeKey(k)}: []`);
    else out.push(`${pad}${safeKey(k)}: ${scalar(v)}`);
  }
  for (const [k, v] of structural) {
    if (isBlockValue(v)) {
      out.push(`${pad}${safeKey(k)}:`);
      out.push(...indentLines(continuation(entries(v), 0, false), indent + 2));
    } else {
      out.push(`${pad}${safeKey(k)}:`);
      out.push(...subsetLines(v, indent));
    }
  }
  return out;
}

function safeKey(k) {
  return /^[A-Za-z0-9_$.-]+$/.test(k) ? k : `"${k.replace(/(["\\])/g, '\\$1')}"`;
}

function num(v) {
  return Number.isFinite(v) ? String(Math.round(v * 100) / 100) : '0';
}

function needsQuote(s) {
  return (
    s === '' ||
    /^[\s-]|[\s]$/.test(s) ||
    /^[-?:,\[\]{}#&*!|>'"%@`]/.test(s) ||
    /[:#]\s|\s#/.test(s) ||
    /^(true|false|null|~|-?\d+(\.\d+)?)$/.test(s) ||
    s !== s.trim()
  );
}

function scalar(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  if (typeof v === 'string') {
    if (v === '') return '""';
    if (/^[A-Za-z0-9_$.\-\/{{}}@%+ =:@,]+$/.test(v) && !/^[-?:,\[\]{}#&*!|>'"%@`]/.test(v) && !/[:#]\s|\s#|^\s|\s$|:$/.test(v) && !/^(true|false|null|~|-?\d+(\.\d+)?)$/.test(v)) return v;
    return `"${v.replace(/(["\\])/g, '\\$1')}"`;
  }
  return `"${JSON.stringify(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

// Minimal reader for the same subset `src/yamlish.js` accepts. Kept in sync
// with that parser by test/canvas.test.js (round-trip on every flows/*.yaml).
// Grammar notes that matter for export: the line after `key:` may be a list
// at the same indent as `key`, and a list item's later keys must be indented
// more than the dash.
export function parseSubset(text) {
  const lines = [];
  for (const raw of String(text).split('\n')) {
    const line = raw.replace(/\t/g, '  ');
    const stripped = line.replace(/(^|\s)#.*$/, '');
    if (!stripped.trim()) continue;
    lines.push({ indent: stripped.length - stripped.trimStart().length, text: stripped.trim() });
  }
  let i = 0;
  function parseBlock(indent) {
    if (i >= lines.length) return null;
    if (lines[i].text.startsWith('- ')) return parseList(indent);
    return parseMap(indent);
  }
  function nested(parentIndent) {
    if (i >= lines.length) return null;
    if (lines[i].indent > parentIndent) return parseBlock(lines[i].indent);
    if (lines[i].indent === parentIndent && lines[i].text.startsWith('- ')) return parseList(parentIndent);
    return null;
  }
  function parseList(indent) {
    const arr = [];
    while (i < lines.length && lines[i].indent === indent && lines[i].text.startsWith('- ')) {
      const rest = lines[i].text.slice(2).trim();
      i++;
      if (!rest) {
        arr.push(parseBlock(indent + 2));
        continue;
      }
      const kv = rest.match(/^([A-Za-z0-9_$.-]+):\s*(.*)$/);
      if (kv) {
        const obj = {};
        const value = kv[2].trim();
        obj[kv[1]] = value ? parseScalar(value) : nested(indent);
        while (i < lines.length && lines[i].indent > indent && !lines[i].text.startsWith('- ')) {
          const m = lines[i].text.match(/^([A-Za-z0-9_$.-]+):\s*(.*)$/);
          if (!m) break;
          i++;
          obj[m[1]] = m[2].trim() ? parseScalar(m[2].trim()) : nested(lines[i - 1].indent);
        }
        arr.push(obj);
      } else {
        arr.push(parseScalar(rest));
      }
    }
    return arr;
  }
  function parseMap(indent) {
    const obj = {};
    while (i < lines.length && lines[i].indent === indent && !lines[i].text.startsWith('- ')) {
      const m = lines[i].text.match(/^([A-Za-z0-9_$.-]+):\s*(.*)$/);
      if (!m) throw new Error(`cannot parse line: ${lines[i].text}`);
      const key = m[1];
      const value = m[2].trim();
      i++;
      obj[key] = value ? parseScalar(value) : nested(indent);
    }
    return obj;
  }
  if (!lines.length) return {};
  return parseBlock(lines[0].indent);
}

function parseScalar(v) {
  if (v === 'null' || v === '~') return null;
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+$/.test(v)) return Number(v);
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1).replace(/\\(["\\])/g, '$1');
  if (v.startsWith('[') || v.startsWith('{')) return parseFlowValue(v);
  return v;
}

function parseFlowValue(v) {
  const chars = [...v];
  let i = 0;
  const ws = () => {
    while (i < chars.length && /\s/.test(chars[i])) i++;
  };
  function value() {
    ws();
    if (chars[i] === '[') {
      i++;
      const arr = [];
      ws();
      if (chars[i] === ']') {
        i++;
        return arr;
      }
      for (;;) {
        arr.push(value());
        ws();
        if (chars[i] === ',') {
          i++;
          continue;
        }
        if (chars[i] === ']') {
          i++;
          return arr;
        }
        throw new Error(`bad flow array: ${v}`);
      }
    }
    if (chars[i] === '{') {
      i++;
      const obj = {};
      ws();
      if (chars[i] === '}') {
        i++;
        return obj;
      }
      for (;;) {
        ws();
        let key = '';
        while (i < chars.length && chars[i] !== ':' && chars[i] !== '}') key += chars[i++];
        if (chars[i] !== ':') throw new Error(`bad flow map: ${v}`);
        i++;
        obj[key.trim().replace(/^["']|["']$/g, '')] = value();
        ws();
        if (chars[i] === ',') {
          i++;
          continue;
        }
        if (chars[i] === '}') {
          i++;
          return obj;
        }
        throw new Error(`bad flow map: ${v}`);
      }
    }
    let out = '';
    if (chars[i] === '"' || chars[i] === "'") {
      const q = chars[i++];
      while (i < chars.length && chars[i] !== q) {
        if (chars[i] === '\\' && q === '"') {
          i++;
          out += chars[i++];
          continue;
        }
        out += chars[i++];
      }
      i++;
      return out;
    }
    while (i < chars.length && !/[,\]}]/.test(chars[i])) out += chars[i++];
    const s = out.trim();
    if (s === 'true') return true;
    if (s === 'false') return false;
    if (s === 'null') return null;
    if (/^-?\d+$/.test(s)) return Number(s);
    return s;
  }
  try {
    const v2 = value();
    ws();
    if (i < chars.length) throw new Error(`trailing flow input: ${v}`);
    return v2;
  } catch {
    return v;
  }
}

// Semantic view used by C1: nodes (id/uses/with/extra), edges (all keys except
// presentation), flow keys. JSON-serialisable and order-insensitive.
export function semantics(flow) {
  const canon = (v) => {
    if (Array.isArray(v)) return v.map(canon);
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]));
    return v;
  };
  const head = {};
  for (const k of ORDER) if (flow[k] !== undefined && flow[k] !== null) head[k] = flow[k];
  for (const k of Object.keys(flow.extra)) head[k] = flow.extra[k];
  return canon({
    head,
    nodes: flow.nodes.map((n) => ({ id: n.id, uses: n.uses ?? '', with: n.with ?? {}, ...n.extra })),
    edges: flow.edges.map((e) => {
      const { ui, ...rest } = e;
      return Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== null && v !== undefined));
    }),
  });
}
