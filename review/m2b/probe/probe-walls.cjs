// Probe for docs/runtime-binding.md §4.3: what a stage process can touch on this machine.
// Inputs: FORGE_REPO (repo copy), FORGE_EVENTS / FORGE_CHECKS_FILE (paths inside a temp dir).
const fs = require('fs');
const m = [];
const t = (label, fn) => { try { fn(); m.push(label + ': allowed'); } catch (e) { m.push(label + ': ' + e.code); } };
t('read file in own cwd', () => fs.readFileSync('plan.md'));
t('read .forge/runs/*/events.jsonl', () => fs.readFileSync(process.env.FORGE_EVENTS));
t('append .forge/runs/*/events.jsonl', () => fs.appendFileSync(process.env.FORGE_EVENTS, '{}\n'));
t('read/write repo root flows/', () => fs.writeFileSync(process.env.FORGE_REPO + '/flows/probe.yaml', 'x'));
t('rewrite checks.lock identically (sha256 stays the same)', () => fs.copyFileSync(process.env.FORGE_CHECKS_FILE, process.env.FORGE_CHECKS_FILE));
t('write checks.lock', () => fs.writeFileSync(process.env.FORGE_CHECKS_FILE, 'tampered'));
t('read a block body through a shell tool', () => require('child_process').execSync('cat ' + process.env.FORGE_REPO + '/blocks/design/v1.yaml'));
console.log(m.join('\n'));
