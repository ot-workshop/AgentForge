// Drift detection (A7.2): compare what a run's manifest recorded with the
// files on disk. Replay never calls this; it only reads events + manifest.
import fs from 'node:fs';
import path from 'node:path';
import { sha256Hex } from './chain.js';
import { structuredError } from './errors.js';

export function currentBlockSha(rootDir, blockId, version) {
  const f = path.join(rootDir, '.forge', 'blocks', blockId, `v${version}.yaml`);
  return fs.existsSync(f) ? sha256Hex(fs.readFileSync(f)) : null;
}

export function currentBlockShaFromBlocksDir(blocksRoot, blockId, version) {
  const f = path.join(blocksRoot, blockId, `v${version}.yaml`);
  return fs.existsSync(f) ? sha256Hex(fs.readFileSync(f)) : null;
}

export function checkRefs({ rootDir, runId }) {
  const runDir = path.join(rootDir, '.forge', 'runs', String(runId));
  const manifestFile = path.join(runDir, 'manifest.json');
  if (!fs.existsSync(manifestFile)) {
    return {
      ok: false,
      errors: [
        structuredError({
          code: 'E_UNKNOWN_REF',
          severity: 'block',
          locatable: false,
          path: `runs/${runId}/manifest.json`,
          ids: [`run:${runId}`],
          fix: { ref: String(runId), refKind: 'manifest', available: [] },
        }),
      ],
      drifts: [],
    };
  }
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const blocksRoot = path.join(path.dirname(manifest.flow?.path ?? path.join(rootDir, 'flows', '_')), '..', 'blocks');
  const drifts = [];
  const errors = [];
  for (const [nodeId, rec] of Object.entries(manifest.blocks ?? {})) {
    const m = /^block:([a-z][a-z0-9-]*)@([0-9]+)$/.exec(rec.ref ?? '');
    if (!m) continue;
    const actual = currentBlockShaFromBlocksDir(blocksRoot, m[1], m[2]);
    if (actual !== rec.sha256) {
      drifts.push({ nodeId, ref: rec.ref, recordedSha256: rec.sha256, actualSha256: actual });
      errors.push(
        structuredError({
          code: 'E_BLOCK_CONTENT_DRIFT',
          severity: 'block',
          locatable: false,
          path: `blocks/${m[1]}/v${m[2]}.yaml`,
          ids: [`block:${m[1]}@${m[2]}`],
          fix: { action: 'review the edit, then rerun with --allow-drift or restore the recorded content', recordedSha256: rec.sha256, actualSha256: actual },
        }),
      );
    }
  }
  if (manifest.flow?.sha256) {
    const f = manifest.flow.path;
    const actual = f && fs.existsSync(f) ? sha256Hex(fs.readFileSync(f)) : null;
    if (actual !== manifest.flow.sha256) {
      drifts.push({ flow: f, recordedSha256: manifest.flow.sha256, actualSha256: actual });
      errors.push(
        structuredError({
          code: 'E_FLOW_CONTENT_DRIFT',
          severity: 'block',
          locatable: false,
          path: f ?? 'flow',
          ids: [],
          fix: { action: 'review the edit, then rerun with --allow-drift or restore the recorded content', recordedSha256: manifest.flow.sha256, actualSha256: actual },
        }),
      );
    }
  }
  return { ok: errors.length === 0, errors, drifts };
}
