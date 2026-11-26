// `forge append --event-file <jsonl>`: the only write path for an outside
// caller (A5.3). It takes the same exclusive run lock as `forge run` and
// re-seals every appended event onto the existing chain, so a caller cannot
// forge a hash. The event `type` is kept as-is, including unknown types.
import fs from 'node:fs';
import path from 'node:path';
import { EventWriter, readEvents, verifyChain } from './eventlog.js';
import { acquireRunLock } from './lock.js';
import { structuredError } from './errors.js';

export function appendEvents({ rootDir, runId, eventFile }) {
  const runDir = path.join(rootDir, '.forge', 'runs', String(runId));
  if (!fs.existsSync(runDir)) {
    throw {
      errors: [
        structuredError({
          code: 'E_UNKNOWN_REF',
          severity: 'block',
          locatable: false,
          path: `runs/${runId}`,
          ids: [`run:${runId}`],
          fix: { ref: runId, refKind: 'run', available: [] },
        }),
      ],
      exitCode: 1,
    };
  }
  const lines = fs
    .readFileSync(path.resolve(eventFile), 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l, i) => {
      try {
        const o = JSON.parse(l);
        o.__line = i + 1;
        return o;
      } catch {
        return { __bad: i + 1 };
      }
    });
  const lock = acquireRunLock(runDir);
  try {
    const { events } = readEvents(path.join(runDir, 'events.jsonl'));
    const writer = new EventWriter(runDir, events).open();
    try {
      const appended = [];
      for (const raw of lines) {
        if (raw.__bad) {
          throw {
            errors: [
              structuredError({
                code: 'E_SCHEMA_INVALID',
                severity: 'block',
                locatable: false,
                path: `${eventFile}#${raw.__bad}`,
                ids: [],
                fix: { action: 'fix-json', line: raw.__bad },
              }),
            ],
            exitCode: 1,
          };
        }
        const { __line, __bad, hash, prev, seq, v, ...rest } = raw;
        const ev = writer.append({ run_id: String(runId), ...rest });
        appended.push(ev.seq);
      }
      writer.sync();
      return { appended, lastSeq: writer.nextSeq - 1 };
    } finally {
      writer.close();
    }
  } finally {
    lock.release();
  }
}
