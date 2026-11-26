#!/usr/bin/env node
// Dry-run validator + code-table unit tests (M1-B, #流水线:#4).
//
//   node tools/validate/index.js --check-tsv <expected-codes.tsv> --codes <error-codes.md> [--json]
//   node tools/validate/index.js fixtures/<name>.yaml --project <root> --codes <error-codes.md> [--json]
//
// Three layers, and only these:
//   1. table  -- docs/error-codes.md is the only source of truth (lib/table.js)
//   2. tsv    -- fixtures/expected-codes.tsv is its projection, checked both ways (lib/tsv.js)
//   3. flow   -- the verdict for one fixture is the repository's src/validate.js
//                called with an explicit projectDir (lib/delegate.js); no rule
//                is implemented here, so two tools can never report two answers.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTable, indexByCode, indexByFixture, TableError } from './lib/table.js';
import { loadTsv, crossCheck, TsvError, notesOf } from './lib/tsv.js';
import { loadRepo, judgeFlow, codeSet, ToolError } from './lib/delegate.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, '..', '..');

const USAGE = `usage: forge-validate <fixture.yaml> --project <root> [--codes <error-codes.md>] [--json]
                     --check-tsv <expected-codes.tsv> [--codes <error-codes.md>] [--json]

The per-flow verdict is the repository's src/validate.js (explicit --project,
required). --check-tsv compares docs/error-codes.md with the tsv both ways.
exit 0 agree / no block errors, 1 divergence / block errors, 2 usage or table/tsv defect
`;

function usage(msg) {
  process.stderr.write(`forge-validate: tool error: ${msg}\n`);
  return 2;
}

async function main(argv) {
  const opts = { _: [], json: false, codes: null, checkTsv: null, project: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--codes') opts.codes = argv[++i];
    else if (a === '--check-tsv') opts.checkTsv = argv[++i];
    else if (a === '--project') opts.project = argv[++i];
    else if (a.startsWith('-')) return usage(`unknown option ${a}`);
    else opts._.push(a);
  }
  // --check-tsv's value may come positionally ("--check-tsv <file>" or "<file> --check-tsv")
  // A bare tsv argument is read as --check-tsv only when it is the ONLY argument:
  // otherwise it is a flow path or a usage error, never silently reinterpreted.
  if (opts.checkTsv === undefined && opts._.length === 1 && /expected-codes\.tsv$/.test(opts._[0])) opts.checkTsv = opts._.shift();
  if (opts.checkTsv === '') return usage('--check-tsv needs a file path');
  if (opts.codes === '') return usage('--codes needs a file path');
  if (opts.project === '') return usage('--project needs a directory');
  const codesPath = path.resolve(opts.codes ?? path.join(PKG, 'docs', 'error-codes.md'));
  if (!fs.existsSync(codesPath)) return usage(`code table not found: ${codesPath}`);
  let rows;
  try {
    rows = loadTable(codesPath);
  } catch (e) {
    if (e instanceof TableError) return usage(e.message);
    throw e;
  }
  const byCode = indexByCode(rows);
  const byFixture = indexByFixture(rows);

  if (opts.checkTsv) {
    const tsvPath = path.resolve(opts.checkTsv);
    if (!fs.existsSync(tsvPath)) return usage(`tsv not found: ${tsvPath}`);
    let tsv;
    try {
      tsv = loadTsv(tsvPath);
    } catch (e) {
      if (e instanceof TsvError) return usage(e.message);
      throw e;
    }
    const problems = crossCheck(byCode, byFixture, tsv, { notes: notesOf(fs.readFileSync(codesPath, 'utf8')) });
    const out = { codes: byCode.size, fixtures: byFixture.size, tsvRows: tsv.byFixture.size, docOnly: [...tsv.docOnly].sort(), problems };
    if (opts.json) process.stdout.write(JSON.stringify(out) + '\n');
    else if (problems.length) process.stdout.write(problems.join('\n') + `\n${problems.length} divergence(s)\n`);
    else process.stdout.write(`table and tsv agree: ${byCode.size} codes, ${byFixture.size} fixtures, ${tsv.byFixture.size} tsv rows, doc-only ${[...tsv.docOnly].sort().join(',') || '-'}\n`);
    return problems.length ? 1 : 0;
  }

  const flow = opts._[0];
  if (!flow) return usage('validate <fixture.yaml> --project <root>  |  --check-tsv <expected-codes.tsv>');
  try {
    const repo = await loadRepo(process.env.AF_REPO_SRC ? path.resolve(process.env.AF_REPO_SRC) : path.join(PKG, 'src'));
    const { errors } = await judgeFlow(repo, flow, { projectDir: opts.project });
    if (opts.json) process.stdout.write(JSON.stringify({ errors }) + '\n');
    else process.stdout.write(errors.length ? errors.map((e) => `${e.code} ${e.path}`).join('\n') + '\n' : '{}\n');
    return errors.some((e) => e.severity === 'block') ? 1 : 0;
  } catch (e) {
    if (e instanceof ToolError) return usage(e.message);
    throw e;
  }
}

main(process.argv.slice(2)).then((code) => process.exit(code), (e) => {
  process.stderr.write(`forge-validate: ${e.message}\n`);
  process.exit(2);
});
export { codeSet };
