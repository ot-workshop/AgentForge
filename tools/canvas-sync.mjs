// Regenerates ui/samples.json and ui/blocks.json from the repository, so the
// canvas opens the real sample flows (and can show the real block library)
// even when it is opened as a file:// page with no server.
//   node tools/canvas-sync.mjs
// test/canvas.test.js fails if the committed copies drift from these inputs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanBlocks } from '../src/canvas-api.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function buildSamples() {
  const files = fs.readdirSync(path.join(ROOT, 'flows')).filter((f) => /\.ya?ml$/.test(f)).sort();
  const samples = files.map((f) => {
    const yaml = fs.readFileSync(path.join(ROOT, 'flows', f), 'utf8');
    const id = /^id:\s*(.+)$/m.exec(yaml)?.[1]?.trim() ?? f;
    return { name: `${f}（${id}）`, file: `flows/${f}`, yaml };
  });
  return { samples, note: '这两份是仓库 flows/ 的原文，由 tools/canvas-sync.mjs 生成（test/canvas.test.js 校验它们与仓库文件一致）。' };
}

export function buildBlocks() {
  return scanBlocks(ROOT);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  fs.writeFileSync(path.join(ROOT, 'ui', 'samples.json'), JSON.stringify(buildSamples(), null, 2) + '\n');
  fs.writeFileSync(path.join(ROOT, 'ui', 'blocks.json'), JSON.stringify(buildBlocks(), null, 2) + '\n');
  process.stdout.write('ui/samples.json and ui/blocks.json regenerated\n');
}
