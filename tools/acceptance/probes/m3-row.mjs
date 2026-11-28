#!/usr/bin/env node
// Run the M3 row alone on the checkout given as argv[2], and print JSON:
//   {"status": "pass"|"fail", "starts": [...]}   (starts = the run's stage.start keys)
// It loads the suite from AF_ACCEPTANCE_DIR, so a red run against a copy of the
// checkout never picks up the copy's own suite (员工五号 ddfa6570 / #12).
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repo = path.resolve(process.argv[2] ?? '.');
const suiteDir = process.env.AF_ACCEPTANCE_DIR ? path.resolve(process.env.AF_ACCEPTANCE_DIR) : null;
if (!suiteDir) {
  process.stdout.write(JSON.stringify({ status: 'fail', error: 'AF_ACCEPTANCE_DIR is required' }) + '\n');
  process.exit(0);
}
const criteria = await import(pathToFileURL(path.join(suiteDir, 'lib', 'criteria.js')).href);
const { m3_entryCount } = criteria;
let row;
try {
  row = m3_entryCount(repo, { reds: false });
} catch (e) {
  process.stdout.write(JSON.stringify({ status: 'fail', error: String(e?.message ?? e) }) + '\n');
  process.exit(0);
}
process.stdout.write(JSON.stringify({ status: row.status, starts: criteria.__m3.lastStarts ?? null, raw: row.raw }) + '\n');
