// fixtures/expected-codes.tsv is a PROJECTION of docs/error-codes.md:
//
//   # source: agentforge-v2.md §A3.3
//   # doc-only: <CODE> [<CODE> ...]     (a rule code with no P0 fixture)
//   <fixture>.yaml<TAB><CODE>          (one row per fixture/code pair)
//
// A fixture may appear on several rows (missing-exit is E_MISSING_EXIT +
// E_CYCLE in a finite P0 graph; 员工一号 5928fe89), so it is read as
// fixture -> Set(codes), never fixture -> one code.
import fs from 'node:fs';

export class TsvError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TsvError';
  }
}

const HEADER = /^#\s*source:\s*agentforge-v2\.md\s*§A3\.3\s*$/;

export function parseTsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) throw new TsvError('ERRTSV_EMPTY: expected-codes.tsv is empty');
  if (!HEADER.test(lines[0])) throw new TsvError(`ERRTSV_HEADER: first line must be "# source: agentforge-v2.md §A3.3", got ${JSON.stringify(lines[0])}`);
  const byFixture = new Map();
  const docOnly = new Set();
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    const doc = /^#\s*doc-only:\s*(.*)$/.exec(line);
    if (doc) {
      for (const code of doc[1].split(/[\s,]+/).filter(Boolean)) {
        if (!/^E_[A-Z0-9_]+$/.test(code)) throw new TsvError(`ERRTSV_DOC_ONLY: line ${i + 1}: ${code} is not an error code`);
        docOnly.add(code);
      }
      continue;
    }
    if (line.startsWith('#')) continue;
    const cols = line.split('\t');
    if (cols.length !== 2) throw new TsvError(`ERRTSV_COLUMNS: line ${i + 1} has ${cols.length} columns, expected 2 (fixture<TAB>code)`);
    const [fixture, code] = cols.map((c) => c.trim());
    if (!fixture || !/^E_[A-Z0-9_]+$/.test(code)) throw new TsvError(`ERRTSV_ROW: line ${i + 1} is not "<fixture>\\t<E_CODE>"`);
    const set = byFixture.get(fixture) ?? new Set();
    if (set.has(code)) throw new TsvError(`ERRTSV_DUP: line ${i + 1}: ${fixture} ${code} listed twice`);
    set.add(code);
    byFixture.set(fixture, set);
  }
  return { byFixture, docOnly };
}

export const loadTsv = (file) => parseTsv(fs.readFileSync(file, 'utf8'));

// Both directions, against the md table. An empty list means "agree".
//
// Two shapes are legitimate and must not be reported:
//   - a fixture on several rows (missing-exit: E_MISSING_EXIT + E_CYCLE);
//   - a placeholder fixture in the md ("p0-unsupported-<field>.yaml"), which
//     stands for every file with that prefix.
const placeholderMatches = (pattern, fixture) => pattern.includes('<') && fixture.startsWith(pattern.split('<')[0]);

// The notes are the md text that is not part of the code table: they explain a
// `—` cell and say which extra codes a fixture also carries (missing-exit's
// "{E_MISSING_EXIT, E_CYCLE}, which is what the tsv registers").
// The whole md text is the notes: a note sentence can mention a code table
// (the "| code |" header row) inside its own paragraph, so cutting lines that
// start with "|" would also cut the sentence.
const notesOf = (mdText) => mdText;

function notesBackPair(notes, fixture, code) {
  // One note bullet must name both this fixture and this code.
  return notes
    .split(/\n(?=- )/)
    .some((bullet) => bullet.includes(`fixtures/${fixture}`) && (code === '.' || new RegExp(`\\b${code}\\b`).test(bullet)));
}

export function crossCheck(byCode, byFixture, tsv, { notes = '' } = {}) {
  const problems = [];
  // A placeholder in the md ("p0-unsupported-<field>.yaml") stands for files.
  const placeholderMatches = (pattern, fixture) => pattern.includes('<') && fixture.startsWith(pattern.split('<')[0]);
  const codeBoundTo = (e, fixture) => e.fixtures.some((f) => f === fixture || placeholderMatches(f, fixture));
  // A fixture is named by the md when any code's column or any note bullet names it.
  const mdNames = (fixture) =>
    [...byCode.values()].some((e) => e.fixtures.some((f) => f === fixture || placeholderMatches(f, fixture))) ||
    notes.includes(`fixtures/${fixture}`);
  const fixtureNamed = (fixture, code) => {
    const e = byCode.get(code);
    return Boolean(e) && (codeBoundTo(e, fixture) || notesBackPair(notes, fixture, code));
  };
  // md -> tsv, by code: each fixture a rule code names must be listed under it.
  for (const [code, e] of byCode) {
    if (e.klass !== 'rule') continue;
    for (const fixture of e.fixtures) {
      const files = fixture.includes('<')
        ? [...tsv.byFixture.keys()].filter((f) => placeholderMatches(fixture, f))
        : [fixture];
      for (const file of files) {
        const listed = tsv.byFixture.get(file);
        if (!listed) problems.push(`in md, missing from tsv: ${file} -> ${code}`);
        else if (!listed.has(code)) problems.push(`code differs: ${file} md=${code} tsv=${[...listed].join(',')}`);
      }
      if (fixture.includes('<') && !files.length) problems.push(`in md, placeholder with no tsv file: ${fixture} -> ${code}`);
    }
  }
  // tsv -> md: every listed pair is backed by that code's column or by a note
  // bullet that names both the fixture and the code.
  for (const [fixture, codes] of tsv.byFixture) {
    for (const code of codes) {
      if (!byCode.has(code)) problems.push(`tsv code not in md: ${fixture} -> ${code}`);
      else if (!fixtureNamed(fixture, code)) problems.push(`tsv fixture not bound to ${code} in md: ${fixture}`);
    }
    if (!mdNames(fixture)) problems.push(`tsv fixture is named nowhere in the md: ${fixture}`);
  }
  // doc-only: every rule code the md binds to no fixture must say so, and a
  // "# doc-only:" line must not name a code that does have fixtures.
  for (const [code, e] of byCode) {
    if (e.klass !== 'rule' || !e.docOnly) continue;
    if (!tsv.docOnly.has(code)) problems.push(`rule code without a P0 fixture must be declared "# doc-only:" in tsv: ${code}`);
  }
  for (const code of tsv.docOnly) {
    const e = byCode.get(code);
    if (!e) problems.push(`# doc-only names ${code}, which is not in the md table`);
    else if (!e.docOnly) problems.push(`# doc-only names ${code}, but the md binds it to ${e.fixtures.join(', ')}`);
  }
  return problems;
}

export { notesOf };
