// docs/error-codes.md is the only source of truth for codes (v2.4 A3.3).
// This module only READS that table; it never names a rule or invents a code.
//
//   | code | severity | locatable | fix | class | fixture |
//
// Columns are found by header name, so a reordered header does not mis-bind.
// The fixture cell is judged one row at a time (员工一号 e6c81847):
//   - `fixtures/<name>.yaml` (or `<name>.yaml` relative to fixtures/) -> binds it
//   - a lone `—`          -> no P0 fixture (the note section explains why)
//   - anything else       -> the table is refused, never guessed (exit 2)
import fs from 'node:fs';

export const HEADER = ['code', 'severity', 'locatable', 'fix', 'class', 'fixture'];
export const CLASSES = new Set(['rule', 'sequence', 'runtime']);
const NO_FIXTURE = /^[\u2014\u2012\u2013-]$/;
const FIXTURE_PATH = /^(?:fixtures\/)?[A-Za-z0-9_.-][^\s`|]*\.yaml$/;

export class TableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TableError';
  }
}

const stripTicks = (cell) => cell.replace(/`/g, '').trim();
const splitRow = (line) =>
  line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

export function parseTable(text) {
  const rows = [];
  let header = null;
  text.split('\n').forEach((line, i) => {
    if (!line.trim().startsWith('|')) return;
    const cells = splitRow(line);
    if (cells.every((c) => /^:?-{2,}:?$/.test(c) || c === '')) return; // separator
    const lower = cells.map((c) => stripTicks(c).toLowerCase());
    if (!header && lower.includes('code') && lower.includes('fixture')) {
      header = lower;
      if (HEADER.some((h) => !lower.includes(h))) {
        throw new TableError(`ERRCODE_TABLE_HEADER: line ${i + 1} needs columns ${HEADER.join(', ')} by name, got ${lower.join(', ')}`);
      }
      return;
    }
    if (!header) return;
    const at = (name) => cells[header.indexOf(name)] ?? '';
    const code = stripTicks(at('code'));
    if (!/^E_[A-Z0-9_]+$/.test(code)) {
      if (/`E_/.test(at('code'))) throw new TableError(`ERRCODE_TABLE_ROW: line ${i + 1} code ${JSON.stringify(at('code'))} is not E_<NAME>`);
      return; // a note table inside the notes section, not the code table
    }
    const severityCell = stripTicks(at('severity'));
    const locatableCell = stripTicks(at('locatable'));
    const classCell = stripTicks(at('class'));
    const fixtureCell = stripTicks(at('fixture'));
    if (!/^(block|warn)(\s*\/\s*(block|warn))?$/.test(severityCell)) {
      throw new TableError(`ERRCODE_TABLE_ROW: line ${i + 1} (${code}) severity ${JSON.stringify(severityCell)}, expected block, warn or "block / warn"`);
    }
    if (!/^true|false$/i.test(locatableCell)) {
      throw new TableError(`ERRCODE_TABLE_ROW: line ${i + 1} (${code}) locatable ${JSON.stringify(locatableCell)}, expected true|false`);
    }
    if (!CLASSES.has(classCell.toLowerCase())) {
      // Missing class is read conservatively as a rule code; a typo is refused.
      throw new TableError(`ERRCODE_TABLE_CLASS: line ${i + 1} (${code}) class ${JSON.stringify(classCell)}, expected rule|sequence|runtime`);
    }
    if (!NO_FIXTURE.test(fixtureCell) && !FIXTURE_PATH.test(fixtureCell)) {
      throw new TableError(
        `ERRCODE_TABLE_FIXTURE: line ${i + 1} (${code}) fixture cell ${JSON.stringify(fixtureCell)} is neither a fixture path nor a lone "—"`
      );
    }
    rows.push({
      line: i + 1,
      code,
      severity: severityCell,
      locatable: /^true/i.test(locatableCell),
      klass: classCell.toLowerCase(),
      // "" = this row binds no fixture
      fixture: NO_FIXTURE.test(fixtureCell) ? '' : fixtureCell.replace(/^fixtures\//, ''),
    });
  });
  if (!header) throw new TableError('ERRCODE_TABLE_HEADER: no "| code | ... | fixture |" header found');
  if (!rows.length) throw new TableError('ERRCODE_TABLE_EMPTY: the code table has no rows');
  return rows;
}

export const loadTable = (file) => parseTable(fs.readFileSync(file, 'utf8'));

// code -> { code, severity[], locatable, klass, fixtures[] , lines[] }
export function indexByCode(rows) {
  const byCode = new Map();
  for (const r of rows) {
    const prev = byCode.get(r.code);
    if (prev && (prev.locatable !== r.locatable || prev.klass !== r.klass)) {
      throw new TableError(`ERRCODE_TABLE_CONFLICT: ${r.code} rows disagree (lines ${prev.lines.join(', ')}, ${r.line})`);
    }
    const e = prev ?? { code: r.code, severity: [], locatable: r.locatable, klass: r.klass, fixtures: [], lines: [], dryRun: false };
    for (const s of r.severity.split('/').map((x) => x.trim())) if (!e.severity.includes(s)) e.severity.push(s);
    if (r.fixture && !e.fixtures.includes(r.fixture)) e.fixtures.push(r.fixture);
    e.lines.push(r.line);
    byCode.set(r.code, e);
  }
  // A code with no fixture on ANY of its rows is doc-only: the tsv must say
  // "# doc-only: <CODE>" instead of listing a fixture for it.
  for (const e of byCode.values()) e.docOnly = e.fixtures.length === 0;
  return byCode;
}

// fixture -> Set(codes): one fixture may legitimately carry several codes.
export function indexByFixture(rows) {
  const byFixture = new Map();
  for (const r of rows) {
    if (!r.fixture) continue;
    const set = byFixture.get(r.fixture) ?? new Set();
    if (set.has(r.code)) throw new TableError(`ERRCODE_TABLE_DUP: line ${r.line} lists ${r.fixture} -> ${r.code} twice`);
    set.add(r.code);
    byFixture.set(r.fixture, set);
  }
  return byFixture;
}
