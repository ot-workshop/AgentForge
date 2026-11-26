// events.jsonl is the single source of truth (v2.4 §2.1).
// - Only one writer per run holds the file exclusively for the whole run
//   (flock via fs.openSync 'wx' lock file is NOT used: we use an OS advisory
//   lock on a sidecar because Node has no flock binding; see lock.js).
// - A trailing line without "\n" or that does not parse as JSON is a half
//   write and is ignored on read (A5.11).
// - A complete line whose hash does not match the chain is a real defect:
//   reported, never truncated (A5.9).
import fs from 'node:fs';
import path from 'node:path';
import { eventHash, GENESIS_PREV, sealEvent, serializeEvent } from './chain.js';
import { structuredError } from './errors.js';

export function readEvents(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const lines = raw.split('\n');
  const events = [];
  let trailingPartial = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === '') continue;
    try {
      const ev = JSON.parse(line);
      if (ev && typeof ev === 'object') {
        events.push(ev);
        continue;
      }
      throw new Error('not an object');
    } catch {
      // Only the last unterminated line may be a half write; anything in the
      // middle is corruption and must be reported.
      const isLast = i === lines.length - 1 && !raw.endsWith('\n');
      if (isLast) {
        trailingPartial = true;
        continue;
      }
      throw corruption(i + 1, `line ${i + 1} is not valid JSON`);
    }
  }
  return { events, trailingPartial };
}

function corruption(line, detail) {
  return structuredError({
    code: 'E_EVENT_CORRUPT',
    severity: 'block',
    locatable: false,
    path: `events.jsonl#${line}`,
    ids: [],
    fix: { action: 'inspect-manually', detail },
  });
}

// Verify the hash chain and ordering constraints (A5.2/A5.4/A5.5).
export function verifyChain(file) {
  const { events, trailingPartial } = readEvents(file);
  const errors = [];
  let prev = GENESIS_PREV;
  let expectedSeq = 1;
  let firstStageStart = Infinity;
  const drifts = [];
  for (const ev of events) {
    if (ev.seq !== expectedSeq) {
      errors.push(
        structuredError({
          code: 'E_EVENT_SEQ_GAP',
          severity: 'block',
          locatable: false,
          path: `events.jsonl#${expectedSeq}`,
          ids: [`seq:${ev.seq}`],
          fix: { action: 'inspect-run', expectedSeq, actualSeq: ev.seq },
        }),
      );
      break;
    }
    const { hash, ...rest } = ev;
    if (rest.prev !== prev || hash !== eventHash(prev, rest)) {
      errors.push(
        structuredError({
          code: 'E_CHAIN_HASH_MISMATCH',
          severity: 'block',
          locatable: false,
          path: `events.jsonl#${ev.seq}`,
          ids: [`seq:${ev.seq}`],
          fix: { action: 'restore-from-backup-or-investigate', recordedHash: hash },
        }),
      );
      break;
    }
    if (ev.type === 'stage.start' && firstStageStart === Infinity) firstStageStart = ev.seq;
    if (ev.type === 'ref.drift') drifts.push(ev.seq);
    prev = hash;
    expectedSeq++;
  }
  if (drifts.length > 1 || drifts.some((s) => s > firstStageStart)) {
    errors.push(
      structuredError({
        code: 'E_REF_DRIFT_ORDER',
        severity: 'block',
        locatable: false,
        path: `events.jsonl#${drifts[0]}`,
        ids: drifts.map((s) => `seq:${s}`),
        fix: { action: 'ref.drift must be written once, before the first stage.start' },
      }),
    );
  }
  return {
    ok: errors.length === 0,
    errors,
    events,
    trailingPartial,
    lastSeq: events.length ? events[events.length - 1].seq : 0,
  };
}

// Whole-run writer. Holds an exclusive lock on the run directory for its
// entire life (A5.12), appends through one handle, fsyncs before releasing.
export class EventWriter {
  constructor(runDir, prevEvents) {
    this.file = path.join(runDir, 'events.jsonl');
    this.events = prevEvents.slice();
    this.prev = this.events.length
      ? this.events[this.events.length - 1].hash
      : GENESIS_PREV;
    this.nextSeq = this.events.length
      ? this.events[this.events.length - 1].seq + 1
      : 1;
    this.fd = null;
  }

  open() {
    // The lock is acquired by the caller (lock.js) before constructing us.
    this.fd = fs.openSync(this.file, 'a');
    this.repairTrailingPartial();
    return this;
  }

  // Drop a half-written trailing line so the next append starts at a line
  // boundary. Called only while we hold the exclusive lock.
  repairTrailingPartial() {
    const { trailingPartial } = readEvents(this.file);
    if (!trailingPartial) return false;
    const buf = fs.readFileSync(this.file);
    const idx = buf.lastIndexOf(0x0a);
    fs.ftruncateSync(this.fd, idx + 1);
    this.repairedPartial = true;
    return true;
  }

  // Only legal on a freshly created run directory; keeps seq starting at 1.
  resetChain() {
    this.events = [];
    this.prev = GENESIS_PREV;
    this.nextSeq = 1;
  }

  append(fields) {
    const body = {
      v: 1,
      seq: this.nextSeq,
      ts: new Date().toISOString(),
      ...fields,
      prev: this.prev,
    };
    const ev = sealEvent(body);
    fs.writeSync(this.fd, serializeEvent(ev) + '\n');
    this.events.push(ev);
    this.prev = ev.hash;
    this.nextSeq++;
    return ev;
  }

  sync() {
    if (this.fd !== null) fs.fsyncSync(this.fd);
  }

  close() {
    if (this.fd !== null) {
      this.sync();
      fs.closeSync(this.fd);
      this.fd = null;
    }
  }
}
