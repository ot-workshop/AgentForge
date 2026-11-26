// Exclusive writer guard for a run directory (A5.12).
// Node has no flock(2) binding; the portable equivalent that still fails
// loudly when another writer exists is a directory lock created with mkdir,
// which is atomic on POSIX and on Windows. A stale lock is reported, never
// stolen: stealing would defeat the purpose.
import fs from 'node:fs';
import path from 'node:path';
import { structuredError } from './errors.js';

export const LOCK_NAME = '.events.lock';

export function acquireRunLock(runDir) {
  const lockPath = path.join(runDir, LOCK_NAME);
  try {
    fs.mkdirSync(lockPath);
  } catch (e) {
    if (e.code === 'EEXIST') {
      throw Object.assign(new Error('run is locked by another writer'), {
        errors: [
          structuredError({
            code: 'E_EVENTS_LOCKED',
            severity: 'block',
            locatable: false,
            path: `runs/${path.basename(runDir)}/${LOCK_NAME}`,
            ids: [`run:${path.basename(runDir)}`],
            fix: { action: 'wait-for-writer-then-retry' },
          }),
        ],
        exitCode: 1,
      });
    }
    throw e;
  }
  fs.writeFileSync(
    path.join(lockPath, 'owner.json'),
    JSON.stringify({ pid: process.pid, since: new Date().toISOString() }) + '\n',
  );
  return {
    release() {
      try {
        fs.rmSync(lockPath, { recursive: true, force: true });
      } catch {
        /* best effort: the directory disappears with the process anyway */
      }
    },
  };
}
