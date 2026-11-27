import { createHash } from 'node:crypto';
import { canonicalJson } from './canonical.js';

export function sha256Hex(input) {
  return createHash('sha256').update(input).digest('hex');
}

export function eventHash(prev, eventWithoutHash) {
  return 'sha256:' + sha256Hex(prev + canonicalJson(eventWithoutHash));
}

export const GENESIS_PREV = 'sha256:' + '0'.repeat(64);

// Serialise one event exactly as it is written to events.jsonl.
export function serializeEvent(event) {
  return JSON.stringify(event);
}

export function sealEvent(eventWithoutHash) {
  const prev = eventWithoutHash.prev;
  const hash = eventHash(prev, eventWithoutHash);
  return { ...eventWithoutHash, hash };
}
