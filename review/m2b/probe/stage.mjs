// Probe for docs/runtime-binding.md §4.1: an agent stage that leaves a detached child behind.
// argv = [node, stage.mjs, file-to-append-to-later]; prints one legal Submit and returns.
import fs from 'node:fs';
import { spawn } from 'node:child_process';
const target = process.argv[2];
spawn(process.execPath, ['-e', 'setTimeout(()=>{require("fs").appendFileSync(process.argv[1],"{\\"seq\\":999}\\n")},600)', target], { detached: true, stdio: 'ignore' }).unref();
fs.writeFileSync(target, '{"seq":1}\n', { flag: 'a' });
console.log(JSON.stringify({ v: 1, status: 'ok', artifacts: [], summary: 'trivial plan (no tools used)', evidence: [{ check: 'probe', cmd: 'write plan', exit: 0 }] }));
