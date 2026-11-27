// Structured error objects. Every error surfaced by validate / run /
// verify-chain carries exactly these six keys (v2.4 §2.3 码表总则).
export function structuredError({ code, severity, locatable, path, ids, fix }) {
  return {
    code,
    severity,
    locatable,
    path,
    ids: ids ?? [],
    fix: fix === undefined ? null : fix,
  };
}

export class ForgeError extends Error {
  constructor(errors, exitCode = 1) {
    const list = Array.isArray(errors) ? errors : [errors];
    super(list.map((e) => `${e.code}${e.path ? ' at ' + e.path : ''}`).join('; '));
    this.errors = list;
    this.exitCode = exitCode;
  }
}

export function isStructuredError(e) {
  const keys = ['code', 'severity', 'locatable', 'path', 'ids', 'fix'];
  return !!e && typeof e === 'object' && keys.every((k) => Object.prototype.hasOwnProperty.call(e, k));
}
