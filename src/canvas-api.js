// Canvas prototype backend (M2-A, #流水线:#8): block library scan and the
// /validate passthrough. Both reuse the repository's own validator; this file
// never carries a second copy of a rule.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseYaml } from './yamlish.js';
import { validateP0, validateFlow, findProjectRoot } from './validate.js';
import { structuredError } from './errors.js';

// `validate` is the same function the CLI runs for `forge validate`; it is
// passed in so the UI and the CLI cannot drift apart.
export function validateCanonical(doc, file, projectDir, validate) {
  const p0Errors = validateP0(doc, { file });
  const errors = p0Errors.length ? p0Errors : validateFlow(doc, { file, p0: false, projectDir });
  const block = errors.filter((e) => e.severity === 'block');
  return { errors, exitCode: block.length ? 1 : 0 };
}

export function scanBlocks(projectDir) {
  const root = path.join(projectDir, 'blocks');
  const blocks = [];
  const warnings = [];
  if (!fs.existsSync(root)) return { blocks, warnings };
  for (const id of fs.readdirSync(root).sort()) {
    const dir = path.join(root, id);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir).filter((x) => /^v\d+\.yaml$/.test(x)).sort()) {
      const file = path.join(dir, f);
      try {
        if (!fs.readFileSync(file, 'utf8').trim()) throw new Error('empty block file');
        const spec = parseYaml(fs.readFileSync(file, 'utf8'), file);
        if (!spec || typeof spec !== 'object' || spec.id !== id || `v${spec.version}.yaml` !== f) {
          throw new Error(`block id/version does not match ${id}/${f}`);
        }
        blocks.push({
          ref: `block:${id}@${spec.version}`,
          id,
          version: spec.version,
          agent: spec.agent ?? null,
          inputs: spec.inputs ?? {},
          outputs: spec.outputs ?? {},
          checks: spec.checks ?? [],
          subflow: spec.subflow ?? null,
        });
      } catch (e) {
        warnings.push(`${id}/${f}: ${e.message}`);
      }
    }
  }
  return { blocks, warnings };
}

// Body -> temp file under os.tmpdir() -> the same parse+validate path the CLI
// uses. The temp dir is removed on every exit path; nothing is written under
// the project directory (staff #8, deploy constraint).
// `file` is display-only: it goes into the error objects, never into the
// filesystem path (the temp file always uses a fixed random name).
export function validateText(text, { file, projectDir, validate }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-ui-'));
  try {
    const abs = path.join(dir, 'flow.yaml');
    fs.writeFileSync(abs, text);
    let doc;
    try {
      doc = parseYaml(fs.readFileSync(abs, 'utf8'), file);
    } catch (e) {
      return {
        errors: [
          structuredError({ code: 'E_SCHEMA_INVALID', severity: 'block', locatable: false, path: file, ids: [], fix: { action: 'fix-syntax', detail: e.message } }),
        ],
      };
    }
    return validateCanonical(doc, file, projectDir, validate);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export function defaultProjectDir(cwd = process.cwd()) {
  return findProjectRoot(cwd);
}

export const MAX_VALIDATE_BYTES = 1024 * 1024;

export function readBody(req, max = MAX_VALIDATE_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > max) {
        done = true;
        const e = new Error('payload too large');
        e.code = 'E_TOO_LARGE';
        reject(e);
        req.removeAllListeners('end');
        req.resume();
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (e) => {
      if (done) return;
      done = true;
      reject(e);
    });
  });
}
