// Probe: judge the V1.4 row on one checkout without its reds, in a child process.
// The row's reds re-run it on mutated copies; doing that in-process would let one
// hanging `run` stall the whole suite, so each red calls this file with a timeout.
// usage: node v14-row.mjs <checkout>   (prints the row as JSON)
import fs from 'node:fs';
import path from 'node:path';

// The checkout as given: this file runs from the suite (possibly the original
// repo), while <checkout> is the mutated copy.
const [checkout] = process.argv.slice(2);
if (!checkout) {
  process.stderr.write('usage: node v14-row.mjs <checkout>\n');
  process.exit(2);
}
// The code under judgement is always the SUITE's (`AF_ACCEPTANCE_DIR`, set by the red
// that spawned us); <checkout> only supplies the checkout. Loading `../lib` instead
// would pick the copy that happens to sit in <checkout> -- which for a red is the
// mutated copy, i.e. the same row again, spawning the same reds again.
const { v4_loops } = await import(
  fs.existsSync(path.join(process.env.AF_ACCEPTANCE_DIR ?? '', 'lib', 'criteria.js'))
    ? path.join(process.env.AF_ACCEPTANCE_DIR, 'lib', 'criteria.js')
    : path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'lib', 'criteria.js')
);
process.env.AF_V14_ROW_ONLY = '1';
const r = await v4_loops(path.resolve(checkout), { reds: false });
process.stdout.write(JSON.stringify({ status: r.status, raw: r.raw }) + '\n');
