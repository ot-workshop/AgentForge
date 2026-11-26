// Tiny YAML subset parser: enough for the sample .forge/ project.
// Supports: mappings, lists, nested indentation, quoted/plain scalars,
// inline flow arrays/objects, comments, and multi-line block skipped.
// Anything outside the subset throws E_SCHEMA_INVALID at the caller.
export function parseYaml(text, file = '') {
  const lines = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\t/g, '  ');
    const stripped = line.replace(/(^|\s)#.*$/, '');
    if (!stripped.trim()) continue;
    lines.push({ indent: stripped.length - stripped.trimStart().length, text: stripped.trim(), line: stripped });
  }
  let i = 0;
  function parseBlock(indent) {
    if (i >= lines.length) return null;
    if (lines[i].text.startsWith('- ')) return parseList(indent);
    return parseMap(indent);
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
        if (value) obj[kv[1]] = parseScalar(value);
        else obj[kv[1]] = i < lines.length && lines[i].indent > indent ? parseBlock(lines[i].indent) : null;
        // subsequent keys of the same list item
        while (i < lines.length && lines[i].indent > indent && !lines[i].text.startsWith('- ')) {
          const m = lines[i].text.match(/^([A-Za-z0-9_$.-]+):\s*(.*)$/);
          if (!m) break;
          i++;
          obj[m[1]] = m[2].trim() ? parseScalar(m[2].trim()) : i < lines.length && lines[i].indent > indent ? parseBlock(lines[i].indent) : null;
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
      if (!m) throw new Error(`cannot parse line: ${lines[i].line}`);
      const key = m[1];
      const value = m[2].trim();
      i++;
      if (value) obj[key] = parseScalar(value);
      else if (i < lines.length && (lines[i].indent > indent || (lines[i].indent === indent && lines[i].text.startsWith('- ')))) {
        obj[key] = parseBlock(lines[i].indent);
      } else obj[key] = null;
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
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
  if (v.startsWith('[') || v.startsWith('{')) return parseFlow(v);
  return v;
}

function parseFlow(v) {
  // convert a YAML flow value into a JS object without regex quoting games
  const chars = [...v];
  let i = 0;
  const ws = () => {
    while (chars[i] === ' ' || chars[i] === '\n') i++;
  };
  const parseValue = () => {
    ws();
    const c = chars[i];
    if (c === '[') {
      i++;
      const arr = [];
      ws();
      if (chars[i] === ']') { i++; return arr; }
      for (;;) {
        arr.push(parseValue());
        ws();
        if (chars[i] === ',') { i++; continue; }
        if (chars[i] === ']') { i++; return arr; }
        throw new Error('bad flow array');
      }
    }
    if (c === '{') {
      i++;
      const obj = {};
      ws();
      if (chars[i] === '}') { i++; return obj; }
      for (;;) {
        ws();
        const key = parseScalarRaw();
        ws();
        if (chars[i] !== ':') throw new Error('bad flow map');
        i++;
        obj[key] = parseValue();
        ws();
        if (chars[i] === ',') { i++; continue; }
        if (chars[i] === '}') { i++; return obj; }
        throw new Error('bad flow map');
      }
    }
    if (c === '"' || c === "'") {
      const q = c;
      i++;
      let out = '';
      while (i < chars.length && chars[i] !== q) { out += chars[i++]; }
      i++;
      return out;
    }
    return parseScalarRaw();
  };
  const parseScalarRaw = () => {
    ws();
    let out = '';
    while (i < chars.length && ![':', ',', '}', ']'].includes(chars[i])) out += chars[i++];
    return parseScalar(out.trim());
  };
  const out = parseValue();
  if (typeof out === 'object') return out;
  return out;
}
